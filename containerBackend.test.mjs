import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { containerBackend, containerName } from "./containerBackend.mjs";
import { deferred, fakeEngine } from "./engine.fixture.mjs";

const pool = { tenant: "vteng", project: "chuggy", pool: "shame" };
const image = "registry.chuggy.example/worker@sha256:" + "a".repeat(64);
const startMs = 1_800_000_000_000;

/** @param {Partial<import("@chuggy/worker-contract/workerPool").WorkerPoolAssignment>} overrides */
function assignment(overrides = {}) {
  return {
    assignment: "asg-1",
    capabilities: ["container"],
    image,
    cpuMillis: 2000,
    memoryMib: 4096,
    deadlineSecs: 3600,
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer-secret",
    ...overrides,
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Partial<import("./containerBackend.mjs").ContainerBackendSettings>} overrides
 */
async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = join(directory, "claude-token");
  await writeFile(tokenFile, "claude-token-fixture", { mode: 0o600 });
  const { engine, state } = fakeEngine();
  const clock = { nowMs: startMs };
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const invalidated = [];
  let minted = 0;
  const settings = {
    engine: /** @type {const} */ ("docker"),
    pool,
    tokenFile,
    tokenReaderUid: process.getuid?.() ?? -1,
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    environment: { GIT_AUTHOR_NAME: "chuggy" },
    network: "chuggy-jobs",
    runtimeDir: join(directory, "runtime"),
    logDir: join(directory, "logs"),
    machine: { cpuMillis: 8000, memoryMib: 16384 },
    pullRetryMs: 5000,
    ...overrides,
  };
  const backend = containerBackend(settings, {
    engine,
    tokens: {
      acquire: async () => ({
        acquired: "Token",
        token: `pool-token-${String(++minted)}`,
      }),
      invalidate: (token) => invalidated.push(token),
    },
    nowMs: () => clock.nowMs,
    sleep: async (ms) => {
      clock.nowMs += ms;
    },
    log: (line) => log.push(line),
  });
  return { backend, state, clock, log, invalidated, settings };
}

/** @param {ReturnType<typeof fakeEngine>["state"]} state */
const verbs = (state) => state.calls.map((call) => call.argv[0]);

/**
 * A container a predecessor started, as the engine lists it.
 *
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {string} id
 * @param {string} status
 * @param {number} deadlineEpochSecs
 * @param {string} name
 */
function seeded(
  state,
  id,
  status,
  deadlineEpochSecs,
  name = containerName(pool.pool, id),
) {
  state.containers.set(name, {
    id: `id-${id}`,
    name,
    status,
    image,
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.assignment": id,
      "io.chuggy.deadline": String(deadlineEpochSecs),
    },
  });
  return name;
}

test("a slow pull keeps the assignment held, and the container it starts is held after it", async (t) => {
  const { backend, state, settings } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;

  assert.deepEqual(await backend.place(assignment()), { placed: "Placed" });
  await setImmediate();
  assert.deepEqual(await backend.held(), ["asg-1"]);
  assert.equal(backend.inFlight()[0]?.phase, "Pulling");

  state.images.add(image);
  pull.resolve({ code: 0, stdout: "", stderr: "" });
  await backend.settled();

  const name = containerName(pool.pool, "asg-1");
  assert.deepEqual(state.containers.get(name)?.labels, {
    "io.chuggy.pool": "vteng/chuggy/shame",
    "io.chuggy.assignment": "asg-1",
    "io.chuggy.deadline": String(startMs / 1000 + 3600),
  });
  assert.deepEqual(backend.inFlight(), []);
  assert.deepEqual(await backend.held(), ["asg-1"]);
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a job's env file carries the envelope and the environment, and is gone once run answers", async (t) => {
  const { backend, state, settings } = await harness(t);
  state.images.add(image);
  await backend.place(assignment());
  await backend.settled();

  const run = state.calls.find((call) => call.argv[0] === "run");
  const [task, ...rest] = (run?.envFile ?? "").split("\n");
  assert.deepEqual(JSON.parse(task.replace(/^CHUG_WORKER_TASK=/u, "")), {
    callbackUrl: "https://chuggy.example/worker",
    bearer: "attempt-bearer-secret",
    workspace: "/workspace",
    timeoutSecsMax: 7200,
    outputBytesMax: 1024 * 1024,
    providerCredentialFile: "/var/run/chuggy/credentials/claude-code",
  });
  assert.deepEqual(rest, ["GIT_AUTHOR_NAME=chuggy", ""]);
  assert.ok(
    !run?.argv.some((argument) => argument.includes("attempt-bearer-secret")),
  );
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a present image is not pulled", async (t) => {
  const { backend, state } = await harness(t);
  state.images.add(image);
  await backend.place(assignment());
  await backend.settled();
  assert.deepEqual(verbs(state), ["image", "run"]);
});

