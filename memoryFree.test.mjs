import assert from "node:assert/strict";
import test from "node:test";

import { heldCreateArgv } from "@chuggy/worker-core/engineArgv.mjs";

import { fakeEngine } from "./engine.fixture.mjs";
import { memoryBudgetSaid, memoryFreeBytes } from "./memoryFree.mjs";

const gib = 2 ** 30;

/**
 * A runner's file keeping `memoryFreeGibMin` free on docker.
 *
 * @param {number} memoryFreeGibMin
 */
const config = (memoryFreeGibMin) =>
  /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
    /** @type {unknown} */ ({ engine: "docker", memoryFreeGibMin })
  );

/**
 * An engine whose containers outside every pool use `usedGib`, holding
 * `held` jobs of 2 GiB each, held for room or starting.
 *
 * @param {number} usedGib
 * @param {number} [held]
 * @param {boolean} [starting]
 */
async function engineUsing(usedGib, held = 0, starting = false) {
  const { engine, state } = fakeEngine();
  state.containers.set("chuggy-jobs-postgres", {
    id: "id-postgres",
    name: "chuggy-jobs-postgres",
    labels: {},
    status: "running",
    image: "postgres",
    usedBytes: usedGib * gib,
  });
  for (let index = 0; index < held; index += 1)
    await engine.exec(
      heldCreateArgv({
        name: `chuggy-other-${String(index)}-held`,
        pool: "vteng/chuggy/other",
        assignment: `asg-${String(index)}`,
        memoryMib: 2048,
        heldMs: index,
        pid: process.pid,
        untilMs: Date.now() + 3_600_000,
        starting,
      }),
    );
  return { engine, state };
}

test("what the file keeps free is its GiB in bytes", () => {
  assert.equal(memoryFreeBytes(config(2)), 2 * gib);
  assert.equal(memoryFreeBytes(config(0)), 0);
});

test("status says the room, the budget and the budget's state, or why it could not be counted", async () => {
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4)).engine),
    "10 GiB room · 14 GiB budget · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(0), (await engineUsing(4)).engine),
    "12 GiB room · 16 GiB budget · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(13.75)).engine),
    "0.3 GiB room · 14 GiB budget · Full",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 2)).engine),
    "6 GiB room · 14 GiB budget · Held",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 1, true)).engine),
    "8 GiB room · 14 GiB budget · Starting",
  );
  assert.equal(
    await memoryBudgetSaid(
      config(2),
      (await engineUsing(4, 1)).engine,
      () => false,
    ),
    "10 GiB room · 14 GiB budget · Taking",
  );
  const { engine, state } = await engineUsing(4);
  state.unreachable = true;
  assert.equal(
    await memoryBudgetSaid(config(2), engine),
    "Unknown · docker could not say how much memory it has: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  );
});

test("status says where what no runner capped was counted at none, since the engine refused its stats", async () => {
  const { engine } = await engineUsing(4);
  const refusing = {
    ...engine,
    /** @type {typeof engine.exec} */
    exec: async (argv, options) =>
      argv[0] === "stats"
        ? {
            code: 125,
            stdout: "",
            stderr:
              "Error: stats is not supported in rootless mode without cgroups v2\n",
          }
        : engine.exec(argv, options),
  };
  assert.equal(
    await memoryBudgetSaid(config(0), refusing),
    "16 GiB room · 16 GiB budget · Taking · uncapped use unmeasured",
  );
});
