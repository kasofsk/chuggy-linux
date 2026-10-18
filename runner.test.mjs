import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { jobEngineSocketVariables } from "@chuggy/worker-core/job.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  engineEndpoint,
  engineSocketHanded,
  jobNetwork,
  ownScratchRemoved,
  poolRuntimeDirectory,
  runnerDirectories,
  runnerLeftoversRemoved,
  runnerLoop,
  runnerParts,
  runnerSetup,
} from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { deniedExitStatus } from "./systemdUnit.mjs";
import {
  engineSocketFixture,
  fixturePool,
  runnerFixture,
} from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

test("a run the plane denies ends with the status the unit does not restart", async () => {
  const client = {
    tokens: {
      acquire: async () => ({ acquired: "Token", token: "pool-token" }),
      invalidate: () => undefined,
    },
    plane: {
      poll: async () => ({
        polled: "Denied",
        evidence: "the pool was revoked",
      }),
    },
    backend: { held: async () => [], ended: async () => [] },
    settings: { concurrencyMax: 2, outageBackoffMs: 5000, passesMax: 1 },
  };
  /** @type {string[]} */
  const log = [];
  const status = await runnerLoop(/** @type {any} */ (client), {
    sleep: async () => undefined,
    log: (line) => log.push(line),
  });
  assert.equal(status, deniedExitStatus);
  assert.deepEqual(log, ["the plane denied this pool: the pool was revoked"]);
});

test("a job network another run made between the inspection and the creation is present", async () => {
  const { engine, state } = fakeEngine();
  const raced = {
    .../** @type {import("@chuggy/worker-core/engine.mjs").Engine} */ (engine),
    exec: async (
      /** @type {readonly string[]} */ argv,
      /** @type {import("@chuggy/worker-core/engine.mjs").EngineCall | undefined} */ call,
    ) => {
      if (argv[0] === "network" && argv[1] === "create") {
        state.networks.add(argv[2]);
        return {
          code: 1,
          stdout: "",
          stderr: `Error response from daemon: network with name ${argv[2]} already exists\n`,
        };
      }
      return engine.exec(argv, call);
    },
  };
  assert.equal(await jobNetwork(raced, "chuggy-jobs"), "Present");
  const refused = {
    ...raced,
    exec: async (/** @type {readonly string[]} */ argv) =>
      argv[1] === "create"
        ? { code: 1, stdout: "", stderr: "Error: permission denied\n" }
        : engine.exec(["network", "inspect", "missing"]),
  };
  await assert.rejects(
    jobNetwork(refused, "missing"),
    /^Error: network missing could not be created: Error: permission denied$/u,
  );
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

test("a pool's directories are owner-only, and what a killed run left in its runtime directory is removed", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const paths = runnerPaths(environment, home);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await runnerDirectories(paths, runtime);
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.logs)).mode & 0o777, 0o700);
  await mkdir(join(runtime, "pull-left"));
  await mkdir(join(runtime, "job-left"));
  await writeFile(join(runtime, "control.sock"), "");
  await runnerLeftoversRemoved(runtime);
  assert.deepEqual(await readdir(runtime), ["control.sock"]);
});

test("each pool has a runtime directory of its own under the runner's, which needs XDG_RUNTIME_DIR", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const paths = runnerPaths(environment, home);
  const own = poolRuntimeDirectory(paths, fixturePool);
  const other = poolRuntimeDirectory(paths, {
    ...fixturePool,
    tenant: "newtenant",
    project: "arbbot",
  });
  assert.match(
    own,
    new RegExp(
      `^${environment.XDG_RUNTIME_DIR}/chuggy-linux/pools/[0-9a-f]{20}$`,
      "u",
    ),
  );
  assert.notEqual(own, other);
  assert.equal(own, poolRuntimeDirectory(paths, { ...fixturePool }));
  assert.throws(
    () => poolRuntimeDirectory(runnerPaths({}, home), fixturePool),
    /XDG_RUNTIME_DIR is not set/u,
  );
});