test("a pull that fails drops out of held and is logged", async (t) => {
  const { backend, state, log, settings } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: `Error response from daemon: manifest for ${image} not found: manifest unknown: manifest unknown\n`,
  });
  await backend.place(assignment());
  await backend.settled();
  assert.deepEqual(await backend.held(), []);
  assert.match(
    log.join("\n"),
    /was not started: its image could not be pulled: Error response from daemon: manifest for/u,
  );
  assert.ok(!verbs(state).includes("run"));
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

/** @param {string} authFile */
function pulledAs(authFile) {
  const document = JSON.parse(authFile);
  const [host] = Object.keys(document.auths);
  return [
    host,
    Buffer.from(document.auths[host].auth, "base64").toString("utf8"),
  ];
}

test("a pull the registry refused is made again under a fresh token", async (t) => {
  const { backend, state, invalidated, settings } = await harness(t);
  let pulls = 0;
  state.pull = (pulledImage) => {
    pulls += 1;
    if (pulls === 1)
      return {
        code: 1,
        stdout: "",
        stderr:
          'Error response from daemon: Head "https://registry.chuggy.example/v2/worker/manifests/sha256:aaaa": unauthorized: authentication required\n',
      };
    state.images.add(pulledImage);
    return { code: 0, stdout: "", stderr: "" };
  };
  await backend.place(assignment());
  await backend.settled();

  const pullCalls = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(
    pullCalls.map((call) => pulledAs(call.authFile ?? "{}")),
    [
      ["registry.chuggy.example", "chuggy-pool:pool-token-1"],
      ["registry.chuggy.example", "chuggy-pool:pool-token-2"],
    ],
  );
  assert.deepEqual(invalidated, ["pool-token-1"]);
  assert.ok(verbs(state).includes("run"));
  assert.deepEqual(await readdir(settings.runtimeDir), []);
});

test("a pull refused until the deadline gives up there", async (t) => {
  const { backend, state, invalidated, log } = await harness(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error response from daemon: unauthorized\n",
  });
  await backend.place(assignment({ deadlineSecs: 12 }));
  await backend.settled();
  assert.deepEqual(invalidated, [
    "pool-token-1",
    "pool-token-2",
    "pool-token-3",
  ]);
  assert.match(
    log.at(-1) ?? "",
    /was not started: its image was not pulled by the assignment's deadline$/u,
  );
  assert.deepEqual(await backend.held(), []);
});

test("a pull's credential directory is owner-only while the pull runs", async (t) => {
  const { backend, state } = await harness(t);
  /** @type {number[]} */
  const modes = [];
  state.pull = async (pulledImage, call) => {
    modes.push((await stat(call.environment.DOCKER_CONFIG)).mode & 0o777);
    modes.push(
      (await stat(join(call.environment.DOCKER_CONFIG, "config.json"))).mode &
        0o777,
    );
    state.images.add(pulledImage);
    return { code: 0, stdout: "", stderr: "" };
  };
  await backend.place(assignment());
  await backend.settled();
  assert.deepEqual(modes, [0o700, 0o600]);
});

test("a repeated placement is placed once, in flight and after its container runs", async (t) => {
  const { backend, state, log } = await harness(t);
  const pull = deferred();
  state.pull = () => pull.promise;
  await backend.place(assignment());
  assert.deepEqual(await backend.place(assignment()), { placed: "Placed" });
  state.images.add(image);
  pull.resolve({ code: 0, stdout: "", stderr: "" });
  await backend.settled();

  assert.deepEqual(await backend.place(assignment()), { placed: "Placed" });
  await backend.settled();
  assert.equal(state.containers.size, 1);
  assert.equal(verbs(state).filter((verb) => verb === "pull").length, 1);
  assert.match(log.at(-1) ?? "", /was already running$/u);
  assert.ok(
    !log.some((line) => line.includes("was not started")),
    log.join("\n"),
  );
});

test("a name another assignment holds is a placement that failed", async (t) => {
  const { backend, state, log } = await harness(t);
  state.images.add(image);
  seeded(
    state,
    "asg-other",
    "running",
    startMs / 1000 + 60,
    containerName(pool.pool, "asg-1"),
  );
  await backend.place(assignment());
  await backend.settled();
  assert.match(
    log.at(-1) ?? "",
    /was not started: its container could not be run: .*is already in use/u,
  );
});

test("a running container past its deadline is killed, its logs saved, and removed", async (t) => {
  const { backend, state, clock, settings } = await harness(t);
  const name = seeded(state, "asg-late", "running", startMs / 1000 + 10);
  clock.nowMs += 10_000;
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual(verbs(state), ["ps", "container", "kill", "logs", "rm"]);
  assert.deepEqual(state.calls.at(-1)?.argv, ["rm", "-v", "id-asg-late"]);
  const saved = join(settings.logDir, `${name}.log`);
  assert.equal(await readFile(saved, "utf8"), `the log of ${name}\n`);
  assert.equal((await stat(saved)).mode & 0o777, 0o600);
});

