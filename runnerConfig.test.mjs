import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeTokenFileRefusal,
  runnerConfig,
  podmanRegistriesConf,
  runnerPaths,
} from "./runnerConfig.mjs";

const ownUid = process.getuid?.() ?? -1;

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const minimal = {
  claudeTokenFile: "/home/op/.config/chuggy-linux/claude-token",
  timeoutSecsMax: 3600,
  outputBytesMax: 65536,
};

/**
 * @param {string} directory
 * @param {unknown} document
 * @param {number} mode
 */
async function written(directory, document, mode = 0o600) {
  const file = join(directory, "runner.json");
  await writeFile(
    file,
    typeof document === "string" ? document : JSON.stringify(document),
    { mode },
  );
  await chmod(file, mode);
  return file;
}

test("a minimal file is read with every default", async (t) => {
  const file = await written(await scratch(t), minimal);
  assert.deepEqual(await runnerConfig(file), {
    ...minimal,
    engine: "docker",
    concurrencyMax: 1,
    sessionsMax: 2,
    environment: {},
    network: "chuggy-jobs",
  });
});

test("sessionsMax is a whole number of none or more, read apart from concurrencyMax", async (t) => {
  const directory = await scratch(t);
  for (const sessionsMax of [0, 5])
    assert.deepEqual(
      await runnerConfig(
        await written(directory, {
          ...minimal,
          concurrencyMax: 3,
          sessionsMax,
        }),
      ),
      {
        ...minimal,
        engine: "docker",
        concurrencyMax: 3,
        sessionsMax,
        environment: {},
        network: "chuggy-jobs",
      },
    );
  for (const [sessionsMax, why] of [
    [-1, "Too small: expected number to be >=0"],
    [1.5, "Invalid input: expected int, received number"],
    ["2", "Invalid input: expected number, received string"],
    [null, "Invalid input: expected number, received null"],
  ]) {
    const file = await written(directory, { ...minimal, sessionsMax });
    await assert.rejects(runnerConfig(file), {
      message: `runner configuration ${file}: sessionsMax ${why}`,
    });
  }
});

test("a file anyone but its owner can read or write is refused", async (t) => {
  const directory = await scratch(t);
  for (const mode of [0o640, 0o604, 0o620, 0o660]) {
    const file = await written(directory, minimal, mode);
    await assert.rejects(
      runnerConfig(file),
      new RegExp(
        `is mode ${mode.toString(8)}; only its owner may read or write it`,
        "u",
      ),
    );
  }
});

test("what the file may not say is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const refused = [
    [{ ...minimal, enigne: "podman" }, /Unrecognized key: "enigne"/u],
    [{ ...minimal, engine: "containerd" }, /engine /u],
    [
      { ...minimal, environment: { CHUG_WORKER_TASK: "{}" } },
      /environment\.CHUG_WORKER_TASK is the runner's to set/u,
    ],
    [
      { ...minimal, environment: { CLAUDE_CODE_OAUTH_TOKEN: "x" } },
      /environment\.CLAUDE_CODE_OAUTH_TOKEN is the runner's to set/u,
    ],
    [
      { ...minimal, environment: { NAME: "a\nB=c" } },
      /environment\.NAME may not break a line/u,
    ],
    [{ ...minimal, environment: { "1NAME": "a" } }, /environment\.1NAME/u],
    [{ ...minimal, network: "host" }, /network may not be the host's network/u],
    [{ ...minimal, network: "--privileged" }, /network /u],
    [
      { ...minimal, claudeTokenFile: "claude-token" },
      /claudeTokenFile must be an absolute path/u,
    ],
    [
      { ...minimal, claudeTokenFile: "/a,readonly=false" },
      /claudeTokenFile cannot be named in a bind mount/u,
    ],
    [{ ...minimal, concurrencyMax: 0 }, /concurrencyMax /u],
    [
      { claudeTokenFile: minimal.claudeTokenFile },
      /timeoutSecsMax .*; outputBytesMax /u,
    ],
    ["{", /is not JSON/u],
  ];
  for (const [document, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, document)),
      why,
      JSON.stringify(document),
    );
});

test("a directory is not a runner configuration", async (t) => {
  const directory = await scratch(t);
  await mkdir(join(directory, "runner.json"), { mode: 0o700 });
  await assert.rejects(
    runnerConfig(join(directory, "runner.json")),
    /is not a file/u,
  );
});