test("a pool's scratch left by a killed run is removed at another pool's start no more than its own", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const paths = runnerPaths(environment, home);
  const own = poolRuntimeDirectory(paths, fixturePool);
  const other = poolRuntimeDirectory(paths, {
    ...fixturePool,
    project: "arbbot",
  });
  for (const runtime of [own, other]) {
    await runnerDirectories(paths, runtime);
    await mkdir(join(runtime, "pull-1-a"));
  }
  await runnerLeftoversRemoved(own);
  assert.deepEqual(await readdir(own), []);
  assert.deepEqual(await readdir(other), ["pull-1-a"]);
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
  assert.equal(runner.client.settings.sessionsMax, 2);
  assert.equal(typeof runner.client.sessions?.end, "function");
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

test("a run's backend refuses an assignment while the token file is not this runner's to hand to a job", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  const uid = ownUid + 1;
  const runner = await runnerParts(
    await runnerSetup(poolFile, environment, home),
    { uid, log: () => undefined, engine },
  );
  const calls = state.calls.length;
  const placed = await runner.backend.place(
    {
      assignment: "asg-1",
      capabilities: ["container"],
      image: "registry.chuggy.example/worker@sha256:" + "a".repeat(64),
      cpuMillis: 1,
      memoryMib: 1,
      deadlineSecs: 60,
      callbackUrl: "https://chuggy.example/worker",
      bearer: "attempt-bearer",
    },
    "Job",
  );
  assert.equal(placed.placed, "Refused");
  assert.match(
    placed.evidence ?? "",
    new RegExp(`not by this runner's uid ${String(uid)}$`, "u"),
  );
  assert.equal(state.calls.length, calls);
});

test("a pool registered with --host takes a job that pins no image on this machine, and leaves every other to its containers", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: {
      ...fixturePool,
      capabilities: ["Platform:Linux:Amd64"],
      host: true,
    },
  });
  const { engine, state } = fakeEngine();
  const uid = ownUid + 1;
  const runner = await runnerParts(
    await runnerSetup(poolFile, environment, home),
    { uid, log: () => undefined, engine },
  );
  const assignment = {
    assignment: "asg-1",
    capabilities: ["Platform:Linux:Amd64", "Agent:Claude"],
    cpuMillis: 1,
    memoryMib: 1,
    deadlineSecs: 60,
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer",
  };
  const calls = state.calls.length;
  const hosted = await runner.backend.place(assignment, "Job");
  assert.equal(hosted.placed, "Refused");
  assert.match(
    hosted.evidence ?? "",
    new RegExp(`not by this runner's uid ${String(uid)}$`, "u"),
  );
  const contained = await runner.backend.place(
    {
      ...assignment,
      assignment: "asg-2",
      capabilities: ["Platform:Linux:Arm64", "Agent:Claude"],
    },
    "Job",
  );
  assert.match(
    contained.evidence ?? "",
    /no image this pool's owner listed meets it/u,
  );
  assert.equal(state.calls.length, calls);
  assert.deepEqual(runner.backend.inFlight(), []);
});

test("a pool registered without --host runs no job on this machine, even one naming its platform", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: { ...fixturePool, capabilities: ["Platform:Linux:Amd64"] },
  });
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(
    await runnerSetup(poolFile, environment, home),
    { uid: ownUid + 1, log: () => undefined, engine },
  );
  const calls = state.calls.length;
  const placed = await runner.backend.place(
    {
      assignment: "asg-1",
      capabilities: ["Platform:Linux:Amd64", "Agent:Claude"],
      cpuMillis: 1,
      memoryMib: 1,
      deadlineSecs: 60,
      callbackUrl: "https://chuggy.example/worker",
      bearer: "attempt-bearer",
    },
    "Job",
  );
  assert.match(placed.evidence ?? "", /no image this pool's owner listed/u);
  assert.equal(state.calls.length, calls);
});

test("a runner whose file sets sessionsMax to 0 is given no room for a session", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { sessionsMax: 0 },
  });
  const { engine } = fakeEngine();
  const runner = await runnerParts(
    await runnerSetup(poolFile, environment, home),
    { uid: 1000, log: () => undefined, engine },
  );
  assert.equal(runner.client.settings.concurrencyMax, 1);
  assert.equal(runner.client.settings.sessionsMax, 0);
});

