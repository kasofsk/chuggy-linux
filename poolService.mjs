/**
 * The service answering for a pool on this machine, found by where it
 * listens. A pool's service listens in the pool's own runtime directory. A
 * service still running a runner from before pools had their own listens in
 * the runtime directory's root until it restarts, and is this pool's when the
 * legacy unit serves a file naming this pool.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import { controlAsked, controlSocketPath } from "./control.mjs";
import { poolIdentitySame } from "./poolIdentity.mjs";
import { poolRuntimeDirectory, runtimeDirectory } from "./runner.mjs";
import { legacyServiceUnitName, unitPoolFile } from "./systemdUnit.mjs";

/**
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {object} PoolServiceSockets
 * @property {string} own where the pool's service listens
 * @property {string | undefined} legacy where a legacy service serving this pool listens
 */

/**
 * A unit file's text, or nothing where there is no such file.
 *
 * @param {string} unit
 */
export async function serviceUnitText(unit) {
  try {
    return await readFile(unit, "utf8");
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT")
      return undefined;
    throw failure;
  }
}

/**
 * The legacy unit's file, where it serves a file naming this pool. A pool
 * file it names that cannot be read names no pool.
 *
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 * @returns {Promise<string | undefined>}
 */
export async function legacyServiceUnit(paths, identity) {
  const unit = join(paths.units, legacyServiceUnitName);
  const text = await serviceUnitText(unit);
  const served = text === undefined ? undefined : unitPoolFile(text);
  if (served === undefined) return undefined;
  const named = await poolCredentials(served).catch(() => undefined);
  return named !== undefined && poolIdentitySame(named, identity)
    ? unit
    : undefined;
}

/**
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 * @returns {Promise<PoolServiceSockets>}
 */
export async function poolServiceSockets(paths, identity) {
  return {
    own: controlSocketPath(poolRuntimeDirectory(paths, identity)),
    legacy:
      (await legacyServiceUnit(paths, identity)) === undefined
        ? undefined
        : controlSocketPath(runtimeDirectory(paths)),
  };
}

/**
 * Asks the service answering for the pool, answering nothing when none is
 * running.
 *
 * @param {PoolServiceSockets} sockets
 * @param {import("./control.mjs").ControlRequest} request
 * @returns {Promise<unknown>}
 */
export async function poolServiceAsked(sockets, request) {
  const answered = await controlAsked(sockets.own, request);
  if (answered !== undefined || sockets.legacy === undefined) return answered;
  return controlAsked(sockets.legacy, request);
}
