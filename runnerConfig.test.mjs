import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeCredentialDescribed,
  claudeCredentialProviderVariables,
  claudeCredentialVariables,
} from "@chuggy/worker-core/claudeCredential.mjs";
import {
  chatHostConfigured,
  chatHostIdleSecs,
  chatHostMemoryBytes,
  chatHostSessionsMaxDefault,
  chatSessionMemoryBytesDefault,
} from "@chuggy/worker-core/chatHost.mjs";
import { ownerVolumeTargetsRefused } from "@chuggy/worker-core/containerBackend.mjs";
import {
  jobEngineSocketVariables,
  reservedJobVariables,
} from "@chuggy/worker-core/job.mjs";

import {
  credentialFileRefusal,
  runnerChatSettingsLine,
  runnerConfig,
  runnerCredentialDescribed,
  runnerCredentialsHanded,
  runnerConfigLimits,
  podmanRegistriesConf,
  runnerPaths,
  runnerPersonalIdleRefusal,
  runnerPoolLimits,
} from "./runnerConfig.mjs";

const ownUid = process.getuid?.() ?? -1;

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A file's limits, which name no Claude credential. */
const unnamed = { timeoutSecsMax: 3600, outputBytesMax: 65536 };

const minimal = {
  claudeTokenFile: "/home/op/.config/chuggy-linux/claude-token",
  ...unnamed,
};

/** A Claude credential of each kind, as a runner's file names one. */
const credentials = [
  {
    kind: "Subscription",
    tokenFile: "/home/op/.config/chuggy-linux/claude-token",
  },
  {
    kind: "ApiKey",
    apiKeyFile: "/home/op/.config/chuggy-linux/anthropic-api-key",
  },
  {
    kind: "Bedrock",
    region: "us-west-2",
    apiKeyFile: "/home/op/.config/chuggy-linux/bedrock-api-key",
  },
  {
    kind: "Bedrock",
    region: "us-west-2",
    credentialsFile: "/home/op/.aws/credentials",
    profile: "chuggy",
  },
  {
    kind: "Vertex",
    region: "us-east5",
    project: "chuggy-jobs",
    credentialsFile: "/home/op/.config/gcloud/chuggy-jobs.json",
  },
  {
    kind: "Foundry",
    resource: "chuggy-jobs",
    apiKeyFile: "/home/op/.config/chuggy-linux/foundry-api-key",
  },
];

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
    engineSocket: false,
    images: [],
    volumes: [],
    pools: {},
    autoUpdate: true,
    imageUnusedSecsMax: 604_800,
    diskFreeGibMin: 20,
    memoryFreeGibMin: 0,
    memoryReservedGib: 0,
  });
});

test("a job's image this runner pulled is kept a week unused unless the file says otherwise, and 0 keeps it", async (t) => {
  const directory = await scratch(t);
  for (const imageUnusedSecsMax of [0, 86_400])
    assert.equal(
      (
        await runnerConfig(
          await written(directory, { ...minimal, imageUnusedSecsMax }),
        )
      ).imageUnusedSecsMax,
      imageUnusedSecsMax,
    );
  for (const imageUnusedSecsMax of [-1, 1.5, "604800"])
    await assert.rejects(
      runnerConfig(
        await written(directory, { ...minimal, imageUnusedSecsMax }),
      ),
      /imageUnusedSecsMax/u,
    );
});

test("what the engine keeps free of its storage and of its memory, and what it reserves of that memory from jobs, is any whole GiB the file sets, 0 among them", async (t) => {
  const directory = await scratch(t);
  const most = Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30);
  for (const key of /** @type {const} */ ([
    "diskFreeGibMin",
    "memoryFreeGibMin",
    "memoryReservedGib",
  ])) {
    for (const gib of [0, 50, most])
      assert.equal(
        (
          await runnerConfig(
            await written(directory, { ...minimal, [key]: gib }),
          )
        )[key],
        gib,
      );
    for (const gib of [-1, 1.5, "20", most + 1])
      await assert.rejects(
        runnerConfig(await written(directory, { ...minimal, [key]: gib })),
        new RegExp(key, "u"),
      );
  }
});

