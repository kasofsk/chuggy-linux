import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";

import { diskFloorSaid, diskFreePorts, engineDiskFree } from "./diskFree.mjs";
import { fakeDisk, fakeEngine, fakeEngineMachine } from "./engine.fixture.mjs";

const gib = 2 ** 30;

/** @param {Record<string, unknown> | undefined} info */
function engineSaying(info) {
  const { engine, state } = fakeEngine();
  state.info = info;
  return engine;
}

const dockerInfo = {
  DockerRootDir: "/srv/docker",
  Name: fakeEngineMachine,
  Driver: "overlay2",
  DriverStatus: [["Backing Filesystem", "extfs"]],
};

const podmanInfo = {
  host: { hostname: fakeEngineMachine },
  store: {
    graphRoot: "/home/op/.local/share/containers/storage",
    volumePath: "/data/volumes",
  },
};

test("docker's free disk is its root directory's, and containerd's beside it where its images are stored through containerd, the lower of them", async () => {
  const rooted = fakeDisk(40);
  assert.deepEqual(
    await engineDiskFree("docker", engineSaying(dockerInfo), rooted),
    { free: 40 * gib, where: "/srv/docker" },
  );
  assert.deepEqual(rooted.measured, ["/srv/docker"]);
  const snapshotter = {
    ...dockerInfo,
    Driver: "overlayfs",
    DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
  };
  const both = fakeDisk(40, { "/var/lib/containerd": 12.5 });
  assert.deepEqual(
    await engineDiskFree("docker", engineSaying(snapshotter), both),
    { free: 12.5 * gib, where: "/var/lib/containerd" },
  );
  assert.deepEqual(both.measured, ["/srv/docker", "/var/lib/containerd"]);
  assert.deepEqual(
    await engineDiskFree(
      "docker",
      engineSaying({ ...dockerInfo, DriverStatus: null }),
      fakeDisk(3),
    ),
    { free: 3 * gib, where: "/srv/docker" },
  );
});

test("podman's free disk is the lower of its graph root's and its volume path's, each measured once", async () => {
  const disk = fakeDisk(30, { "/data/volumes": 9 });
  assert.deepEqual(
    await engineDiskFree("podman", engineSaying(podmanInfo), disk),
    { free: 9 * gib, where: "/data/volumes" },
  );
  const shared = fakeDisk(30);
  const root = podmanInfo.store.graphRoot;
  assert.deepEqual(
    await engineDiskFree(
      "podman",
      engineSaying({
        ...podmanInfo,
        store: { graphRoot: root, volumePath: root },
      }),
      shared,
    ),
    { free: 30 * gib, where: root },
  );
  assert.deepEqual(shared.measured, [root]);
});

test("an engine naming another machine, one that cannot be asked or answers otherwise, and a path that cannot be measured, are unknown", async () => {
  const disk = fakeDisk(30);
  assert.deepEqual(
    await engineDiskFree(
      "docker",
      engineSaying({ ...dockerInfo, Name: "docker-desktop" }),
      disk,
    ),
    {
      unknown: `docker names its machine docker-desktop, not ${fakeEngineMachine}, so it stores what it holds on another machine's disk, such as a VM's`,
    },
  );
  assert.deepEqual(
    await engineDiskFree(
      "podman",
      engineSaying({ ...podmanInfo, host: { hostname: "podman-machine" } }),
      disk,
    ),
    {
      unknown: `podman names its machine podman-machine, not ${fakeEngineMachine}, so it stores what it holds on another machine's disk, such as a VM's`,
    },
  );
  assert.match(
    /** @type {{unknown: string}} */ (
      await engineDiskFree("docker", engineSaying(undefined), disk)
    ).unknown,
    /^docker could not be asked where it stores what it holds: Cannot connect to the Docker daemon/u,
  );
  for (const [name, info] of /** @type {const} */ ([
    ["docker", podmanInfo],
    ["podman", dockerInfo],
  ]))
    assert.deepEqual(await engineDiskFree(name, engineSaying(info), disk), {
      unknown: `${name} answered an info this runner cannot read`,
    });
  assert.deepEqual(disk.measured, []);
  assert.deepEqual(
    await engineDiskFree("docker", engineSaying(dockerInfo), {
      hostname: () => fakeEngineMachine,
      statfs: async (path) => {
        throw new Error(`EACCES: permission denied, statfs '${path}'`);
      },
    }),
    {
      unknown:
        "/srv/docker could not be measured: EACCES: permission denied, statfs '/srv/docker'",
    },
  );
});

test("the machine an engine names is held to this one's name as it is at each measurement", async () => {
  assert.equal(diskFreePorts.hostname, hostname);
  const disk = fakeDisk(30);
  const names = ["shame", fakeEngineMachine];
  const renamed = { ...disk, hostname: () => names.shift() ?? "" };
  const engine = engineSaying(dockerInfo);
  assert.deepEqual(await engineDiskFree("docker", engine, renamed), {
    unknown: `docker names its machine ${fakeEngineMachine}, not shame, so it stores what it holds on another machine's disk, such as a VM's`,
  });
  assert.deepEqual(await engineDiskFree("docker", engine, renamed), {
    free: 30 * gib,
    where: "/srv/docker",
  });
});

test("doctor and status say the free disk against the floor, warning where it is unmeasured or under, and none is held at 0", async () => {
  const engine = engineSaying(dockerInfo);
  /** @param {number} diskFreeGibMin */
  const config = (diskFreeGibMin) =>
    /** @type {import("./runnerConfig.mjs").RunnerConfig} */ ({
      engine: "docker",
      diskFreeGibMin,
    });
  const said = await Promise.all(
    /** @type {const} */ ([
      [20, 20],
      [20, 19.5],
      [20, 10],
      [20, 9.9],
      [0, 1],
    ]).map(([min, free]) => diskFloorSaid(config(min), engine, fakeDisk(free))),
  );
  assert.deepEqual(said, [
    {
      detail: "20 GiB free at /srv/docker, over the floor of 20 GiB",
      warning: false,
    },
    {
      detail:
        "19.5 GiB free at /srv/docker, under the floor of 20 GiB: the service removes the images it may and takes no job until it is over",
      warning: true,
    },
    {
      detail:
        "10 GiB free at /srv/docker, under the floor of 20 GiB: the service removes the images it may and takes no job until it is over",
      warning: true,
    },
    {
      detail:
        "9.9 GiB free at /srv/docker, under half the floor of 20 GiB: the service removes the images it may, and stops a job each pass it is still under half",
      warning: true,
    },
    {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
    },
  ]);
  assert.deepEqual(
    await diskFloorSaid(
      config(20),
      engineSaying({ ...dockerInfo, Name: "elsewhere" }),
      fakeDisk(50),
    ),
    {
      detail: `none held, since the free disk could not be measured: docker names its machine elsewhere, not ${fakeEngineMachine}, so it stores what it holds on another machine's disk, such as a VM's`,
      warning: true,
    },
  );
});