test("the runner's paths follow the XDG base directories, ignoring a relative one", () => {
  assert.deepEqual(runnerPaths({}, "/home/op"), {
    config: "/home/op/.config/chuggy-linux/runner.json",
    units: "/home/op/.config/systemd/user",
    pools: "/home/op/.config/chuggy/pools",
    logs: "/home/op/.local/state/chuggy-linux/logs",
    runtime: undefined,
  });
  assert.deepEqual(
    runnerPaths(
      {
        XDG_CONFIG_HOME: "/etc/op",
        XDG_STATE_HOME: "state",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      "/home/op",
    ),
    {
      config: "/etc/op/chuggy-linux/runner.json",
      units: "/etc/op/systemd/user",
      pools: "/etc/op/chuggy/pools",
      logs: "/home/op/.local/state/chuggy-linux/logs",
      runtime: "/run/user/1000/chuggy-linux",
    },
  );
});

test("a Claude token file a job cannot be handed is refused", async (t) => {
  const directory = await scratch(t);
  const file = join(directory, "claude-token");
  /** @param {string} path */
  const refusal = async (path, uid = ownUid) =>
    (await claudeTokenFileRefusal(path, "podman", uid)) ?? "";
  assert.match(await refusal(file), /cannot be found/u);
  await writeFile(file, "", { mode: 0o600 });
  assert.match(await refusal(file), /is empty/u);
  await writeFile(file, "claude-token-fixture");
  assert.equal(await claudeTokenFileRefusal(file, "podman", ownUid), undefined);
  assert.match(
    await refusal(file, ownUid + 1),
    new RegExp(
      `owned by uid ${String(ownUid)}, not by this runner's uid ${String(ownUid + 1)}`,
      "u",
    ),
  );
  await chmod(file, 0o640);
  assert.match(await refusal(file), /is mode 640/u);
  assert.match(await refusal(directory), /is not a file/u);
});

test("under docker only a runner that is uid 1000 can hand a job its token file", async (t) => {
  const file = join(await scratch(t), "claude-token");
  assert.match(
    (await claudeTokenFileRefusal(file, "docker", 1234)) ?? "",
    /docker runs a job as uid 1000, and this runner is uid 1234.*use rootless podman/u,
  );
  assert.match(
    (await claudeTokenFileRefusal(file, "docker", 1000)) ?? "",
    /cannot be found/u,
  );
});

test("podman's registries.conf is sought wherever a supported podman reads it as this uid, the user's under both config homes", () => {
  const system = ["/usr/share/containers", "/etc/containers"].flatMap(
    (root) => [
      `${root}/registries.conf`,
      `${root}/registries.conf.d`,
      `${root}/registries.rootless.conf.d`,
      `${root}/registries.rootless.conf.d/1234`,
    ],
  );
  assert.deepEqual(
    podmanRegistriesConf({ XDG_CONFIG_HOME: "/etc/op" }, "/home/op", 1234),
    [
      ...system,
      "/etc/op/containers/registries.conf",
      "/etc/op/containers/registries.conf.d",
      "/home/op/.config/containers/registries.conf",
      "/home/op/.config/containers/registries.conf.d",
    ],
  );
  assert.deepEqual(podmanRegistriesConf({}, "/home/op", 1234), [
    ...system,
    "/home/op/.config/containers/registries.conf",
    "/home/op/.config/containers/registries.conf.d",
  ]);
  assert.deepEqual(podmanRegistriesConf({}, "/root", 0), [
    "/usr/share/containers/registries.conf",
    "/usr/share/containers/registries.conf.d",
    "/usr/share/containers/registries.rootful.conf.d",
    "/etc/containers/registries.conf",
    "/etc/containers/registries.conf.d",
    "/etc/containers/registries.rootful.conf.d",
    "/root/.config/containers/registries.conf",
    "/root/.config/containers/registries.conf.d",
  ]);
});

test("a registries.conf the environment names is sought before the rest", () => {
  const found = podmanRegistriesConf(
    {
      CONTAINERS_REGISTRIES_CONF: "/tmp/r.conf",
      REGISTRIES_CONFIG_PATH: "/tmp/old.conf",
      CONTAINERS_REGISTRIES_CONF_OVERRIDE: "/tmp/over.conf",
    },
    "/home/op",
    1234,
  );
  assert.deepEqual(found.slice(0, 3), [
    "/tmp/r.conf",
    "/tmp/old.conf",
    "/tmp/over.conf",
  ]);
  assert.deepEqual(found.slice(3), podmanRegistriesConf({}, "/home/op", 1234));
  assert.deepEqual(
    podmanRegistriesConf({ CONTAINERS_REGISTRIES_CONF: "" }, "/home/op", 1234),
    podmanRegistriesConf({}, "/home/op", 1234),
  );
});