test("the runner updates itself unless its file turns that off", async (t) => {
  const directory = await scratch(t);
  for (const autoUpdate of [true, false])
    assert.equal(
      (await runnerConfig(await written(directory, { ...minimal, autoUpdate })))
        .autoUpdate,
      autoUpdate,
    );
  for (const autoUpdate of ["false", 0, null]) {
    const file = await written(directory, { ...minimal, autoUpdate });
    await assert.rejects(runnerConfig(file), {
      message: new RegExp(
        `^runner configuration ${file}: autoUpdate Invalid input: expected boolean`,
        "u",
      ),
    });
  }
});

test("a file may declare what its machine meets, read as written, and a platform, a token no requirement can name, or one named twice is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const file = await written(directory, {
    ...minimal,
    capabilities: ["gpu", "Agent:Codex"],
  });
  assert.deepEqual((await runnerConfig(file)).capabilities, [
    "gpu",
    "Agent:Codex",
  ]);
  for (const [capabilities, why] of [
    [
      ["gpu", "Platform:Linux:Arm64"],
      /capabilities\.1 is a platform, which the runner finds of this machine/u,
    ],
    [["gpu", "gpu"], /capabilities\.1 is named by an earlier entry/u],
    [["no spaces"], /capabilities\.0 /u],
  ])
    await assert.rejects(
      runnerConfig(await written(directory, { ...minimal, capabilities })),
      why,
      JSON.stringify(capabilities),
    );
});

test("a job that pins no image is run in an image its owner lists", async (t) => {
  const images = [
    {
      image: "ghcr.io/owner/bazel:7",
      capabilities: ["Agent:Claude", "Tool:Bazel"],
    },
  ];
  const file = await written(await scratch(t), { ...minimal, images });
  assert.deepEqual((await runnerConfig(file)).images, images);
});

test("the volumes a job mounts are read as listed, each one a job may write unless it is marked read-only", async (t) => {
  const volumes = [
    { source: "cargo", target: "/home/runner/.cargo" },
    { source: "/srv/npm-cache", target: "/cache/npm", readonly: true },
    { source: "sccache", target: "/cache/sccache", scope: "project" },
  ];
  const file = await written(await scratch(t), { ...minimal, volumes });
  assert.deepEqual((await runnerConfig(file)).volumes, [
    { ...volumes[0], readonly: false },
    volumes[1],
    { ...volumes[2], readonly: false },
  ]);
});

test("a volume at or in any path chuggy keeps in a job's container is refused, naming the volume", async (t) => {
  const directory = await scratch(t);
  for (const path of ownerVolumeTargetsRefused)
    for (const [target, why] of [
      [path, `is ${path}`],
      [`${path}/cache`, `is in ${path}`],
    ]) {
      const file = await written(directory, {
        ...minimal,
        volumes: [
          { source: "/srv/cache", target: "/cache" },
          { source: "cargo", target },
        ],
      });
      await assert.rejects(runnerConfig(file), {
        message: `runner configuration ${file}: volumes.1.target ${why}, chuggy's own`,
      });
    }
});

test("a volume no mount can make as it is written is refused, naming the volume", async (t) => {
  const directory = await scratch(t);
  const refused = [
    [
      { ...minimal, volumes: [{ source: "cargo", target: "/" }] },
      /volumes\.0\.target may not be the container's root/u,
    ],
    [
      { ...minimal, volumes: [{ source: "cargo", target: "/cache/" }] },
      /volumes\.0\.target must be an absolute path in its normal form/u,
    ],
    [
      {
        ...minimal,
        volumes: [
          { source: "cargo", target: "/cache" },
          { source: "npm-cache", target: "/cache" },
        ],
      },
      /volumes\.1\.target is volume 0's target too/u,
    ],
    [
      { ...minimal, volumes: [{ source: "./cache", target: "/cache" }] },
      /volumes\.0\.source names neither a volume/u,
    ],
    [
      { ...minimal, volumes: [{ source: "/srv/a,b", target: "/cache" }] },
      /volumes\.0\.source cannot be named in a bind mount/u,
    ],
    [
      {
        ...minimal,
        volumes: [{ source: "cargo", target: "/cache", type: "volume" }],
      },
      /volumes\.0 Unrecognized key: "type"/u,
    ],
    [
      {
        ...minimal,
        volumes: [{ source: "/srv/cache", target: "/cache", scope: "project" }],
      },
      /volumes\.0\.source is a directory, and only a named volume can be one per project/u,
    ],
  ];
  for (const [document, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, document)),
      why,
      JSON.stringify(document),
    );
});