test("podman has no endpoint, and is taken only from the first version whose keep-id maps its user onto a job's", async () => {
  const { engine, state } = fakeEngine();
  for (const version of [
    "4.3.0",
    "4.3.1",
    "4.9.3-dev",
    "4.10.1",
    "5.0.0-rc1",
    "5.8.7",
    "10.0.0",
  ]) {
    state.podmanVersion = version;
    assert.equal(await engineEndpoint("podman", engine), undefined, version);
  }
  for (const version of ["4.2.1", "3.9.9", "4.2.99-dev"]) {
    state.podmanVersion = version;
    await assert.rejects(
      engineEndpoint("podman", engine),
      new RegExp(
        `^Error: podman ${version.replaceAll(".", "\\.")} cannot map its user onto a job's with --userns=keep-id:uid=,gid=; podman 4\\.3 or later is required$`,
        "u",
      ),
    );
  }
  for (const version of ["garbage", "", "4.3", "v4.3.0", "4.3.0 extra"]) {
    state.podmanVersion = version;
    await assert.rejects(
      engineEndpoint("podman", engine),
      /^Error: podman answered ".*", not a version; podman 4\.3 or later is required$/u,
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
    /^Error: podman is a remote client here \(CONTAINER_HOST, CONTAINER_CONNECTION or remote = true in containers.conf\), whose service mounts a job's paths from its own machine; run the runner beside a local podman$/u,
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

test("a run refuses a podman whose keep-id cannot map its user onto a job's", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  state.podmanVersion = "4.2.1";
  await assert.rejects(
    runnerParts(await runnerSetup(poolFile, environment, home), {
      uid: 1000,
      log: () => undefined,
      engine,
    }),
    /^Error: podman 4\.2\.1 cannot map its user onto a job's/u,
  );
});

test(
  "a docker pull of the pool's registry is made under the pool's token at the endpoint the user's docker context names, and any other is docker's own",
  {
    skip:
      ownUid !== 1000 &&
      "docker places a job only for a runner that is uid 1000, and this suite is not",
  },
  async (t) => {
    const { home, environment, poolFile } = await runnerFixture(t, {
      pool: { ...fixturePool, registryHost: "registry.chuggy.example" },
      runner: { engine: "docker" },
    });
    const { engine, state } = fakeEngine();
    state.contextHost = "unix:///run/user/1000/docker.sock";
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
    const images = [
      `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`,
      `ghcr.io/someone/private@sha256:${"b".repeat(64)}`,
    ];
    for (const [index, image] of images.entries()) {
      const placed = await runner.backend.place(
        {
          assignment: `asg-${String(index)}`,
          capabilities: ["container"],
          image,
          cpuMillis: 1000,
          memoryMib: 512,
          deadlineSecs: 600,
          callbackUrl: "https://chuggy.example/worker",
          bearer: "attempt-bearer",
        },
        "Job",
      );
      assert.deepEqual(placed, { placed: "Placed" });
      await runner.backend.settled();
    }
    const [pool, other] = state.calls.filter((call) => call.argv[0] === "pull");
    assert.deepEqual(pool.argv, ["pull", "--quiet", images[0]]);
    assert.deepEqual(pool.environment, {
      DOCKER_CONFIG: pool.authDirectory,
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      DOCKER_AUTH_CONFIG: "",
    });
    assert.deepEqual(Object.keys(JSON.parse(pool.authFile ?? "").auths), [
      "registry.chuggy.example",
    ]);
    assert.deepEqual(other.argv, ["pull", "--quiet", images[1]]);
    assert.deepEqual(other.environment, {});
    assert.equal(other.authFile, undefined);
    assert.deepEqual(
      state.calls.map((call) => call.argv[0]),
      ["info", "context", "image", "pull", "run", "image", "pull", "run"],
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
  await runner.backend.place(
    {
      assignment: "asg-1",
      capabilities: ["container"],
      image: `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`,
      cpuMillis: 1000,
      memoryMib: 512,
      deadlineSecs: 600,
      callbackUrl: "https://chuggy.example/worker",
      bearer: "attempt-bearer",
    },
    "Job",
  );
  await runner.backend.settled();
  const pull = state.calls.find((call) => call.argv[0] === "pull");
  assert.deepEqual(Object.keys(JSON.parse(pull?.authFile ?? "").auths), [
    "registry.chuggy.example",
  ]);
  assert.equal(
    runner.runtime,
    poolRuntimeDirectory(runnerPaths(environment, home), fixturePool),
  );
  assert.ok(
    pull?.authDirectory?.startsWith(`${runner.runtime}/pull-`),
    pull?.authDirectory,
  );
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

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
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
import { runtimeScratch } from ${JSON.stringify(import.meta.resolve("@chuggy/worker-core/runtimeScratch.mjs"))};
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

const registryImage = `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`;

/**
 * @param {string} assignment
 * @param {string} image
 */
function runnerAssignment(assignment, image) {
  return {
    assignment,
    capabilities: ["container"],
    image,
    cpuMillis: 1000,
    memoryMib: 512,
    deadlineSecs: 600,
    callbackUrl: "https://chuggy.example/worker",
    bearer: `bearer-of-${assignment}`,
  };
}

/**
 * A run over a fake engine whose jobs' and sessions' planes answer every call
 * and record it, polled by a plane answering `polls` in turn and recording
 * what each poll asked, its held assignments sorted.
 *
 * @param {import("node:test").TestContext} t
 * @param {unknown[]} polls
 */
async function endingRunner(t, polls) {
  const { home, environment, poolFile } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  /** @type {Array<{url: string, method: string | undefined, authorization: string, body: string}>} */
  const asked = [];
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
      fetch: async (url, init = {}) => {
        asked.push({
          url: String(url),
          method: init.method,
          authorization: /** @type {Record<string, string>} */ (init.headers)
            .authorization,
          body: String(init.body),
        });
        return new globalThis.Response(null, { status: 204 });
      },
    },
  );
  /** @type {unknown[][]} */
  const pollsAsked = [];
  const client =
    /** @type {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} */ ({
      ...runner.client,
      plane: {
        poll: async (
          /** @type {string} */ token,
          /** @type {readonly string[]} */ held,
          /** @type {unknown[]} */ ...wanted
        ) => polls[pollsAsked.push([token, [...held].sort(), ...wanted]) - 1],
        settle: async () => "Settled",
      },
    });
  return { runner, client, state, asked, pollsAsked };
}

const quietPoll = {
  polled: "Reconciled",
  assignments: [],
  sessions: [],
  stop: [],
};

test("a pass ends the attempt of a job whose container exited unreported, at its plane under its own bearer, with the runner's reason", async (t) => {
  const { runner, client, state, asked } = await endingRunner(t, [quietPoll]);
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  const [container] = state.containers.values();
  container.status = "exited";
  container.exitCode = 1;

  assert.deepEqual(await workerPoolClientPass(client), {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 1,
  });
  assert.deepEqual(asked, [
    {
      url: "https://chuggy.example/v1/artifacts/.chuggy/worker-error.txt",
      method: "PUT",
      authorization: "Bearer bearer-of-asg-1",
      body: "Worker exited before reporting: its container exited with status 1\n",
    },
    {
      url: "https://chuggy.example/v1/run/ended",
      method: "POST",
      authorization: "Bearer bearer-of-asg-1",
      body: '{"evidence":"RunFailed"}',
    },
  ]);
});

/**
 * What a run asked of an attempt's plane under that attempt's bearer.
 *
 * @param {Array<{url: string, method: string | undefined, authorization: string, body: string}>} asked
 * @param {string} assignment
 */
function askedUnder(asked, assignment) {
  return asked
    .filter(
      ({ authorization }) => authorization === `Bearer bearer-of-${assignment}`,
    )
    .map(({ url, method, body }) => [method, url, body]);
}

test("a pass places a session the plane offers as a session, and its end reaches the session's plane while a job's still reaches the job's", async (t) => {
  const { runner, client, state, asked, pollsAsked } = await endingRunner(t, [
    {
      polled: "Reconciled",
      assignments: [runnerAssignment("asg-1", registryImage)],
      sessions: [runnerAssignment("ses-1", registryImage)],
      stop: [],
    },
    quietPoll,
    quietPoll,
  ]);
  state.images.add(registryImage);
  const quiet = { passed: "Reconciled", stopped: 0, refused: 0 };
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 2,
    ended: 0,
  });
  await runner.backend.settled();
  assert.deepEqual(
    [...state.containers.values()]
      .map((container) => [
        container.labels["io.chuggy.assignment"],
        container.labels["io.chuggy.kind"],
      ])
      .sort(),
    [
      ["asg-1", "Job"],
      ["ses-1", "Session"],
    ],
  );
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 0,
    ended: 0,
  });
  for (const container of state.containers.values()) {
    container.status = "exited";
    container.exitCode =
      container.labels["io.chuggy.kind"] === "Session" ? 0 : 1;
  }
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 0,
    ended: 2,
  });
  assert.deepEqual(pollsAsked, [
    ["pool-token", [], 1, 2],
    ["pool-token", ["asg-1", "ses-1"], 0, 1],
    ["pool-token", [], 1, 2],
  ]);
  assert.deepEqual(askedUnder(asked, "ses-1"), [
    [
      "POST",
      "https://chuggy.example/v1/session/ended",
      '{"phase":"Succeeded"}',
    ],
  ]);
  assert.deepEqual(askedUnder(asked, "asg-1"), [
    [
      "PUT",
      "https://chuggy.example/v1/artifacts/.chuggy/worker-error.txt",
      "Worker exited before reporting: its container exited with status 1\n",
    ],
    ["POST", "https://chuggy.example/v1/run/ended", '{"evidence":"RunFailed"}'],
  ]);
  assert.equal(asked.length, 3);
});