for (const status of ["exited", "dead", "created"])
  test(`a container left ${status} has its logs saved and is removed`, async (t) => {
    const { backend, state, settings } = await harness(t);
    const name = seeded(state, "asg-done", status, startMs / 1000 + 60);
    assert.deepEqual(await backend.held(), []);
    assert.equal(state.containers.size, 0);
    assert.ok(verbs(state).every((verb) => verb !== "kill"));
    assert.equal(
      await readFile(join(settings.logDir, `${name}.log`), "utf8"),
      `the log of ${name}\n`,
    );
  });

test("an ended container whose logs could not be saved is kept for the next pass", async (t) => {
  const { backend, state, log } = await harness(t);
  seeded(state, "asg-done", "exited", startMs / 1000 + 60);
  state.logsFail = true;
  assert.deepEqual(await backend.held(), []);
  assert.equal(state.containers.size, 1);
  assert.match(log.join("\n"), /ended; its logs could not be saved/u);
});

test("a running container inside its deadline is held", async (t) => {
  const { backend, state } = await harness(t);
  seeded(state, "asg-2", "running", startMs / 1000 + 60);
  assert.deepEqual(await backend.held(), ["asg-2"]);
});

test("a listing that failed throws rather than answering nothing held", async (t) => {
  const { backend, state } = await harness(t);
  state.unreachable = true;
  await assert.rejects(
    backend.held(),
    /docker could not list this pool's containers: Cannot connect to the Docker daemon/u,
  );
});

test("a stop of an in-flight placement cancels its pull, and nothing is run", async (t) => {
  const { backend, state, log } = await harness(t);
  state.pull = () => new Promise(() => undefined);
  await backend.place(assignment());
  await setImmediate();
  assert.deepEqual(await backend.stop("asg-1"), { stopped: "Stopped" });
  assert.deepEqual(backend.inFlight(), []);
  assert.deepEqual(await backend.held(), []);
  assert.ok(!verbs(state).includes("run"));
  assert.match(log.join("\n"), /was stopped before it started/u);
});

test("a stop of a running container removes it with its volumes", async (t) => {
  const { backend, state } = await harness(t);
  const name = seeded(state, "asg-2", "running", startMs / 1000 + 60);
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
  assert.deepEqual(state.calls.at(-1)?.argv, ["rm", "-f", "-v", name]);
  assert.equal(state.containers.size, 0);
  assert.deepEqual(await backend.stop("asg-2"), { stopped: "Stopped" });
});

test("a stop the engine could not be reached for is unavailable", async (t) => {
  const { backend, state } = await harness(t);
  state.unreachable = true;
  assert.deepEqual(await backend.stop("asg-2"), {
    stopped: "Unavailable",
    evidence: "the container engine could not be reached to stop this workload",
  });
});

test("what this machine cannot take is refused, naming no value of the envelope", async (t) => {
  const { backend, state } = await harness(t);
  const refusals = [
    [assignment({ image: undefined }), /pins no image/u],
    [
      assignment({ cpuMillis: 8001 }),
      /8001 CPU millis and this machine has 8000/u,
    ],
    [assignment({ memoryMib: 16385 }), /16385 MiB and this machine has 16384/u],
    [
      assignment({ callbackUrl: "attempt-bearer-secret" }),
      /makes no envelope a job can read: callbackUrl$/u,
    ],
    [assignment({ bearer: "" }), /makes no envelope a job can read: bearer$/u],
  ];
  for (const [refused, evidence] of refusals) {
    const placed = await backend.place(/** @type {any} */ (refused));
    assert.equal(placed.placed, "Refused");
    assert.match(placed.evidence ?? "", evidence);
    assert.ok(!(placed.evidence ?? "").includes("attempt-bearer-secret"));
  }
  assert.deepEqual(state.calls, []);
});

test("an assignment is refused while the Claude token file cannot be handed to a job", async (t) => {
  const { backend, settings } = await harness(t);
  await writeFile(settings.tokenFile, "");
  const placed = await backend.place(assignment());
  assert.deepEqual(placed, {
    placed: "Refused",
    evidence: `the Claude token file ${settings.tokenFile} is empty`,
  });
});

test("a container's deadline is the assignment's, capped at the runner's", async (t) => {
  const { backend, state } = await harness(t, { timeoutSecsMax: 600 });
  state.images.add(image);
  await backend.place(assignment());
  await backend.settled();
  const [container] = state.containers.values();
  assert.equal(
    container.labels["io.chuggy.deadline"],
    String(startMs / 1000 + 600),
  );
});