test("concurrencyMax may be 0 beside sessions, for a runner that takes sessions alone, and not where sessionsMax is 0 too", async (t) => {
  const directory = await scratch(t);
  for (const sessions of [{}, { sessionsMax: 1 }]) {
    const config = await runnerConfig(
      await written(directory, { ...minimal, concurrencyMax: 0, ...sessions }),
    );
    assert.equal(config.concurrencyMax, 0);
    assert.equal(config.sessionsMax, sessions.sessionsMax ?? 2);
  }
  const file = await written(directory, {
    ...minimal,
    concurrencyMax: 0,
    sessionsMax: 0,
  });
  await assert.rejects(runnerConfig(file), {
    message: `runner configuration ${file}: concurrencyMax is 0 and so is sessionsMax, so this runner would take no work`,
  });
});

test("a pool's entry in pools sets its own service's limits in place of the file's, each it names, and no other pool's", async (t) => {
  const pools = {
    "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 1 },
    "vteng.chuggy.builds": { sessionsMax: 0 },
  };
  const config = await runnerConfig(
    await written(await scratch(t), { ...minimal, concurrencyMax: 2, pools }),
  );
  assert.deepEqual(config.pools, pools);
  /** @type {[string, {concurrencyMax: number, sessionsMax: number}, string][]} */
  const cases = [
    [
      "vteng.chuggy.lead",
      { concurrencyMax: 0, sessionsMax: 1 },
      "concurrencyMax 0, sessionsMax 1, as pools.vteng.chuggy.lead sets them",
    ],
    [
      "vteng.chuggy.builds",
      { concurrencyMax: 2, sessionsMax: 0 },
      "concurrencyMax 2, sessionsMax 0, as pools.vteng.chuggy.builds sets them",
    ],
    [
      "vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2fmember",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
    [
      "vteng.chuggy",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
    [
      "constructor",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
  ];
  for (const [name, limits, line] of cases) {
    const poolFile = `/home/you/.config/chuggy/pools/${name}.json`;
    assert.deepEqual(runnerPoolLimits(config, poolFile, false), limits, name);
    assert.equal(runnerConfigLimits(config, poolFile, false), line, name);
  }
});

test("a personal runner holds no session whatever the file or its entry in pools sets, its limits name none, and one left no job is refused, naming the key that does it", async (t) => {
  const name = "vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2fmember";
  const poolFile = `/home/you/.config/chuggy/pools/${name}.json`;
  const directory = await scratch(t);
  /** @param {Record<string, unknown>} document */
  const read = async (document) =>
    runnerConfig(
      await written(await mkdtemp(join(directory, "c-")), {
        ...minimal,
        ...document,
      }),
    );
  const sessions = await read({
    concurrencyMax: 2,
    sessionsMax: 3,
    pools: { [name]: { sessionsMax: 4 } },
  });
  assert.deepEqual(runnerPoolLimits(sessions, poolFile, true), {
    concurrencyMax: 2,
    sessionsMax: 0,
  });
  assert.deepEqual(runnerPoolLimits(sessions, poolFile, false), {
    concurrencyMax: 2,
    sessionsMax: 4,
  });
  assert.equal(
    runnerConfigLimits(sessions, poolFile, true),
    "concurrencyMax 2",
  );
  const file = "/home/you/.config/chuggy-linux/runner.json";
  assert.equal(runnerPersonalIdleRefusal(sessions, file, poolFile), undefined);
  const own = await read({
    pools: { [name]: { concurrencyMax: 0, sessionsMax: 1 } },
  });
  assert.equal(
    runnerConfigLimits(own, poolFile, true),
    `concurrencyMax 0, as pools.${name} sets it`,
  );
  const remedy = `set pools.${name}.concurrencyMax above 0 and start its service again, or run your chats on a chat host (chuggy-linux register --chat) and disable this service`;
  assert.equal(
    runnerPersonalIdleRefusal(own, file, poolFile),
    `runner configuration ${file}: pools.${name}.concurrencyMax is 0, and a personal runner is handed no sessions, so this one would take no work; ${remedy}`,
  );
  assert.equal(
    runnerPersonalIdleRefusal(
      await read({ concurrencyMax: 0 }),
      file,
      poolFile,
    ),
    `runner configuration ${file}: concurrencyMax is 0, and a personal runner is handed no sessions, so this one would take no work; ${remedy}`,
  );
});

test("a pool's entry is refused where it leaves that pool's service no work, whichever limit it takes from the file, or names a key a pool's limits do not have", async (t) => {
  const directory = await scratch(t);
  const refusal =
    "pools.vteng.chuggy.lead leaves this pool's service concurrencyMax 0 and sessionsMax 0, so it would take no work";
  /** @type {[Record<string, unknown>, string][]} */
  const refused = [
    [
      {
        ...minimal,
        pools: { "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 0 } },
      },
      refusal,
    ],
    [
      {
        ...minimal,
        sessionsMax: 0,
        pools: { "vteng.chuggy.lead": { concurrencyMax: 0 } },
      },
      refusal,
    ],
    [
      {
        ...minimal,
        concurrencyMax: 0,
        sessionsMax: 1,
        pools: { "vteng.chuggy.lead": { sessionsMax: 0 } },
      },
      refusal,
    ],
    [
      { ...minimal, pools: { "vteng.chuggy.lead": { timeoutSecsMax: 60 } } },
      'pools.vteng.chuggy.lead Unrecognized key: "timeoutSecsMax"',
    ],
    [
      { ...minimal, pools: { "vteng.chuggy.lead": { concurrencyMax: -1 } } },
      "pools.vteng.chuggy.lead.concurrencyMax Too small: expected number to be >=0",
    ],
  ];
  for (const [document, why] of refused) {
    const file = await written(directory, document);
    await assert.rejects(runnerConfig(file), {
      message: `runner configuration ${file}: ${why}`,
    });
  }
  const file = await written(directory, {
    ...minimal,
    concurrencyMax: 0,
    sessionsMax: 1,
    pools: { "vteng.chuggy.builds": { concurrencyMax: 2, sessionsMax: 0 } },
  });
  assert.deepEqual((await runnerConfig(file)).pools, {
    "vteng.chuggy.builds": { concurrencyMax: 2, sessionsMax: 0 },
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
        engineSocket: false,
        images: [],
        volumes: [],
        pools: {},
        autoUpdate: true,
        imageUnusedSecsMax: 604_800,
        diskFreeGibMin: 20,
        memoryFreeGibMin: 0,
        memoryReservedGib: 0,
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
      { ...minimal, environment: { CHUG_WORKER_CLAUDE_CREDENTIAL: "{}" } },
      /environment\.CHUG_WORKER_CLAUDE_CREDENTIAL is the runner's to set/u,
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
    [{ ...minimal, concurrencyMax: -1 }, /concurrencyMax /u],
    [
      { ...minimal, engineSocket: "true" },
      /engineSocket Invalid input: expected boolean/u,
    ],
    [
      { claudeTokenFile: minimal.claudeTokenFile },
      /timeoutSecsMax .*; outputBytesMax /u,
    ],
    [
      {
        ...minimal,
        images: [{ image: "x", capabilities: ["Platform:Linux:Amd64"] }],
      },
      /images\.0\.capabilities\.0 names a platform, which is the engine's/u,
    ],
    [
      { ...minimal, images: [{ image: "", capabilities: [] }] },
      /images\.0\.image /u,
    ],
    [{ ...minimal, host: true }, /Unrecognized key: "host"/u],
    ["{", /is not JSON/u],
  ];
  for (const [document, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, document)),
      why,
      JSON.stringify(document),
    );
});

test("while engineSocket is true, the environment may name none of the variables the engine's job is then handed, and each it names is refused by name", async (t) => {
  const directory = await scratch(t);
  const handed = {
    docker: ["DOCKER_HOST", "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE"],
    podman: [
      "DOCKER_HOST",
      "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
      "TESTCONTAINERS_HOST_OVERRIDE",
    ],
  };
  /** @param {string} name */
  const refusal = (name) =>
    `environment.${name} is the runner's to set while engineSocket is true`;
  for (const [engine, names] of Object.entries(handed)) {
    for (const name of jobEngineSocketVariables) {
      const environment = { [name]: "elsewhere", OTHER: "kept" };
      for (const engineSocket of [
        false,
        ...(names.includes(name) ? [] : [true]),
      ])
        assert.deepEqual(
          (
            await runnerConfig(
              await written(directory, {
                ...minimal,
                engine,
                engineSocket,
                environment,
              }),
            )
          ).environment,
          environment,
          `${engine} ${name} ${String(engineSocket)}`,
        );
      if (!names.includes(name)) continue;
      const file = await written(directory, {
        ...minimal,
        engine,
        engineSocket: true,
        environment,
      });
      await assert.rejects(runnerConfig(file), {
        message: `runner configuration ${file}: ${refusal(name)}`,
      });
    }
    const file = await written(directory, {
      ...minimal,
      engine,
      engineSocket: true,
      environment: Object.fromEntries(
        jobEngineSocketVariables.map((name) => [name, "elsewhere"]),
      ),
    });
    await assert.rejects(runnerConfig(file), {
      message: `runner configuration ${file}: ${names.map(refusal).join("; ")}`,
    });
  }
  assert.equal(
    (
      await runnerConfig(
        await written(directory, { ...minimal, engineSocket: true }),
      )
    ).engineSocket,
    true,
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
    signIns: "/home/op/.config/chuggy/sign-ins",
    logs: "/home/op/.local/state/chuggy-linux/logs",
    jobs: "/home/op/.local/state/chuggy-linux/jobs",
    images: "/home/op/.local/state/chuggy-linux/images",
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
      signIns: "/etc/op/chuggy/sign-ins",
      logs: "/home/op/.local/state/chuggy-linux/logs",
      jobs: "/home/op/.local/state/chuggy-linux/jobs",
      images: "/home/op/.local/state/chuggy-linux/images",
      runtime: "/run/user/1000/chuggy-linux",
    },
  );
});

test("a Claude credential's file a job cannot be handed is refused, naming the file its kind is and what to save there", async (t) => {
  const directory = await scratch(t);
  const file = join(directory, "claude-token");
  const subscription = { kind: /** @type {const} */ ("Subscription") };
  /** @param {string} path */
  const refusal = async (path, uid = ownUid) =>
    (await credentialFileRefusal(
      claudeCredentialDescribed(subscription),
      path,
      "podman",
      uid,
    )) ?? "";
  assert.equal(
    await refusal(file),
    `the Claude token file ${file} cannot be found; save \`claude setup-token\`'s output there, alone`,
  );
  await writeFile(file, "", { mode: 0o600 });
  assert.match(await refusal(file), /is empty; save `claude setup-token`/u);
  await writeFile(file, "claude-token-fixture");
  assert.equal(
    await credentialFileRefusal(
      claudeCredentialDescribed(subscription),
      file,
      "podman",
      ownUid,
    ),
    undefined,
  );
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
  const missing = join(directory, "missing");
  for (const [setting, said] of [
    [
      { kind: "ApiKey" },
      `the Anthropic API key file ${missing} cannot be found; save a key from the Claude Console there, alone`,
    ],
    [
      { kind: "Bedrock", region: "us-west-2", profile: "chuggy" },
      `the AWS credentials file ${missing} cannot be found; give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key`,
    ],
  ])
    assert.equal(
      await credentialFileRefusal(
        claudeCredentialDescribed(/** @type {any} */ (setting)),
        missing,
        "podman",
        ownUid,
      ),
      said,
    );
});

test("under docker only a runner that is uid 1000 can hand a job its Claude credential's file", async (t) => {
  const file = join(await scratch(t), "anthropic-api-key");
  const apiKey = { kind: /** @type {const} */ ("ApiKey") };
  assert.equal(
    await credentialFileRefusal(
      claudeCredentialDescribed(apiKey),
      file,
      "docker",
      1234,
    ),
    `docker runs a job as uid 1000, and this runner is uid 1234, so no job could read the Anthropic API key file ${file}, which only this runner can; use rootless podman ("engine": "podman")`,
  );
  assert.match(
    (await credentialFileRefusal(
      claudeCredentialDescribed(apiKey),
      file,
      "docker",
      1000,
    )) ?? "",
    /cannot be found/u,
  );
  assert.match(
    (await credentialFileRefusal(
      claudeCredentialDescribed(apiKey),
      file,
      "host",
      1234,
    )) ?? "",
    /cannot be found/u,
  );
});

/**
 * Catches a Codex credential's file a bind mount cannot name, or a line
 * naming more than it, accepted; one named and not handed to the backends as
 * Codex's; or one handed where the file names none.
 */
test("a file may name a Codex credential's auth.json beside the Claude one, handed to the backends as Codex's, and one naming none hands no other agent's", async (t) => {
  const directory = await scratch(t);
  const authFile = "/home/op/.codex/auth.json";
  const read = await runnerConfig(
    await written(directory, { ...minimal, codexCredential: { authFile } }),
  );
  assert.deepEqual(read.codexCredential, { authFile });
  assert.deepEqual(runnerCredentialsHanded(read), {
    tokenFile: minimal.claudeTokenFile,
    claudeCredential: { kind: "Subscription" },
    agentCredentialFiles: { Codex: authFile },
  });
  assert.deepEqual(
    runnerCredentialsHanded(
      await runnerConfig(await written(directory, minimal)),
    ).agentCredentialFiles,
    {},
  );
  for (const [codexCredential, why] of [
    [
      { authFile: "auth.json" },
      /codexCredential\.authFile must be an absolute path/u,
    ],
    [
      { authFile: "/a,readonly=false" },
      /codexCredential\.authFile cannot be named in a bind mount/u,
    ],
    [
      { authFile, kind: "ChatGPT" },
      /codexCredential Unrecognized key: "kind"/u,
    ],
    [{}, /codexCredential\.authFile Invalid input/u],
  ])
    await assert.rejects(
      runnerConfig(await written(directory, { ...minimal, codexCredential })),
      why,
    );
});

/**
 * Catches the Codex file's refusal naming it as Claude's, or telling its
 * owner to save a Claude credential there.
 */
test("a Codex credential's file a job cannot be handed is refused as a Claude one's is, naming the Codex auth file and how to make one", async (t) => {
  const directory = await scratch(t);
  const file = join(directory, "auth.json");
  const subscription = { kind: /** @type {const} */ ("Subscription") };
  const codex = runnerCredentialDescribed(subscription, "Codex");
  assert.equal(
    await credentialFileRefusal(codex, file, "podman", ownUid),
    `the Codex auth file ${file} cannot be found; run codex login, which writes it to ~/.codex/auth.json`,
  );
  await writeFile(file, "", { mode: 0o600 });
  assert.equal(
    await credentialFileRefusal(codex, file, "podman", ownUid),
    `the Codex auth file ${file} is empty; run codex login, which writes it to ~/.codex/auth.json`,
  );
  assert.match(
    (await credentialFileRefusal(codex, file, "docker", 1234)) ?? "",
    /^docker runs a job as uid 1000, and this runner is uid 1234, so no job could read the Codex auth file /u,
  );
  assert.deepEqual(
    runnerCredentialDescribed(subscription, "Claude"),
    claudeCredentialDescribed(subscription),
  );
});

test("a file names a Claude credential of any kind in claudeCredential, read as it is named", async (t) => {
  const directory = await scratch(t);
  for (const claudeCredential of credentials) {
    const read = await runnerConfig(
      await written(directory, { ...unnamed, claudeCredential }),
    );
    assert.deepEqual(read.claudeCredential, claudeCredential);
    assert.equal("claudeTokenFile" in read, false);
  }
});

test("a file naming a Claude credential by both keys, or by neither, is refused, one naming neither as one naming no token file always was", async (t) => {
  const directory = await scratch(t);
  const neither = await written(directory, unnamed);
  await assert.rejects(runnerConfig(neither), {
    message: `runner configuration ${neither}: claudeTokenFile Invalid input: expected string, received undefined`,
  });
  await assert.rejects(
    runnerConfig(await written(directory, { outputBytesMax: 65536 })),
    /timeoutSecsMax .*; claudeTokenFile Invalid input: expected string, received undefined$/u,
  );
  for (const claudeCredential of credentials) {
    const both = await written(directory, { ...minimal, claudeCredential });
    await assert.rejects(runnerConfig(both), {
      message: `runner configuration ${both}: claudeCredential names a Claude credential, and so does claudeTokenFile; keep one`,
    });
  }
});

test("what a Claude credential may not say is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const refused = [
    [
      { kind: "OAuth" },
      /claudeCredential\.kind names no kind of Claude credential/u,
    ],
    [
      { kind: "Subscription", tokenFile: "claude-token" },
      /claudeCredential\.tokenFile must be an absolute path/u,
    ],
    [
      { kind: "ApiKey", apiKeyFile: "/a,readonly=false" },
      /claudeCredential\.apiKeyFile cannot be named in a bind mount/u,
    ],
    [
      {
        kind: "Vertex",
        region: "r",
        project: "p",
        credentialsFile: "key.json",
      },
      /claudeCredential\.credentialsFile must be an absolute path/u,
    ],
    [
      { kind: "ApiKey", apiKeyFile: "/k", region: "us-west-2" },
      /claudeCredential Unrecognized key: "region"/u,
    ],
    [{ kind: "Bedrock", apiKeyFile: "/k" }, /claudeCredential\.region /u],
  ];
  for (const [claudeCredential, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, { ...unnamed, claudeCredential })),
      why,
      JSON.stringify(claudeCredential),
    );
});