test("a job stopped on the plane's word is never ended, though its container outlives the pass that stopped it", async (t) => {
  const { runner, client, state, asked } = await endingRunner(t, [
    {
      polled: "Reconciled",
      assignments: [],
      sessions: [],
      stop: ["asg-1", "asg-2"],
    },
    quietPoll,
  ]);
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  state.pull = () => new Promise(() => undefined);
  await runner.backend.place(
    runnerAssignment("asg-2", `elsewhere.example/w@sha256:${"b".repeat(64)}`),
    "Job",
  );
  state.logsFail = true;

  const quiet = { passed: "Reconciled", placed: 0, refused: 0, ended: 0 };
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    stopped: 2,
  });
  assert.equal(state.containers.size, 1);
  state.logsFail = false;
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    stopped: 0,
  });
  assert.equal(state.containers.size, 0);
  assert.deepEqual(asked, []);
});

/**
 * What a run over a fake engine `configure` sets up starts for a job and a
 * session placed beside it: each one's argv, its env file's path left out,
 * and its env file's lines.
 *
 * @param {Awaited<ReturnType<typeof runnerSetup>>} setup
 * @param {(state: import("./engine.fixture.mjs").FakeEngineState) => void} configure
 */
async function ranBeside(setup, configure) {
  const { engine, state } = fakeEngine();
  configure(state);
  state.images.add(registryImage);
  const runner = await runnerParts(setup, {
    uid: ownUid,
    log: () => undefined,
    engine,
  });
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.place(
    runnerAssignment("ses-1", registryImage),
    "Session",
  );
  await runner.backend.settled();
  /** @param {string} assignment */
  const ran = (assignment) => {
    const call = state.calls.find(
      ({ argv }) =>
        argv[0] === "run" &&
        argv.includes(`io.chuggy.assignment=${assignment}`),
    );
    assert.ok(call !== undefined, assignment);
    return {
      argv: call.argv.filter(
        (_, index) => call.argv[index - 1] !== "--env-file",
      ),
      envFile: (call.envFile ?? "").split("\n").filter((line) => line !== ""),
    };
  };
  return { job: ran("asg-1"), session: ran("ses-1"), state };
}

