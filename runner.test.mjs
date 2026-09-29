import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  engineEndpoint,
  jobNetwork,
  ownScratchRemoved,
  runnerDirectories,
  runnerLoop,
  runnerParts,
  runnerSetup,
} from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { fixturePool, runnerFixture } from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

/**
 * A client whose issuer is down for its first pass and whose plane answers
 * each poll after that from a script.
 *
 * @param {Array<() => unknown>} polls
 */
function scriptedClient(polls) {
  /** @type {string[]} */
  const placed = [];
  let acquired = 0;
  let polled = 0;
  const client = {
    tokens: {
      acquire: async () =>
        acquired++ === 0
          ? {
              acquired: "Unavailable",
              evidence: "the issuer could not be reached",
            }
          : { acquired: "Token", token: "pool-token" },
      invalidate: () => undefined,
    },
    plane: {
      poll: async () => polls[polled++](),
      settle: async () => "Settled",
    },
    backend: {
      held: async () => [],
      place: async (/** @type {{assignment: string}} */ assignment) => {
        placed.push(assignment.assignment);
        return { placed: "Placed" };
      },
      stop: async () => ({ stopped: "Stopped" }),
    },
    settings: { concurrencyMax: 2, outageBackoffMs: 5000, passesMax: 1 },
  };
  return { client, placed };
}

test("a run passes until the plane denies the pool, logging each outage and each pass that did something", async () => {
  const { client, placed } = scriptedClient([
    () => ({
      polled: "Reconciled",
      assignments: [{ assignment: "asg-1" }],
      stop: [],
    }),
    () => ({ polled: "Reconciled", assignments: [], stop: [] }),
    () => ({ polled: "Denied", evidence: "the pool was revoked" }),
  ]);
  /** @type {string[]} */
  const log = [];
  /** @type {number[]} */
  const slept = [];
  const status = await runnerLoop(/** @type {any} */ (client), {
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (line) => log.push(line),
  });
  assert.equal(status, 3);
  assert.deepEqual(placed, ["asg-1"]);
  assert.deepEqual(slept, [5000]);
  assert.deepEqual(log, [
    "outage: the issuer could not be reached",
    "placed 1, stopped 0, refused 0",
    "the plane denied this pool: the pool was revoked",
  ]);
});

test("the job network is made only where it is missing", async () => {
  const { engine, state } = fakeEngine();
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Created");
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Present");
  assert.deepEqual(
    state.calls.map((call) => call.argv),
    [
      ["network", "inspect", "chuggy-jobs"],
      ["network", "create", "chuggy-jobs"],
      ["network", "inspect", "chuggy-jobs"],
    ],
  );
  state.unreachable = true;
  await assert.rejects(
    jobNetwork(engine, "chuggy-jobs"),
    /network chuggy-jobs could not be inspected: Cannot connect/u,
  );
});

test("the runner's directories are owner-only, and what a killed run left in them is removed", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const paths = runnerPaths(environment, home);
  await mkdir(join(/** @type {string} */ (paths.runtime), "pull-left"), {
    recursive: true,
  });
  await writeFile(
    join(/** @type {string} */ (paths.runtime), "control.sock"),
    "",
  );
  await runnerDirectories(paths);
  assert.deepEqual(await readdir(/** @type {string} */ (paths.runtime)), [
    "control.sock",
  ]);
  assert.equal((await stat(paths.logs)).mode & 0o777, 0o700);
  await assert.rejects(
    runnerDirectories(runnerPaths({}, home)),
    /XDG_RUNTIME_DIR is not set/u,
  );
});

test("a run is composed from both files, and refuses to start without a runtime directory", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { concurrencyMax: 3 },
  });
  const setup = await runnerSetup(poolFile, environment, home);
  const { engine } = fakeEngine();
  const runner = await runnerParts(setup, {
    uid: 1000,
    log: () => undefined,
    engine,
  });
  assert.equal(runner.client.settings.concurrencyMax, 3);
  assert.deepEqual(runner.backend.inFlight(), []);
  const bare = await runnerSetup(
    poolFile,
    { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME },
    home,
  );
  await assert.rejects(
    runnerParts(bare, { uid: 1000, log: () => undefined, engine }),
    /XDG_RUNTIME_DIR is not set/u,
  );
});

