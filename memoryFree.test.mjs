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
 * `held` jobs of 2 GiB each.
 *
 * @param {number} usedGib
 * @param {number} [held]
 */
async function engineUsing(usedGib, held = 0) {
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
      }),
    );
  return { engine, state };
}

test("what the file keeps free is its GiB in bytes", () => {
  assert.equal(memoryFreeBytes(config(2)), 2 * gib);
  assert.equal(memoryFreeBytes(config(0)), 0);
});

test("status says the room in the budget, and why the service takes no job where it takes none", async () => {
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4)).engine),
    "10 GiB of room in a budget of 14 GiB, the engine's 16 GiB less the 2 GiB kept free",
  );
  assert.equal(
    await memoryBudgetSaid(config(0), (await engineUsing(4)).engine),
    "12 GiB of room in a budget of 16 GiB, the engine's 16 GiB less the 0 GiB kept free",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(13.75)).engine),
    "0.3 GiB of room in a budget of 14 GiB, the engine's 16 GiB less the 2 GiB kept free; under the 0.5 GiB a job needs, so the service takes no job until it has more",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 1)).engine),
    "8 GiB of room in a budget of 14 GiB, the engine's 16 GiB less the 2 GiB kept free; 1 held for room on this engine, so the service takes no job until it starts",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 2)).engine),
    "6 GiB of room in a budget of 14 GiB, the engine's 16 GiB less the 2 GiB kept free; 2 held for room on this engine, so the service takes no job until they start",
  );
  assert.equal(
    await memoryBudgetSaid(
      config(2),
      (await engineUsing(4, 1)).engine,
      () => false,
    ),
    "10 GiB of room in a budget of 14 GiB, the engine's 16 GiB less the 2 GiB kept free",
  );
  const { engine, state } = await engineUsing(4);
  state.unreachable = true;
  assert.equal(
    await memoryBudgetSaid(config(2), engine),
    "none counted, so the service takes no job: docker could not say how much memory it has: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  );
});