/**
 * Checks that a runner whose file hands jobs the engine, over a fake engine
 * `answered` points at a stand-in socket, runs a job as one whose file hands
 * none but for the socket's mount, `group` and `variables`, and runs a
 * session exactly as that one does.
 *
 * @param {import("node:test").TestContext} t
 * @param {"docker" | "podman"} engine
 * @param {(state: import("./engine.fixture.mjs").FakeEngineState, path: string) => void} answered
 * @param {(gid: number) => string[]} group
 * @param {(path: string) => string[]} variables
 */
async function assertJobsHandedEngineSocket(
  t,
  engine,
  answered,
  group,
  variables,
) {
  const socket = await engineSocketFixture(t);
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { engine, engineSocket: true },
  });
  const setup = await runnerSetup(poolFile, environment, home);
  /** @param {import("./engine.fixture.mjs").FakeEngineState} state */
  const configure = (state) => answered(state, socket.path);
  const handedNone = await ranBeside(
    { ...setup, config: { ...setup.config, engineSocket: false } },
    configure,
  );
  const handed = await ranBeside(setup, configure);
  const flags = [
    "--mount",
    `type=bind,source=${socket.path},target=/var/run/docker.sock,readonly`,
    ...group(socket.gid),
  ];
  const at = handed.job.argv.indexOf(flags[1]) - 1;
  assert.deepEqual(handed.job.argv.slice(at, at + flags.length), flags);
  assert.deepEqual(
    handed.job.argv.toSpliced(at, flags.length),
    handedNone.job.argv,
  );
  assert.deepEqual(
    [...handed.job.envFile].sort(),
    [...handedNone.job.envFile, ...variables(socket.path)].sort(),
  );
  assert.deepEqual(handed.session, handedNone.session);
}