test("podman has no endpoint, and is taken only from the first version whose --authfile is all it reads", async () => {
  const { engine, state } = fakeEngine();
  for (const version of [
    "4.4.0",
    "4.9.3-dev",
    "4.10.1",
    "5.0.0-rc1",
    "5.8.7",
    "10.0.0",
  ]) {
    state.podmanVersion = version;
    assert.equal(await engineEndpoint("podman", engine), undefined, version);
  }
  for (const version of ["4.3.1", "3.9.9", "4.3.99-dev"]) {
    state.podmanVersion = version;
    await assert.rejects(
      engineEndpoint("podman", engine),
      new RegExp(
        `^Error: podman ${version.replaceAll(".", "\\.")} reads this machine's stored logins even when told not to; podman 4\\.4 or later is required$`,
        "u",
      ),
    );
  }
  for (const version of ["garbage", "", "4.4", "v4.4.0", "4.4.0 extra"]) {
    state.podmanVersion = version;
    await assert.rejects(
      engineEndpoint("podman", engine),
      /^Error: podman answered ".*", not a version; podman 4\.4 or later is required$/u,
      version,
    );
  }
  state.unreachable = true;
  await assert.rejects(
    engineEndpoint("podman", engine),
    /^Error: podman could not be asked: /u,
  );
  assert.ok(
    state.calls.every((call) => ["version", "info"].includes(call.argv[0])),
  );
});

test("a remote podman client is refused, and so is one that cannot say whether it is one", async () => {
  const { engine, state } = fakeEngine();
  state.podmanServiceRemote = "true";
  await assert.rejects(
    engineEndpoint("podman", engine),
    /^Error: podman is a remote client here \(CONTAINER_HOST, CONTAINER_CONNECTION or remote = true in containers.conf\), where its service reads its own stored logins; run the runner beside a local podman$/u,
  );
  for (const answer of ["", "True", "yes", "false true", "<no value>"]) {
    state.podmanServiceRemote = answer;
    await assert.rejects(
      engineEndpoint("podman", engine),
      new RegExp(
        `^Error: podman answered "${answer}" when asked whether it is a remote client$`,
        "u",
      ),
      answer,
    );
  }
  state.podmanServiceRemote = undefined;
  await assert.rejects(
    engineEndpoint("podman", engine),
    /^Error: podman could not say whether it is a remote client: Error: cannot connect to Podman$/u,
  );
  assert.deepEqual(state.calls.at(-1)?.argv, [
    "info",
    "--format",
    "{{.Host.ServiceIsRemote}}",
  ]);
});

test("docker that maps a job's uid, rootless or by userns-remap, is refused before anything else is asked of it", async () => {
  for (const [option, running] of [
    ["name=rootless", "rootless"],
    ["name=userns", "with userns-remap"],
  ]) {
    const { engine, state } = fakeEngine();
    state.securityOptions = ["name=seccomp,profile=builtin", option];
    await assert.rejects(
      engineEndpoint("docker", engine),
      new RegExp(
        `^Error: docker is running ${running}, .*; use rootful docker without userns-remap, or rootless podman`,
        "u",
      ),
    );
    assert.deepEqual(
      state.calls.map((call) => call.argv[0]),
      ["info"],
    );
  }
});

test("a run refuses rootless docker", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { engine: "docker" },
  });
  const { engine, state } = fakeEngine();
  state.securityOptions = ["name=rootless"];
  await assert.rejects(
    runnerParts(await runnerSetup(poolFile, environment, home), {
      uid: 1000,
      log: () => undefined,
      engine,
    }),
    /docker is running rootless/u,
  );
});

test("a run refuses a podman that reads this machine's stored logins", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  state.podmanVersion = "4.3.1";
  await assert.rejects(
    runnerParts(await runnerSetup(poolFile, environment, home), {
      uid: 1000,
      log: () => undefined,
      engine,
    }),
    /^Error: podman 4\.3\.1 reads this machine's stored logins/u,
  );
});