test("the environment may name any other variable that chooses Claude Code's credential or where it is sent, read as written whatever kind is named", async (t) => {
  const directory = await scratch(t);
  const environment = Object.fromEntries(
    [
      ...claudeCredentialVariables.filter(
        (name) => !reservedJobVariables.includes(name),
      ),
      ...credentials.flatMap(({ kind }) =>
        claudeCredentialProviderVariables(kind),
      ),
    ].map((name) => [name, "elsewhere"]),
  );
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_PROFILE"])
    assert.ok(Object.hasOwn(environment, name), name);
  for (const named of [
    minimal,
    ...credentials.map((claudeCredential) => ({
      ...unnamed,
      claudeCredential,
    })),
  ])
    assert.deepEqual(
      (await runnerConfig(await written(directory, { ...named, environment })))
        .environment,
      environment,
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

test("a chat host's settings line says each of its chat keys, the core's default where one is absent, and the supervisor's memory cap", async (t) => {
  const directory = await scratch(t);
  const bare = await runnerConfig(await written(directory, minimal));
  assert.equal(bare.chat, undefined);
  const defaults = chatHostConfigured(undefined, minimal.outputBytesMax);
  const mib = (bytes) => String(bytes / 2 ** 20);
  assert.equal(
    runnerChatSettingsLine(bare),
    `sessionsMax ${String(chatHostSessionsMaxDefault)}, sessionMemoryMib ${mib(chatSessionMemoryBytesDefault)}, the supervisor's cap asked of the engine ${mib(chatHostMemoryBytes(defaults))} MiB, idleSecs ${String(chatHostIdleSecs)}, outputBytesMax 65536, running the image chuggy names`,
  );
  const empty = await runnerConfig(
    await written(directory, { ...minimal, chat: {} }),
  );
  assert.equal(runnerChatSettingsLine(empty), runnerChatSettingsLine(bare));
  const chat = {
    image: { image: "registry.example/me/chat:1" },
    sessionsMax: 3,
    sessionMemoryMib: 1024,
    idleSecs: 300,
    outputBytesMax: 1024,
  };
  const set = await runnerConfig(
    await written(directory, { ...minimal, chat }),
  );
  assert.deepEqual(set.chat, {
    ...chat,
    image: { image: "registry.example/me/chat:1", pull: "missing" },
  });
  assert.equal(
    runnerChatSettingsLine(set),
    "sessionsMax 3, sessionMemoryMib 1024, the supervisor's cap asked of the engine 3072 MiB, idleSecs 300, outputBytesMax 1024, running registry.example/me/chat:1, pulled where it is missing",
  );
  for (const pull of ["always", "never"])
    assert.match(
      runnerChatSettingsLine(
        await runnerConfig(
          await written(directory, {
            ...minimal,
            chat: { image: { image: "x", pull } },
          }),
        ),
      ),
      new RegExp(`running x, pulled ${pull}$`, "u"),
    );
});

test("what a chat section may not say is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const refused = [
    [{ sessionMax: 2 }, /chat Unrecognized key: "sessionMax"/u],
    [{ sessionsMax: 0 }, /chat\.sessionsMax /u],
    [{ sessionMemoryMib: 1 }, /chat\.sessionMemoryMib /u],
    [{ idleSecs: 1.5 }, /chat\.idleSecs /u],
    [{ outputBytesMax: "1024" }, /chat\.outputBytesMax /u],
    [{ image: "registry.example/me/chat:1" }, /chat\.image /u],
    [{ image: { image: "x", pull: "sometimes" } }, /chat\.image\.pull /u],
    [
      { image: { image: "x", tag: "1" } },
      /chat\.image Unrecognized key: "tag"/u,
    ],
  ];
  for (const [chat, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, { ...minimal, chat })),
      why,
      JSON.stringify(chat),
    );
});