test(
  "a docker runner whose file hands jobs the engine hands each its context's socket read-only, the socket's group and where the socket is, and a session none of it",
  {
    skip:
      ownUid !== 1000 &&
      "docker places a job only for a runner that is uid 1000, and this suite is not",
  },
  async (t) => {
    await assertJobsHandedEngineSocket(
      t,
      "docker",
      (state, path) => {
        state.contextHost = `unix://${path}`;
      },
      (gid) => {
        assert.notEqual(gid, 0);
        return ["--group-add", String(gid)];
      },
      (path) => [
        "DOCKER_HOST=unix:///var/run/docker.sock",
        `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=${path}`,
      ],
    );
  },
);

test("a podman runner whose file hands jobs the engine hands each the socket podman names, read-only and in no group, where the socket is and where what it starts is reached, and a session none of it", async (t) => {
  await assertJobsHandedEngineSocket(
    t,
    "podman",
    (state, path) => {
      state.podmanSocket = `unix://${path} true`;
    },
    () => [],
    (path) => [
      "DOCKER_HOST=unix:///var/run/docker.sock",
      `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=${path}`,
      "TESTCONTAINERS_HOST_OVERRIDE=host.containers.internal",
    ],
  );
});

test("a runner whose file lists volumes mounts each into a job, a directory bound and a named volume uncopied, and none into a session", async (t) => {
  const volumes = [
    { source: "/srv/cache", target: "/cache/shared", readonly: true },
    { source: "cargo", target: "/cache/cargo" },
  ];
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { volumes },
  });
  const setup = await runnerSetup(poolFile, environment, home);
  /** @param {import("./engine.fixture.mjs").FakeEngineState} state */
  const configure = (state) => {
    state.volumes.set("cargo", {});
  };
  const listed = await ranBeside(setup, configure);
  const unlisted = await ranBeside(
    { ...setup, config: { ...setup.config, volumes: [] } },
    configure,
  );
  const flags = [
    "--mount",
    "type=bind,source=/srv/cache,target=/cache/shared,readonly",
    "--volume",
    "cargo:/cache/cargo:nocopy",
  ];
  const at = listed.job.argv.indexOf(flags[1]) - 1;
  assert.deepEqual(listed.job.argv.slice(at, at + flags.length), flags);
  assert.deepEqual(
    listed.job.argv.toSpliced(at, flags.length),
    unlisted.job.argv,
  );
  assert.deepEqual(listed.session, unlisted.session);
});

test("a runner whose file hands jobs no engine asks nothing of its socket, and hands a job none of it", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const setup = await runnerSetup(poolFile, environment, home);
  assert.equal(setup.config.engineSocket, false);
  const { job, state } = await ranBeside(setup, (fake) => {
    fake.podmanSocket = undefined;
  });
  assert.ok(
    state.calls.every(({ argv }) => !argv.join(" ").includes("RemoteSocket")),
  );
  assert.ok(!job.argv.includes("--group-add"));
  assert.ok(!job.argv.some((flag) => flag.includes("/var/run/docker.sock")));
  assert.ok(
    job.envFile.every(
      (line) =>
        !jobEngineSocketVariables.some((name) => line.startsWith(`${name}=`)),
    ),
  );
});

