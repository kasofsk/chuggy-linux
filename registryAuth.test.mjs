import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("an image's registry is its first component when that names a host", () => {
  assert.deepEqual(
    [
      "registry.chuggy.example/worker@sha256:aa",
      "localhost:5000/chuggy/worker:1",
      "localhost/worker:1",
      "192.0.2.10:30500/worker",
      "chuggy/worker:1",
      "busybox",
    ].map(imageRegistryHost),
    [
      "registry.chuggy.example",
      "localhost:5000",
      "localhost",
      "192.0.2.10:30500",
      undefined,
      undefined,
    ],
  );
});

test("the credential is the pool's token under the pool's user, for that host alone", () => {
  const document = JSON.parse(
    registryAuthDocument("registry.chuggy.example", "pool-token"),
  );
  assert.deepEqual(Object.keys(document.auths), ["registry.chuggy.example"]);
  assert.equal(
    Buffer.from(
      document.auths["registry.chuggy.example"].auth,
      "base64",
    ).toString("utf8"),
    "chuggy-pool:pool-token",
  );
  assert.deepEqual(JSON.parse(registryAuthDocument(undefined, "pool-token")), {
    auths: {},
  });
});

test("a pull's directory is owner-only, holds its credential, and is gone after", async (t) => {
  const runtime = await runtimeDir(t);
  const seen = await withRegistryAuth(
    runtime,
    "registry.chuggy.example",
    "pool-token",
    async (directory) => ({
      directory: (await stat(directory)).mode & 0o777,
      file: (await stat(join(directory, "config.json"))).mode & 0o777,
      text: await readFile(join(directory, "config.json"), "utf8"),
    }),
  );
  assert.deepEqual(seen, {
    directory: 0o700,
    file: 0o600,
    text: registryAuthDocument("registry.chuggy.example", "pool-token"),
  });
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(runtime), []);
});

test("a pull's directory is gone after a pull that threw", async (t) => {
  const runtime = await runtimeDir(t);
  await assert.rejects(
    withRegistryAuth(
      runtime,
      "registry.chuggy.example",
      "pool-token",
      async () => {
        throw new Error("the pull was aborted");
      },
    ),
    /the pull was aborted/u,
  );
  assert.deepEqual(await readdir(runtime), []);
});
