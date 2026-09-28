import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  jobNetwork,
  runnerDirectories,
  runnerLoop,
  runnerParts,
  runnerSetup,
} from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { runnerFixture } from "./runner.fixture.mjs";

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
  const runner = runnerParts(setup, { uid: 1000, log: () => undefined });
  assert.equal(runner.client.settings.concurrencyMax, 3);
  assert.deepEqual(runner.backend.inFlight(), []);
  const bare = await runnerSetup(
    poolFile,
    { XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME },
    home,
  );
  assert.throws(
    () => runnerParts(bare, { uid: 1000, log: () => undefined }),
    /XDG_RUNTIME_DIR is not set/u,
  );
});
