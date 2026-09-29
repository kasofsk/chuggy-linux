import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  dockerCli,
  dockerDaemon,
  machineAuthConfig,
  machineLogin,
} from "./docker.fixture.mjs";
import { pullArgv } from "./engineArgv.mjs";
import {
  imageRegistryHost,
  registryAuthDocument,
  withRegistryAuth,
} from "./registryAuth.mjs";

/** @param {import("node:test").TestContext} t */
async function runtimeDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "runtime");
}

test("an image's registry is its first component when that names a host, and Docker Hub otherwise", () => {
  assert.deepEqual(
    [
      "registry.chuggy.example/worker@sha256:aa",
      "localhost:5000/chuggy/worker:1",
      "localhost/worker:1",
      "192.0.2.10:30500/worker",
      "registry.example.com/x@sha256:aa",
      "chuggy/worker:1",
      "foo/bar",
      "busybox",
    ].map(imageRegistryHost),
    [
      "registry.chuggy.example",
      "localhost:5000",
      "localhost",
      "192.0.2.10:30500",
      "registry.example.com",
      "docker.io",
      "docker.io",
      "docker.io",
    ],
  );
});

const credential = { host: "registry.chuggy.example", token: "pool-token" };

test("the credential is the pool's token under the pool's user, for that host alone, and a pull without one names no host", () => {
  for (const engine of /** @type {const} */ (["docker", "podman"])) {
    const document = JSON.parse(registryAuthDocument(engine, credential));
    assert.deepEqual(Object.keys(document), ["auths"]);
    assert.deepEqual(Object.keys(document.auths), ["registry.chuggy.example"]);
    assert.equal(
      Buffer.from(
        document.auths["registry.chuggy.example"].auth,
        "base64",
      ).toString("utf8"),
      "chuggy-pool:pool-token",
    );
  }
  assert.deepEqual(JSON.parse(registryAuthDocument("podman", undefined)), {
    auths: {},
  });
  assert.deepEqual(JSON.parse(registryAuthDocument("docker", undefined)), {
    auths: {},
    credHelpers: { "chuggy.invalid": "" },
  });
});

test("docker's own CLI presents the pool's token to the pool's registry, and no login of the machine's anywhere", async (t) => {
  const docker = await dockerCli();
  if (docker === undefined) {
    t.skip("docker's CLI is not installed");
    return;
  }
  const daemon = await dockerDaemon(t);
  const runtime = await runtimeDir(t);
  /** @type {Array<[string, typeof credential | undefined]>} */
  const pulls = [
    [`registry.chuggy.example/worker@sha256:${"a".repeat(64)}`, credential],
    ["ghcr.io/someone/private:1", undefined],
    ["busybox:1", undefined],
  ];
  for (const withPass of [false, true])
    for (const [image, pulledWith] of pulls) {
      const answer = await withRegistryAuth(
        runtime,
        "docker",
        pulledWith,
        (directory) => {
          const pull = pullArgv("docker", image, directory, daemon.host);
          return docker.exec(pull.argv, {
            environment: {
              DOCKER_AUTH_CONFIG: machineAuthConfig,
              ...pull.environment,
              PATH: daemon.path(withPass),
            },
          });
        },
      );
      assert.equal(answer.code, 0, answer.stderr);
    }
  assert.deepEqual(await daemon.asked(), []);
  const presented = daemon.registryAuths.map((auth) =>
    JSON.stringify(auth ?? null),
  );
  assert.ok(
    !presented.some((auth) => auth.includes(machineLogin.Secret)),
    presented.join("\n"),
  );
  assert.deepEqual(
    daemon.registryAuths.map((auth) =>
      auth !== null && typeof auth === "object" && "password" in auth
        ? auth.password
        : undefined,
    ),
    ["pool-token", undefined, undefined, "pool-token", undefined, undefined],
  );
});

test("a pull's directory is owner-only, holds its credential, and is gone after", async (t) => {
  const runtime = await runtimeDir(t);
  const seen = await withRegistryAuth(
    runtime,
    "podman",
    credential,
    async (directory) => ({
      name: directory.slice(runtime.length + 1),
      directory: (await stat(directory)).mode & 0o777,
      file: (await stat(join(directory, "config.json"))).mode & 0o777,
      text: await readFile(join(directory, "config.json"), "utf8"),
    }),
  );
  assert.match(seen.name, new RegExp(`^pull-${String(process.pid)}-`, "u"));
  assert.deepEqual(
    { ...seen, name: undefined },
    {
      name: undefined,
      directory: 0o700,
      file: 0o600,
      text: registryAuthDocument("podman", credential),
    },
  );
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(runtime), []);
});

test("a pull's directory is gone after a pull that threw", async (t) => {
  const runtime = await runtimeDir(t);
  await assert.rejects(
    withRegistryAuth(runtime, "docker", undefined, async () => {
      throw new Error("the pull was aborted");
    }),
    /the pull was aborted/u,
  );
  assert.deepEqual(await readdir(runtime), []);
});