test(
  "a docker pull is made at the endpoint the user's docker context names, under docker's own empty credential",
  {
    skip:
      ownUid !== 1000 &&
      "docker places a job only for a runner that is uid 1000, and this suite is not",
  },
  async (t) => {
    const { home, environment, poolFile } = await runnerFixture(t, {
      runner: { engine: "docker" },
    });
    const { engine, state } = fakeEngine();
    state.contextHost = "unix:///run/user/1000/docker.sock";
    const runner = await runnerParts(
      await runnerSetup(poolFile, environment, home),
      { uid: ownUid, log: () => undefined, engine },
    );
    const placed = await runner.backend.place({
      assignment: "asg-1",
      capabilities: ["container"],
      image: `busybox@sha256:${"a".repeat(64)}`,
      cpuMillis: 1000,
      memoryMib: 512,
      deadlineSecs: 600,
      callbackUrl: "https://chuggy.example/worker",
      bearer: "attempt-bearer",
    });
    assert.deepEqual(placed, { placed: "Placed" });
    await runner.backend.settled();
    const pull = state.calls.find((call) => call.argv[0] === "pull");
    assert.equal(
      pull?.environment.DOCKER_HOST,
      "unix:///run/user/1000/docker.sock",
    );
    assert.deepEqual(JSON.parse(pull?.authFile ?? ""), {
      auths: {},
      credHelpers: { "chuggy.invalid": "" },
    });
    assert.deepEqual(
      state.calls.map((call) => call.argv[0]),
      ["info", "context", "image", "pull", "run"],
    );
  },
);

test("docker is refused when it cannot be asked, or its context names no local socket", async () => {
  const { engine, state } = fakeEngine();
  for (const host of ["tcp://192.0.2.10:2376", "ssh://op@build", ""]) {
    state.contextHost = host;
    await assert.rejects(
      engineEndpoint("docker", engine),
      new RegExp(
        `^Error: docker's context names "${host}", and only a local docker, reached by a unix socket, is supported$`,
        "u",
      ),
    );
  }
  state.contextHost = undefined;
  await assert.rejects(
    engineEndpoint("docker", engine),
    /^Error: docker's context could not be read: context "default": context not found$/u,
  );
  state.unreachable = true;
  await assert.rejects(
    engineEndpoint("docker", engine),
    /^Error: docker could not be asked: Cannot connect to the Docker daemon/u,
  );
});

test("the registry the pool file names is the one a pull presents the pool's token to", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: { ...fixturePool, registryHost: "registry.chuggy.example" },
  });
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(
    await runnerSetup(poolFile, environment, home),
    {
      uid: ownUid,
      log: () => undefined,
      engine,
      tokens: {
        acquire: async () => ({ acquired: "Token", token: "pool-token" }),
        invalidate: () => undefined,
      },
    },
  );
  await runner.backend.place({
    assignment: "asg-1",
    capabilities: ["container"],
    image: `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`,
    cpuMillis: 1000,
    memoryMib: 512,
    deadlineSecs: 600,
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer",
  });
  await runner.backend.settled();
  const pull = state.calls.find((call) => call.argv[0] === "pull");
  assert.deepEqual(Object.keys(JSON.parse(pull?.authFile ?? "").auths), [
    "registry.chuggy.example",
  ]);
});

test("a process removes only the pull credentials and env files it made", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const runtime = /** @type {string} */ (
    runnerPaths(environment, home).runtime
  );
  for (const entry of ["pull-12-a", "job-12-b", "pull-123-c", "job-1-d"])
    await mkdir(join(runtime, entry), { recursive: true });
  await writeFile(join(runtime, "control.sock"), "");
  ownScratchRemoved(runtime, 12);
  assert.deepEqual((await readdir(runtime)).sort(), [
    "control.sock",
    "job-1-d",
    "pull-123-c",
  ]);
});

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"]))
  test(`a ${signal} removes the process's own scratch and still ends it by that signal`, async (t) => {
    const { home, environment } = await runnerFixture(t);
    const runtime = /** @type {string} */ (
      runnerPaths(environment, home).runtime
    );
    await mkdir(join(runtime, "pull-1-another"), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeScratch } from ${JSON.stringify(import.meta.resolve("./runnerConfig.mjs"))};
import { scratchRemovedOnSignal } from ${JSON.stringify(import.meta.resolve("./runner.mjs"))};
const runtime = process.argv[1];
mkdirSync(join(runtime, runtimeScratch("pull") + "a"));
mkdirSync(join(runtime, runtimeScratch("job") + "b"));
scratchRemovedOnSignal(runtime);
setInterval(() => undefined, 1000);
process.stdout.write("ready\\n");`,
        runtime,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await once(child.stdout, "data");
    assert.equal((await readdir(runtime)).length, 3);
    child.kill(signal);
    assert.deepEqual(await once(child, "exit"), [null, signal]);
    assert.deepEqual(await readdir(runtime), ["pull-1-another"]);
  });
