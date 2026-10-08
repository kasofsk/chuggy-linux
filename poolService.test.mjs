import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { controlSocketPath } from "@chuggy/worker-core/control.mjs";
import { controlServed } from "./control.fixture.mjs";
import {
  legacyService,
  poolFileServiceUnits,
  poolServiceAsked,
  poolServiceSockets,
} from "./poolService.mjs";
import { poolRuntimeDirectory, runtimeDirectory } from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { fixturePool, poolFileWritten } from "./runner.fixture.mjs";
import { serviceUnit } from "./systemdUnit.mjs";

/**
 * A home under /tmp, whose runtime directory is short enough for a socket.
 *
 * @param {import("node:test").TestContext} t
 */
async function machine(t) {
  const home = await mkdtemp("/tmp/chuggy-linux-service-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = runnerPaths(
    { XDG_CONFIG_HOME: join(home, "c"), XDG_RUNTIME_DIR: join(home, "r") },
    home,
  );
  await mkdir(paths.units, { recursive: true });
  return { home, paths };
}

const other = { ...fixturePool, tenant: "newtenant", project: "arbbot" };

test("the legacy unit is this pool's where the file it serves names this pool, whatever the file, and may be where it cannot be read", async (t) => {
  const { home, paths } = await machine(t);
  const unit = join(paths.units, "chuggy-linux.service");
  const written = async (/** @type {string} */ text) => writeFile(unit, text);
  assert.equal(await legacyService(paths, fixturePool), undefined);

  const file = await poolFileWritten(
    join(home, "vteng-chuggy-shame.json"),
    fixturePool,
  );
  await written(serviceUnit({ node: "/n", cli: "/c", poolFile: file }));
  assert.deepEqual(await legacyService(paths, fixturePool), {
    unit,
    file,
    serves: "ThisPool",
  });
  assert.equal(await legacyService(paths, other), undefined);

  await chmod(file, 0o644);
  assert.deepEqual(await legacyService(paths, fixturePool), {
    unit,
    file,
    serves: "Unread",
  });
  await rm(file);
  assert.deepEqual(await legacyService(paths, other), {
    unit,
    file,
    serves: "Unread",
  });

  await written("[Service]\nExecStart=/usr/bin/true\n");
  assert.equal(await legacyService(paths, fixturePool), undefined);
});

test("the units serving a pool file are its own and the legacy one, where each names exactly that file", async (t) => {
  const { home, paths } = await machine(t);
  const file = join(home, "vteng.chuggy.shame.json");
  assert.deepEqual(await poolFileServiceUnits(paths, file), []);
  const own = join(paths.units, "chuggy-linux-vteng.chuggy.shame.service");
  const legacy = join(paths.units, "chuggy-linux.service");
  await writeFile(
    legacy,
    serviceUnit({ node: "/n", cli: "/c", poolFile: `${file}.old` }),
  );
  assert.deepEqual(await poolFileServiceUnits(paths, file), []);
  await writeFile(own, serviceUnit({ node: "/n", cli: "/c", poolFile: file }));
  assert.deepEqual(await poolFileServiceUnits(paths, file), [
    "chuggy-linux-vteng.chuggy.shame.service",
  ]);
  await writeFile(
    legacy,
    serviceUnit({ node: "/n", cli: "/c", poolFile: file }),
  );
  assert.deepEqual(await poolFileServiceUnits(paths, file), [
    "chuggy-linux-vteng.chuggy.shame.service",
    "chuggy-linux.service",
  ]);
});

test("a pool's service is asked at its own socket, then at the legacy one only where the legacy unit serves the pool", async (t) => {
  const { home, paths } = await machine(t);
  /** @type {import("@chuggy/worker-core/control.mjs").ControlRequest} */
  const stop = { op: "stop", assignment: "asg-1" };
  const own = await poolServiceSockets(paths, fixturePool);
  assert.deepEqual(own, {
    own: controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
    legacy: undefined,
  });
  assert.equal(await poolServiceAsked(own, stop), undefined);

  const root = controlSocketPath(runtimeDirectory(paths));
  const legacy = await controlServed(
    t,
    controlSocketPath(runtimeDirectory(paths)),
  );
  assert.equal(await poolServiceAsked(own, stop), undefined);
  const file = await poolFileWritten(join(home, "pool.json"), fixturePool);
  await writeFile(
    join(paths.units, "chuggy-linux.service"),
    serviceUnit({ node: "/n", cli: "/c", poolFile: file }),
  );
  const sockets = await poolServiceSockets(paths, fixturePool);
  assert.deepEqual(sockets.legacy, { socket: root, serves: "ThisPool" });
  assert.deepEqual(await poolServiceAsked(sockets, stop), {
    stopped: "Stopped",
  });
  assert.deepEqual(legacy.stopped, ["asg-1"]);
  assert.equal((await poolServiceSockets(paths, other)).legacy, undefined);

  await chmod(file, 0o644);
  const unread = await poolServiceSockets(paths, other);
  assert.deepEqual(unread.legacy, { socket: root, serves: "Unread" });
  assert.equal(await poolServiceAsked(unread, stop), undefined);
  assert.deepEqual(legacy.stopped, ["asg-1"]);
  await chmod(file, 0o600);

  const served = await controlServed(t, sockets.own);
  await poolServiceAsked(sockets, stop);
  assert.deepEqual(served.stopped, ["asg-1"]);
  assert.deepEqual(legacy.stopped, ["asg-1"]);
});