test("a run that places nothing asks nothing of the socket a runner whose file hands jobs the engine would hand them, and refuses nothing for it", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { engineSocket: true },
  });
  const setup = await runnerSetup(poolFile, environment, home);
  const { engine, state } = fakeEngine();
  state.podmanSocket = "/run/user/1000/podman/podman.sock false";
  await assert.rejects(
    runnerParts(setup, { uid: ownUid, log: () => undefined, engine }),
    /is not there; start it with systemctl --user enable --now podman\.socket$/u,
  );
  const calls = state.calls.length;
  await runnerParts(setup, {
    uid: ownUid,
    log: () => undefined,
    engine,
    places: false,
  });
  assert.ok(
    state.calls
      .slice(calls)
      .every(({ argv }) => !argv.join(" ").includes("RemoteSocket")),
  );
});

test("podman's socket is taken where podman names it, with or without its scheme, and with the group that owns it", async (t) => {
  const socket = await engineSocketFixture(t);
  const { engine, state } = fakeEngine();
  const config = { engine: "podman", engineSocket: true };
  for (const named of [socket.path, `unix://${socket.path}`]) {
    state.podmanSocket = `${named} true`;
    assert.deepEqual(
      await engineSocketHanded(/** @type {any} */ (config), engine, undefined),
      socket,
    );
  }
  assert.deepEqual(
    await engineSocketHanded(
      /** @type {any} */ ({ engine: "docker", engineSocket: true }),
      engine,
      `unix://${socket.path}`,
    ),
    socket,
  );
});

test("a run refuses to start where podman's socket is not there, naming what starts it", async (t) => {
  const socket = await engineSocketFixture(t);
  const { home, environment, poolFile } = await runnerFixture(t, {
    runner: { engineSocket: true },
  });
  const setup = await runnerSetup(poolFile, environment, home);
  const absent = `${socket.path}.absent`;
  for (const answer of [`${socket.path} false`, `${absent} true`]) {
    const { engine, state } = fakeEngine();
    state.podmanSocket = answer;
    await assert.rejects(
      runnerParts(setup, { uid: ownUid, log: () => undefined, engine }),
      new RegExp(
        `^Error: podman's socket ${answer.split(" ")[0]} is not there; start it with systemctl --user enable --now podman\\.socket$`,
        "u",
      ),
      answer,
    );
  }
});

test("a socket a bind mount cannot name is refused, and so is a podman that cannot say where its socket is, each naming what to do", async (t) => {
  const comma = await engineSocketFixture(t, "engine,readonly=false.sock");
  const unnameable =
    "cannot be named in a bind mount; serve the engine at an absolute path with no comma or line break, or set engineSocket to false";
  const { engine, state } = fakeEngine();
  const podman = /** @type {any} */ ({ engine: "podman", engineSocket: true });
  const docker = /** @type {any} */ ({ engine: "docker", engineSocket: true });
  state.podmanSocket = `${comma.path} true`;
  await assert.rejects(engineSocketHanded(podman, engine, undefined), {
    message: `podman's socket ${comma.path} ${unnameable}`,
  });
  await assert.rejects(
    engineSocketHanded(docker, engine, `unix://${comma.path}`),
    {
      message: `docker's socket ${comma.path} ${unnameable}`,
    },
  );
  await assert.rejects(
    engineSocketHanded(docker, engine, "unix://docker.sock"),
    {
      message: `docker's socket docker.sock ${unnameable}`,
    },
  );
  await assert.rejects(
    engineSocketHanded(docker, engine, "unix:///nowhere/docker.sock"),
    {
      message:
        "docker's socket /nowhere/docker.sock is not there; start it with sudo systemctl start docker",
    },
  );
  for (const answer of [
    "",
    "true",
    "/run/podman.sock",
    "/run/podman.sock yes",
  ]) {
    state.podmanSocket = answer;
    await assert.rejects(engineSocketHanded(podman, engine, undefined), {
      message: `podman answered "${answer}" when asked where its socket is`,
    });
  }
  state.podmanSocket = undefined;
  await assert.rejects(engineSocketHanded(podman, engine, undefined), {
    message:
      "podman could not say where its socket is: Error: cannot connect to Podman",
  });
});
