/**
 * The memory budget a run keeps of its engine, which the worker core's
 * `memoryBudget.mjs` holds: the engine's memory less `memoryFreeGibMin`, and
 * what `status` says of it.
 */

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { fileLockHolderAlive } from "@chuggy/worker-core/fileLock.mjs";
import {
  memoryBudgetBytes,
  memoryCountMsMax,
  memoryCounted,
  memoryRoomBytes,
  memoryRoomMibMin,
} from "@chuggy/worker-core/memoryBudget.mjs";

/**
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 */

/**
 * What the runner's file keeps free of the engine's memory, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function memoryFreeBytes(config) {
  return config.memoryFreeGibMin * 2 ** 30;
}

/**
 * The engine's memory against the runner's budget, as `status` says it: the
 * room, the budget, and what holds the service from taking a job.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {(pid: number) => boolean} [holderAlive]
 */
export async function memoryBudgetSaid(
  config,
  engine,
  holderAlive = fileLockHolderAlive,
) {
  const { counted } = await memoryCounted({
    engine,
    name: config.engine,
    holderAlive,
    signal: globalThis.AbortSignal.timeout(memoryCountMsMax),
  });
  if ("unknown" in counted)
    return `none counted, so the service takes no job: ${counted.unknown}`;
  const bytesFree = memoryFreeBytes(config);
  const room = memoryRoomBytes(bytesFree, counted);
  const said = `${diskGib(Math.max(0, room))} GiB of room in a budget of ${diskGib(memoryBudgetBytes(bytesFree, counted))} GiB, the engine's ${diskGib(counted.engineBytes)} GiB less the ${String(config.memoryFreeGibMin)} GiB kept free`;
  const held = counted.holds.length;
  if (held > 0)
    return `${said}; ${String(held)} held for room on this engine, so the service takes no job until ${held === 1 ? "it starts" : "they start"}`;
  if (room < memoryRoomMibMin * 2 ** 20)
    return `${said}; under the ${diskGib(memoryRoomMibMin * 2 ** 20)} GiB a job needs, so the service takes no job until it has more`;
  return said;
}
