import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { poolProjectDigest } from "@chuggy/worker-core/poolIdentity.mjs";

import {
  doctorFindings,
  engineSocketReach,
  findingLine,
  volumeDirectoryWritable,
} from "./doctor.mjs";
import { fakeDisk, fakeEngine } from "./engine.fixture.mjs";
import { runnerUpdates } from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import {
  engineSocketFixture,
  fixturePool,
  poolFileWritten,
  runnerFixture,
} from "./runner.fixture.mjs";
import { serviceUnit } from "./systemdUnit.mjs";

/** The copy doctor is run as, the Node it runs under, and the machine. */
const copy = {
  node: "/opt/node/bin/node",
  cli: "/opt/chuggy-linux/cli.mjs",
  arch: "x64",
  gid: process.getgid?.() ?? -1,
};

/**
 * A copy at 9.8.7 installed where npm installs one globally under a prefix in
 * the home, and the updates doctor finds for it.
 *
 * @param {string} home
 * @param {import("./runnerConfig.mjs").RunnerPaths} paths
 * @param {{installed?: string, writable?: (path: string) => Promise<boolean>}} options the directory the copy is installed in where it is not that one, and what this user may write where it is not what the file system says
 */
async function installedCopy(home, paths, options) {
  const prefix = join(home, "npm");
  const installed = join(prefix, "lib", "node_modules", "chuggy-linux");
  await mkdir(installed, { recursive: true });
  await mkdir(join(prefix, "bin"));
  const runner = {
    package: "chuggy-linux",
    version: "9.8.7",
    cli: join(options.installed ?? installed, "cli.mjs"),
  };
  const ports =
    options.writable === undefined ? {} : { writable: options.writable };
  return {
    prefix,
    updates: (
      /** @type {import("./runnerConfig.mjs").RunnerConfig} */ config,
    ) => runnerUpdates({ config, paths }, runner, ports),
  };
}

/**
 * Writes each pool file named in the pools directory, which doctor reads the
 * names `pools` may key from, each registration given as one, and gives the
 * engine each named volume.
 *
 * @param {import("./runnerConfig.mjs").RunnerPaths} paths
 * @param {ReturnType<typeof fakeEngine>["state"]} state
 * @param {{poolFiles?: string[], registered?: Record<string, Record<string, unknown>>, volumes?: string[], labelledVolumes?: Record<string, Record<string, string>>}} options
 */
async function doctoredMachine(paths, state, options) {
  for (const file of options.poolFiles ?? []) {
    await mkdir(paths.pools, { recursive: true });
    await writeFile(join(paths.pools, file), "{}");
  }
  for (const [file, pool] of Object.entries(options.registered ?? {}))
    await poolFileWritten(join(paths.pools, file), pool);
  for (const volume of options.volumes ?? []) state.volumes.set(volume, {});
  for (const [volume, labels] of Object.entries(options.labelledVolumes ?? {}))
    state.volumes.set(volume, labels);
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, pool?: Record<string, unknown>, token?: unknown, uid?: number, securityOptions?: string[], podmanVersion?: string, podmanServiceRemote?: string, podmanSocket?: string, contextHost?: string, registries?: Record<string, string>, unit?: (poolFile: string, unit: string) => Promise<unknown>, poolFileName?: string, poolFiles?: string[], registered?: Record<string, Record<string, unknown>>, volumes?: string[], labelledVolumes?: Record<string, Record<string, string>>, volumesUnanswered?: boolean, path?: string, servicePath?: string, agentVersions?: Record<string, string>, runtime?: false, installed?: string, writable?: (path: string) => Promise<boolean>, disk?: import("./diskFree.mjs").DiskFreePorts, info?: Record<string, unknown>}} options podman's registries.conf and its drop-ins, by path under a directory of their own, what makes the pool file's unit, the name of a pool file in the home to ask of in place of the fixture's, those in the pools directory and the registrations among them, the named volumes the engine has, unlabelled or by their labels, doctor's own PATH and the service manager's, what each `claude` or `codex` says its version is, `runtime: false` for a session with no XDG_RUNTIME_DIR, the install `installedCopy` makes, and the disk the engine's free space is measured on and what its `info` says in place of the fixture's
 */
async function doctored(t, options = {}) {
  const fixture = await runnerFixture(t, {
    ...("runner" in options ? { runner: options.runner } : {}),
    pool: options.pool,
  });
  const { home, environment } = fixture;
  const poolFile =
    options.poolFileName === undefined
      ? fixture.poolFile
      : join(home, options.poolFileName);
  const paths = runnerPaths(
    options.runtime === false
      ? { ...environment, XDG_RUNTIME_DIR: undefined }
      : environment,
    home,
  );
  const { prefix, updates } = await installedCopy(home, paths, options);
  const unit = join(paths.units, "chuggy-linux-pool.service");
  if (options.unit !== undefined) {
    await mkdir(paths.units, { recursive: true });
    await options.unit(poolFile, unit);
  }
  const { engine, state } = fakeEngine();
  state.securityOptions = options.securityOptions ?? state.securityOptions;
  state.podmanVersion = options.podmanVersion ?? state.podmanVersion;
  state.podmanServiceRemote =
    options.podmanServiceRemote ?? state.podmanServiceRemote;
  state.podmanSocket = options.podmanSocket ?? state.podmanSocket;
  state.contextHost = options.contextHost ?? state.contextHost;
  state.info = options.info ?? state.info;
  await doctoredMachine(paths, state, options);
  state.volumesUnanswered = options.volumesUnanswered ?? false;
  const registries = join(home, "registries");
  for (const [file, text] of Object.entries(options.registries ?? {})) {
    await mkdir(dirname(join(registries, file)), { recursive: true });
    await writeFile(join(registries, file), text);
  }
  /** @type {unknown[][]} */
  const polls = [];
  const findings = await doctorFindings({
    poolFile,
    paths,
    ...copy,
    registriesConf: [
      join(registries, "registries.conf"),
      join(registries, "registries.conf.d"),
    ],
    uid: options.uid ?? process.getuid?.() ?? -1,
    path: options.path,
    servicePath: async () => options.servicePath,
    agentVersion: async (file) => options.agentVersions?.[file],
    disk: options.disk ?? fakeDisk(100),
    parts: {
      engine: () => engine,
      updates,
      tokens: () => ({
        acquire: async () =>
          options.token ?? { acquired: "Token", token: "pool-token" },
        invalidate: () => undefined,
      }),
      plane: () => ({
        poll: async (token, held, wanted, wantedSessions) => {
          polls.push([token, held, wanted, wantedSessions]);
          return { polled: "Reconciled", assignments: [], stop: [] };
        },
        settle: async () => "Settled",
      }),
    },
  });
  return { findings, state, polls, poolFile, registries, unit, prefix };
}

test("doctor names a personal runner's file as one, by its tenant and member", async (t) => {
  const { findings, poolFile } = await doctored(t, {
    pool: {
      kind: "Personal",
      tenant: "vteng",
      owner: "28:https://auth.chuggy.example/0f3c9a52-member",
      capabilities: ["container"],
      tokenUrl: "https://issuer.chuggy.example/oauth2/token",
      audience: "https://chuggy.example",
      planeUrl: "https://chuggy.example/pool",
      clientId: "personal-client",
      clientSecret: "personal-client-secret",
    },
  });
  assert.deepEqual(findings[0], {
    check: "pool file",
    passed: true,
    detail: `${poolFile} names personal runner vteng/28:https:%2F%2Fauth.chuggy.example%2F0f3c9a52-member`,
  });
});

test("a pool registered with --host fails doctor where the runner's file names what a host job's places set", async (t) => {
  const pool = { ...fixturePool, host: true };
  const passed = await doctored(t, { pool });
  assert.deepEqual(
    passed.findings.find((finding) => finding.check === "host jobs"),
    {
      check: "host jobs",
      passed: true,
      detail:
        "a job that pins no image and names this machine's platform runs on the machine itself, unisolated",
    },
  );
  const failed = await doctored(t, {
    pool,
    runner: { environment: { TMPDIR: "/var/tmp" } },
  });
  assert.match(
    failed.findings.find((finding) => finding.check === "host jobs")?.detail ??
      "",
    /^TMPDIR is set for every host job/u,
  );
  const unhosted = await doctored(t);
  assert.equal(
    unhosted.findings.some((finding) => finding.check === "host jobs"),
    false,
  );
});

test("a machine ready to run passes every check, and doctor changes nothing", async (t) => {
  const { findings, state, polls, poolFile } = await doctored(t);
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.passed]),
    [
      ["pool file", true],
      ["runner configuration", true],
      ["runtime directory", true],
      ["Claude credential", true],
      ["podman credential helpers", true],
      ["service unit", true],
      ["updates", true],
      ["container engine", true],
      ["engine socket", true],
      ["job network", true],
      ["volumes", true],
      ["disk floor", true],
      ["memory caps", true],
      ["capabilities", true],
      ["pool token", true],
      ["plane", true],
    ],
  );
  assert.equal(
    findings.some((finding) => finding.warning === true),
    false,
  );
  assert.equal(findings[0].detail, `${poolFile} names pool vteng/chuggy/shame`);
  assert.match(
    findings[1].detail,
    /\/chuggy-linux\/runner\.json: concurrencyMax 1, sessionsMax 2$/u,
  );
  assert.deepEqual(findings[4], {
    check: "podman credential helpers",
    passed: true,
    detail:
      "none named ahead of the auth file in the 0 registries.conf files read",
  });
  assert.deepEqual(findings[8], {
    check: "engine socket",
    passed: true,
    detail: "off",
  });
  assert.equal(
    findings[9].detail,
    "chuggy-jobs is missing, and a run makes it",
  );
  assert.equal(findings[10].detail, "none");
  assert.equal(
    findings[11].detail,
    "100 GiB free at /home/runner/.local/share/containers/storage, over the floor of 20 GiB",
  );
  assert.deepEqual(polls, [["pool-token", [], 0, 0]]);
  assert.deepEqual(
    state.calls.map((call) => call.argv[0]),
    ["version", "info", "ps", "network", "info", "info"],
  );
});

/**
 * Catches doctor passing a runner whose run would be refused, which register
 * would then start, or naming a source of the set its run does not use.
 */
test("doctor names what a run advertises and where it comes from, and fails where a run would be refused", async (t) => {
  /** @param {Parameters<typeof doctored>[1]} options */
  const found = async (options) =>
    (await doctored(t, options)).findings.find(
      (finding) => finding.check === "capabilities",
    );
  const agents = String.raw`this machine's platform, the agents \/.*\/runner\.json can run`;
  for (const [runner, said] of [
    [
      {},
      new RegExp(
        `^a run advertises Platform:Linux:Amd64, container on each poll: ${agents}, and the rest of what the pool was registered with$`,
        "u",
      ),
    ],
    [
      { capabilities: ["gpu"] },
      new RegExp(
        `^a run advertises Platform:Linux:Amd64, gpu on each poll: ${agents}, and its capabilities$`,
        "u",
      ),
    ],
  ]) {
    const finding = await found({ runner });
    assert.equal(finding?.passed, true);
    assert.match(finding?.detail ?? "", /** @type {RegExp} */ (said));
  }
  const refused = await found({
    runner: {
      capabilities: Array.from({ length: 64 }, (_, at) => `c${String(at)}`),
    },
  });
  assert.equal(refused?.passed, false);
  assert.match(
    refused?.detail ?? "",
    /^runner configuration \/.*\/runner\.json: capabilities: this runner would advertise 65 capabilities, /u,
  );
});

test("doctor warns of a disk under the runner's floor, or one it cannot measure, and passes one over it", async (t) => {
  /** @param {Awaited<ReturnType<typeof doctored>>} doctor */
  const floor = (doctor) =>
    doctor.findings.find((finding) => finding.check === "disk floor");
  const store = "/home/runner/.local/share/containers/storage";
  assert.deepEqual(
    floor(
      await doctored(t, {
        runner: { diskFreeGibMin: 50 },
        disk: fakeDisk(30),
      }),
    ),
    {
      check: "disk floor",
      passed: true,
      warning: true,
      detail: `30 GiB free at ${store}, under the floor of 50 GiB: the service removes the images it may and takes no job until it is over`,
    },
  );
  const elsewhere = floor(
    await doctored(t, {
      info: { host: { hostname: "podman-machine-default" }, store: {} },
    }),
  );
  assert.equal(elsewhere?.warning, true);
  assert.match(
    elsewhere?.detail ?? "",
    /^none held, since the free disk could not be measured: podman answered an info/u,
  );
  assert.deepEqual(floor(await doctored(t, { disk: fakeDisk(20) })), {
    check: "disk floor",
    passed: true,
    detail: `20 GiB free at ${store}, over the floor of 20 GiB`,
  });
});

test("doctor says the runner updates itself unless its file turns that off", async (t) => {
  const on = await doctored(t);
  assert.deepEqual(
    on.findings.find((finding) => finding.check === "updates"),
    {
      check: "updates",
      passed: true,
      detail: "on: the service installs the release chuggy names",
    },
  );
  const off = await doctored(t, {
    runner: { autoUpdate: false },
    writable: async () => false,
  });
  assert.deepEqual(
    off.findings.find((finding) => finding.check === "updates"),
    {
      check: "updates",
      passed: true,
      detail: "off: the runner's file sets autoUpdate to false",
    },
  );
});

test("an install that could not update itself is warned of with why, and passes", async (t) => {
  const remedy = "install it with npm under a prefix you own, such as nvm's";
  const unglobal = await doctored(t, { installed: dirname(copy.cli) });
  assert.deepEqual(
    unglobal.findings.find((finding) => finding.check === "updates"),
    {
      check: "updates",
      passed: true,
      warning: true,
      detail: `on, but this install cannot take a release: this runner is installed at ${dirname(copy.cli)}, which is not where npm installs a package globally; ${remedy}`,
    },
  );
  /** @type {string[]} */
  const asked = [];
  const unwritable = await doctored(t, {
    writable: async (path) => {
      asked.push(path);
      return !path.endsWith("bin");
    },
  });
  assert.deepEqual(asked, [
    join(unwritable.prefix, "lib", "node_modules"),
    join(unwritable.prefix, "bin"),
  ]);
  assert.deepEqual(
    unwritable.findings.find((finding) => finding.check === "updates"),
    {
      check: "updates",
      passed: true,
      warning: true,
      detail: `on, but this install cannot take a release: this runner cannot write ${join(unwritable.prefix, "bin")}, where npm would install it; ${remedy}`,
    },
  );
});

test("without a runtime directory, where the install lock is kept, updates are not checked", async (t) => {
  const { findings } = await doctored(t, { runtime: false });
  assert.deepEqual(
    findings.find((finding) => finding.check === "runtime directory")?.passed,
    false,
  );
  assert.equal(
    findings.some((finding) => finding.check === "updates"),
    false,
  );
});

test("a check that failed says why, and what depends on it is not checked", async (t) => {
  const { findings } = await doctored(t, {
    runner: undefined,
    token: {
      acquired: "Denied",
      evidence: "the issuer refused the pool's client credential",
    },
  });
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.passed]),
    [
      ["pool file", true],
      ["runner configuration", false],
      ["runtime directory", true],
      ["service unit", true],
      ["pool token", false],
    ],
  );
  assert.match(findings[1].detail, /ENOENT/u);
  assert.equal(
    findings[4].detail,
    "the issuer refused the pool's client credential",
  );
});

test("under docker, doctor names the endpoint its context names, and fails rootless docker", async (t) => {
  /** @param {string[]} securityOptions */
  const engineFinding = async (securityOptions) => {
    const { findings, state } = await doctored(t, {
      runner: { engine: "docker" },
      uid: 1000,
      securityOptions,
    });
    return {
      finding: findings.find((found) => found.check === "container engine"),
      verbs: state.calls.map((call) => call.argv[0]),
    };
  };
  assert.deepEqual(await engineFinding(["name=seccomp,profile=builtin"]), {
    finding: {
      check: "container engine",
      passed: true,
      detail:
        "docker at unix:///var/run/docker.sock lists 0 of this pool's containers",
    },
    verbs: ["info", "context", "ps", "network", "info"],
  });
  const rootless = await engineFinding(["name=rootless", "name=cgroupns"]);
  assert.equal(rootless.finding?.passed, false);
  assert.match(
    rootless.finding?.detail ?? "",
    /^docker is running rootless, .*; use rootful docker without userns-remap, or rootless podman/u,
  );
  assert.deepEqual(rootless.verbs, ["info"]);
});

test("under docker, a runner that is not uid 1000 fails the Claude credential check", async (t) => {
  const { findings } = await doctored(t, {
    runner: { engine: "docker" },
    uid: 1234,
  });
  const finding = findings.find((found) => found.check === "Claude credential");
  assert.equal(finding?.passed, false);
  assert.match(
    finding?.detail ?? "",
    /docker runs a job as uid 1000, and this runner is uid 1234.*use rootless podman/u,
  );
});

test("a credential helper podman's registries.conf names ahead of the auth file is warned of, and passes, and one after it is not", async (t) => {
  const { findings, registries } = await doctored(t, {
    registries: {
      "registries.conf":
        '# credential-helpers = ["pass"]\nother-credential-helpers = ["pass"]\ncredential-helpers = []\n',
      "registries.conf.d/10-helper.conf":
        'credential-helpers = [\n  "secretservice",\n]\n',
      "registries.conf.d/20-search.conf":
        'unqualified-search-registries = ["docker.io"]\n',
      "registries.conf.d/30-default.conf":
        'credential-helpers = ["containers-auth.json"]\n',
      "registries.conf.d/40-quoted.conf":
        "\"credential-helpers\" = ['containers-auth.json', 'pass']\n",
      "registries.conf.d/45-ahead.conf":
        'credential-helpers = ["pass", "containers-auth.json"]\n',
      "registries.conf.d/50-literal.conf":
        "'credential-helpers' = [\"pass\"]\n",
      "registries.conf.d/60-commented.conf":
        'credential-helpers = [\n  # see [the manual]\n  "pass",\n]\n',
      "registries.conf.d/70-comment-quoted.conf":
        'credential-helpers = [\n  "containers-auth.json", # not "pass"\n]\n',
      "registries.conf.d/80-hash.conf":
        "credential-helpers = [\"pass#work\", 'pass#home']\n",
      "registries.conf.d/helper.txt": 'credential-helpers = ["pass"]\n',
    },
  });
  const finding = findings.find(
    (found) => found.check === "podman credential helpers",
  );
  const warned = [
    "10-helper",
    "45-ahead",
    "50-literal",
    "60-commented",
    "80-hash",
  ].map((name) => join(registries, "registries.conf.d", `${name}.conf`));
  assert.deepEqual(finding, {
    check: "podman credential helpers",
    passed: true,
    warning: true,
    detail: `${warned.join(", ")} name a credential helper ahead of containers-auth.json, which podman asks in place of the pool's token on a pull of the pool's registry; name containers-auth.json first`,
  });
  assert.ok(findings.every((found) => found.passed));
  assert.match(
    findingLine(finding ?? findings[0]),
    /^warn {2}podman credential helpers: /u,
  );
  assert.equal(
    findingLine({ check: "plane", passed: false, detail: "down" }),
    "FAIL  plane: down",
  );
  assert.equal(
    findingLine({ check: "plane", passed: true, detail: "up" }),
    "ok    plane: up",
  );
});

test("docker has no podman credential helpers to check", async (t) => {
  const { findings } = await doctored(t, {
    runner: { engine: "docker" },
    uid: 1000,
    registries: { "registries.conf": 'credential-helpers = ["pass"]\n' },
  });
  assert.ok(
    !findings.some((found) => found.check === "podman credential helpers"),
  );
});

test("a podman whose keep-id cannot map its user onto a job's fails the engine check", async (t) => {
  const { findings, state } = await doctored(t, { podmanVersion: "4.2.1" });
  assert.deepEqual(
    findings.find((found) => found.check === "container engine"),
    {
      check: "container engine",
      passed: false,
      detail:
        "podman 4.2.1 cannot map its user onto a job's with --userns=keep-id:uid=,gid=; podman 4.3 or later is required",
    },
  );
  assert.ok(!findings.some((found) => found.check === "job network"));
  assert.ok(state.calls.every((call) => call.argv[0] === "version"));
});

test("the registries.conf files read are counted, and podman's own default helper is none", async (t) => {
  for (const [registries, detail] of [
    [
      { "registries.conf": 'credential-helpers = ["containers-auth.json"]\n' },
      "none named ahead of the auth file in the 1 registries.conf file read",
    ],
    [
      {
        "registries.conf": 'credential-helpers = ["containers-auth.json"]\n',
        "registries.conf.d/10-search.conf":
          'unqualified-search-registries = ["docker.io"]\n',
      },
      "none named ahead of the auth file in the 2 registries.conf files read",
    ],
  ]) {
    const { findings } = await doctored(t, { registries });
    assert.deepEqual(
      findings.find((found) => found.check === "podman credential helpers"),
      { check: "podman credential helpers", passed: true, detail },
    );
  }
});

test("a remote podman client fails the engine check", async (t) => {
  const { findings } = await doctored(t, { podmanServiceRemote: "true" });
  const finding = findings.find((found) => found.check === "container engine");
  assert.equal(finding?.passed, false);
  assert.match(finding?.detail ?? "", /^podman is a remote client here /u);
});

/**
 * The service unit finding of a machine whose pool file's unit holds what
 * `text` writes, or that has none where there is no `text`.
 *
 * @param {import("node:test").TestContext} t
 * @param {(poolFile: string) => string} [text]
 */
async function unitFound(t, text) {
  const found = await doctored(t, {
    unit:
      text === undefined
        ? undefined
        : (poolFile, unit) => writeFile(unit, text(poolFile)),
  });
  return {
    ...found,
    finding: found.findings.find((finding) => finding.check === "service unit"),
  };
}

test("the pool file's unit passes where it runs this copy under this Node, and where there is none yet", async (t) => {
  const none = await unitFound(t);
  assert.deepEqual(none.finding, {
    check: "service unit",
    passed: true,
    detail: `none yet at ${none.unit}`,
  });
  const same = await unitFound(t, (poolFile) =>
    serviceUnit({ ...copy, poolFile }),
  );
  assert.deepEqual(same.finding, {
    check: "service unit",
    passed: true,
    detail: `${same.unit} runs this copy under this Node`,
  });
});

test("a unit running another install, or this one under another Node, is warned of with what makes it run this one, and passes", async (t) => {
  for (const other of [
    {
      node: "/usr/bin/node",
      cli: "/usr/lib/node_modules/chuggy-linux/cli.mjs",
    },
    { node: "/usr/bin/node", cli: copy.cli },
    { node: copy.node, cli: "/usr/lib/node_modules/chuggy-linux/cli.mjs" },
  ]) {
    const { finding, findings, unit, poolFile } = await unitFound(t, (served) =>
      serviceUnit({ ...other, poolFile: served }),
    );
    assert.deepEqual(finding, {
      check: "service unit",
      passed: true,
      warning: true,
      detail: `${unit} runs ${other.cli} under ${other.node}, not this copy under this Node; to have it run this one: ${copy.node} ${copy.cli} install-service --pool ${poolFile} && systemctl --user daemon-reload && systemctl --user restart chuggy-linux-pool.service`,
    });
    assert.ok(findings.every((found) => found.passed));
  }
});

test("a unit this runner cannot read back, one serving another pool file, one that cannot be read, and a pool file whose name makes no unit are each warned of, and pass", async (t) => {
  const edited = await unitFound(
    t,
    (poolFile) =>
      `[Service]\nExecStart=/usr/bin/node ${copy.cli} run --pool ${poolFile}\n`,
  );
  assert.deepEqual(edited.finding, {
    check: "service unit",
    passed: true,
    warning: true,
    detail: `${edited.unit} runs a command this runner cannot read back, so which copy it runs is unknown`,
  });
  const extra = await unitFound(t, (poolFile) =>
    serviceUnit({ ...copy, poolFile }).replace(
      /^(ExecStart=.*)$/mu,
      '$1 "--verbose"',
    ),
  );
  assert.equal(
    extra.finding?.detail,
    `${extra.unit} runs a command this runner cannot read back, so which copy it runs is unknown`,
  );
  const elsewhere = await unitFound(t, () =>
    serviceUnit({ ...copy, poolFile: "/elsewhere/pool.json" }),
  );
  assert.deepEqual(elsewhere.finding, {
    check: "service unit",
    passed: true,
    warning: true,
    detail: `${elsewhere.unit} serves /elsewhere/pool.json, not this pool file`,
  });
  const { findings, unit } = await doctored(t, {
    unit: (_, made) => mkdir(made),
  });
  const unreadable = findings.find((found) => found.check === "service unit");
  assert.equal(unreadable?.passed, true);
  assert.equal(unreadable?.warning, true);
  assert.ok(
    unreadable?.detail.startsWith(`${unit} cannot be read: EISDIR: `),
    unreadable?.detail,
  );
  const unnamed = await doctored(t, {
    poolFileName: `${"a".repeat(256)}.json`,
  });
  assert.deepEqual(
    unnamed.findings.find((found) => found.check === "service unit"),
    {
      check: "service unit",
      passed: true,
      warning: true,
      detail: `${unnamed.poolFile} makes a unit name longer than systemd accepts; give the pool file a shorter name`,
    },
  );
});

/**
 * The engine socket finding of a machine whose runner hands jobs `engine`'s
 * socket, a stand-in of `mode` that the fake engine names as `named` makes of
 * its path.
 *
 * @param {import("node:test").TestContext} t
 * @param {"docker" | "podman"} engine
 * @param {(path: string) => {podmanSocket?: string, contextHost?: string}} named
 */
async function engineSocketFound(t, engine, named, mode = 0o660) {
  const socket = await engineSocketFixture(t, "engine.sock", mode);
  const { findings, state } = await doctored(t, {
    runner: { engine, engineSocket: true },
    uid: 1000,
    ...named(socket.path),
  });
  return {
    socket,
    finding: findings.find((found) => found.check === "engine socket"),
    findings,
    state,
  };
}

test("doctor names the socket each job reaches, at the path a job finds it, and under docker the group it is added to", async (t) => {
  const docker = await engineSocketFound(t, "docker", (path) => ({
    contextHost: `unix://${path}`,
  }));
  assert.notEqual(docker.socket.gid, 0);
  assert.deepEqual(docker.finding, {
    check: "engine socket",
    passed: true,
    detail: `on: each job reaches docker's socket ${docker.socket.path} at /var/run/docker.sock, added to group ${String(docker.socket.gid)}`,
  });
  assert.deepEqual(
    docker.state.calls.map((call) => call.argv[0]),
    ["info", "context", "ps", "network", "info"],
  );
  const podman = await engineSocketFound(t, "podman", (path) => ({
    podmanSocket: `unix://${path} true`,
  }));
  assert.deepEqual(podman.finding, {
    check: "engine socket",
    passed: true,
    detail: `on: each job reaches podman's socket ${podman.socket.path} at /var/run/docker.sock`,
  });
  assert.ok(podman.findings.every((found) => found.passed));
});

test("doctor fails a socket that is not there, naming what starts podman's, and one a job cannot reach, and still checks the job network", async (t) => {
  const missing = await engineSocketFound(t, "podman", (path) => ({
    podmanSocket: `${path} false`,
  }));
  assert.deepEqual(missing.finding, {
    check: "engine socket",
    passed: false,
    detail: `podman's socket ${missing.socket.path} is not there; start it with systemctl --user enable --now podman.socket`,
  });
  assert.ok(missing.findings.some((found) => found.check === "job network"));
  const unreached = await engineSocketFound(
    t,
    "docker",
    (path) => ({ contextHost: `unix://${path}` }),
    0o000,
  );
  assert.deepEqual(unreached.finding, {
    check: "engine socket",
    passed: false,
    detail: `docker's socket ${unreached.socket.path}: it is uid ${String(process.getuid?.())}'s, group ${String(unreached.socket.gid)}'s and mode 000, so a job, uid 1000 in group ${[...new Set([1000, unreached.socket.gid])].join(" and ")}, cannot reach it; give the socket a group of its own, such as docker's, and mode 660`,
  });
});

test("a socket whose stat does not decide whether a job reaches it is warned of with what makes it sure, and passes", async (t) => {
  const uid = (process.getuid?.() ?? -1) + 1;
  const socket = await engineSocketFixture(t);
  const { findings } = await doctored(t, {
    runner: { engine: "podman", engineSocket: true },
    uid,
    podmanSocket: `${socket.path} true`,
  });
  assert.deepEqual(
    findings.find((found) => found.check === "engine socket"),
    {
      check: "engine socket",
      passed: true,
      warning: true,
      detail: `on: each job is handed podman's socket ${socket.path} at /var/run/docker.sock, but it is uid ${String(uid - 1)}'s, group ${String(socket.gid)}'s and mode 660, so a job, uid ${String(uid)}, this runner's, reaches it only if its group or an ACL lets it, which doctor cannot see; to be sure, run podman's socket as this runner, as systemctl --user enable --now podman.socket does`,
    },
  );
});

test("a job reaches the engine's socket by the bits its uid and groups are read by, under docker its own, its group's and the socket's unless that is root's, and under podman the runner's, and where an ACL could let it in and the bits do not, they do not decide", () => {
  const docker = /** @type {const} */ ("docker");
  const podman = /** @type {const} */ ("podman");
  const socket = (uid = 0, gid = 125, mode = 0o140660) => ({ uid, gid, mode });
  const reached = { reach: "Reached" };
  const dockerRemedy =
    "give the socket a group of its own, such as docker's, and mode 660";
  const podmanRemedy =
    "run podman's socket as this runner, as systemctl --user enable --now podman.socket does";
  for (const [stat, runnerUid] of [
    [socket(), 1000],
    [socket(0, 0, 0o140666), 1234],
    [socket(1000, 0, 0o140600), 1234],
    [socket(0, 1000, 0o140660), 1234],
  ])
    assert.deepEqual(engineSocketReach(docker, stat, runnerUid), reached);
  for (const [stat, runnerUid] of [
    [socket(1234, 1234, 0o140600), 1234],
    [socket(1234, 1234, 0o140666), 1000],
  ])
    assert.deepEqual(engineSocketReach(podman, stat, runnerUid), reached);
  for (const [engine, stat, why] of [
    [
      docker,
      socket(0, 0),
      `it is uid 0's, group 0's and mode 660, so a job, uid 1000 in group 1000 and never in root's, reaches it only if an ACL lets it, which doctor cannot see; to be sure, ${dockerRemedy}`,
    ],
    [
      podman,
      socket(1234, 1000),
      `it is uid 1234's, group 1000's and mode 660, so a job, uid 1000, this runner's, reaches it only if its group or an ACL lets it, which doctor cannot see; to be sure, ${podmanRemedy}`,
    ],
  ])
    assert.deepEqual(engineSocketReach(engine, stat, 1000), {
      reach: "Undecided",
      why,
    });
  for (const [engine, stat, why] of [
    [
      docker,
      socket(0, 0, 0o140600),
      `it is uid 0's, group 0's and mode 600, so a job, uid 1000 in group 1000 and never in root's, cannot reach it; ${dockerRemedy}`,
    ],
    [
      docker,
      socket(1000, 125, 0o140060),
      `it is uid 1000's, group 125's and mode 060, so a job, uid 1000 in group 1000 and 125, cannot reach it; ${dockerRemedy}`,
    ],
    [
      docker,
      socket(0, 125, 0o140606),
      `it is uid 0's, group 125's and mode 606, so a job, uid 1000 in group 1000 and 125, cannot reach it; ${dockerRemedy}`,
    ],
    [
      podman,
      socket(1000, 1000, 0o140060),
      `it is uid 1000's, group 1000's and mode 060, so a job, uid 1000, this runner's, cannot reach it; ${podmanRemedy}`,
    ],
    [
      podman,
      socket(1234, 1000, 0o140600),
      `it is uid 1234's, group 1000's and mode 600, so a job, uid 1000, this runner's, cannot reach it; ${podmanRemedy}`,
    ],
  ])
    assert.deepEqual(engineSocketReach(engine, stat, 1000), {
      reach: "Unreached",
      why,
    });
});

/**
 * A directory of `mode` in a scratch directory of its own.
 *
 * @param {import("node:test").TestContext} t
 * @param {number} mode
 */
async function volumeDirectory(t, mode) {
  const { home } = await runnerFixture(t, { runner: undefined });
  const directory = join(home, `cache-${mode.toString(8)}`);
  await mkdir(directory);
  await chmod(directory, mode);
  return directory;
}

test("doctor finds each volume a job mounts: a directory that is there, read-only or whether a job may write it, and a named volume there or for the first job to make", async (t) => {
  const uid = process.getuid?.() ?? -1;
  const writable = await volumeDirectory(t, 0o755);
  const readable = await volumeDirectory(t, 0o555);
  const { findings, state } = await doctored(t, {
    runner: {
      volumes: [
        { source: writable, target: "/cache/shared" },
        { source: readable, target: "/cache/read", readonly: true },
        { source: readable, target: "/cache/unwritable" },
        { source: "cargo", target: "/cache/cargo" },
        { source: "npm-cache", target: "/cache/npm", readonly: true },
      ],
    },
    uid,
    volumes: ["cargo"],
  });
  const gid = process.getgid?.() ?? -1;
  assert.deepEqual(
    findings.find((found) => found.check === "volumes"),
    {
      check: "volumes",
      passed: true,
      detail: [
        `${writable} at /cache/shared, which a job may write`,
        `${readable} at /cache/read, read-only`,
        `${readable} at /cache/unwritable, which a job, uid ${String(uid)}, this runner's, may not write: it is uid ${String(uid)}'s, group ${String(gid)}'s and mode 555`,
        "cargo at /cache/cargo, present",
        "npm-cache at /cache/npm, read-only, missing until the first job started through chuggy's runtime makes it",
      ].join("; "),
    },
  );
  assert.deepEqual(
    state.calls
      .filter(({ argv }) => argv[0] === "volume")
      .map(({ argv }) => argv),
    [
      ["volume", "inspect", "cargo"],
      ["volume", "inspect", "npm-cache"],
    ],
  );
});

test("doctor fails a volume whose directory is not there or is no directory, or whose engine could not say whether it is there", async (t) => {
  const { home } = await runnerFixture(t, { runner: undefined });
  const file = join(home, "cache-file");
  await writeFile(file, "");
  /** @type {[Record<string, unknown>, RegExp][]} */
  const cases = [
    [
      { source: join(home, "absent"), target: "/cache" },
      /^ENOENT: no such file or directory, stat '.*\/absent'$/u,
    ],
    [
      { source: file, target: "/cache" },
      /^\S+\/cache-file is not a directory$/u,
    ],
  ];
  for (const [volume, why] of cases) {
    const { findings } = await doctored(t, { runner: { volumes: [volume] } });
    const found = findings.find((finding) => finding.check === "volumes");
    assert.equal(found?.passed, false);
    assert.match(found?.detail ?? "", why);
  }
  const unanswered = await doctored(t, {
    runner: { volumes: [{ source: "cargo", target: "/cache" }] },
    volumesUnanswered: true,
  });
  assert.deepEqual(
    unanswered.findings.find((found) => found.check === "volumes"),
    {
      check: "volumes",
      passed: false,
      detail: "cargo: Error response from daemon: i/o timeout",
    },
  );
});

test("doctor names the limits a pool's entry in pools sets its service, and warns of each entry naming no pool file in the pools directory", async (t) => {
  const own = await doctored(t, {
    runner: { pools: { pool: { concurrencyMax: 0, sessionsMax: 1 } } },
  });
  const ownFound = own.findings.find(
    (finding) => finding.check === "runner configuration",
  );
  assert.equal(ownFound?.passed, true);
  assert.equal(ownFound?.warning, undefined);
  assert.match(
    ownFound?.detail ?? "",
    /\/runner\.json: concurrencyMax 0, sessionsMax 1, as pools\.pool sets them$/u,
  );

  const { findings } = await doctored(t, {
    runner: {
      pools: {
        "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 1 },
        "vteng.chuggy.leed": { concurrencyMax: 0, sessionsMax: 1 },
        "vteng.chuggy.lead.json": { concurrencyMax: 0, sessionsMax: 1 },
      },
    },
    poolFiles: ["vteng.chuggy.lead.json"],
  });
  const found = findings.find(
    (finding) => finding.check === "runner configuration",
  );
  assert.equal(found?.passed, true);
  assert.equal(found?.warning, true);
  const [limits, ...warned] = (found?.detail ?? "").split("; ");
  assert.match(limits, /\/runner\.json: concurrencyMax 1, sessionsMax 2$/u);
  assert.deepEqual(
    warned.map((line) =>
      line.replace(/ in \S+\/chuggy\/pools,/u, " in pools,"),
    ),
    [
      "pools.vteng.chuggy.leed names no pool file in pools, so it limits no service",
      "pools.vteng.chuggy.lead.json names no pool file in pools, so it limits no service",
    ],
  );
});

/** A volume listed as its project's, and its name for the fixture pool's project. */
const projectMount = {
  source: "sccache",
  target: "/cache/sccache",
  scope: "project",
};
const projectVolume = `sccache-${String(poolProjectDigest(fixturePool))}`;

/** The labels of a volume a runner made as a project's. */
const projectLabels = (project) => ({
  "io.chuggy.owner-volume": "",
  "io.chuggy.owner-volume.project": project,
});

test("doctor finds a volume listed as its project's by its name for the pool's project, there labelled as that project's or for the first job to make", async (t) => {
  for (const [labelledVolumes, state] of [
    [{ [projectVolume]: projectLabels("vteng/chuggy") }, "present"],
    [
      {},
      "missing until the first job started through chuggy's runtime makes it",
    ],
  ]) {
    const doctor = await doctored(t, {
      runner: { volumes: [projectMount] },
      labelledVolumes,
    });
    assert.deepEqual(
      doctor.findings.find((found) => found.check === "volumes"),
      {
        check: "volumes",
        passed: true,
        detail: `${projectVolume} at /cache/sccache, vteng/chuggy's alone, ${state}`,
      },
    );
    assert.deepEqual(
      doctor.state.calls
        .filter(({ argv }) => argv[0] === "volume")
        .map(({ argv }) => argv),
      [["volume", "inspect", projectVolume]],
    );
  }
});

test("doctor fails a volume another project's label or none marks where it is listed as its project's, and one a project's label marks where it is listed unscoped", async (t) => {
  /** @type {[Record<string, unknown>, string, Record<string, string>, string][]} */
  const cases = [
    [
      projectMount,
      projectVolume,
      projectLabels("vteng/other"),
      `${projectVolume} is labelled as vteng/other's, not vteng/chuggy's`,
    ],
    [
      projectMount,
      projectVolume,
      {},
      `${projectVolume} is labelled as no project's, and is listed as vteng/chuggy's`,
    ],
    [
      { source: "cargo", target: "/cache/cargo" },
      "cargo",
      projectLabels("vteng/chuggy"),
      "cargo is labelled as vteng/chuggy's, and is listed as no project's",
    ],
  ];
  for (const [volume, name, labels, detail] of cases) {
    const { findings } = await doctored(t, {
      runner: { volumes: [volume] },
      labelledVolumes: { [name]: labels },
    });
    assert.deepEqual(
      findings.find((found) => found.check === "volumes"),
      { check: "volumes", passed: false, detail },
    );
  }
});

/** A member's personal runner's file. */
const personalPool = {
  kind: "Personal",
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/0f3c9a52-member",
  capabilities: ["container"],
  tokenUrl: "https://issuer.chuggy.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  clientId: "personal-client",
  clientSecret: "personal-client-secret",
};

test("doctor names a volume a personal runner lists as its project's as each job's own, without looking for it, and finds the rest", async (t) => {
  const { findings, state } = await doctored(t, {
    pool: personalPool,
    runner: {
      volumes: [{ source: "cargo", target: "/cache/cargo" }, projectMount],
    },
    volumes: ["cargo"],
  });
  assert.deepEqual(
    findings.find((found) => found.check === "volumes"),
    {
      check: "volumes",
      passed: true,
      detail:
        "cargo at /cache/cargo, present; sccache is scoped per project: each job mounts its own project's, which, where it is missing, the first job in that project started through chuggy's runtime makes",
    },
  );
  assert.deepEqual(
    state.calls
      .filter(({ argv }) => argv[0] === "volume")
      .map(({ argv }) => argv),
    [["volume", "inspect", "cargo"]],
  );
});

test("doctor that fails a personal runner's volume still names those it scopes per project", async (t) => {
  const { findings } = await doctored(t, {
    pool: personalPool,
    runner: {
      volumes: [{ source: "cargo", target: "/cache/cargo" }, projectMount],
    },
    labelledVolumes: { cargo: projectLabels("vteng/chuggy") },
  });
  assert.deepEqual(
    findings.find((found) => found.check === "volumes"),
    {
      check: "volumes",
      passed: false,
      detail:
        "cargo is labelled as vteng/chuggy's, and is listed as no project's; sccache is scoped per project: each job mounts its own project's, which, where it is missing, the first job in that project started through chuggy's runtime makes",
    },
  );
});

test("a job may write an owner's directory by the write and search bits its uid and groups are read by, under docker its own and its group's, and under podman the runner's", () => {
  const runnerUid = 1234;
  /** @type {["docker" | "podman", {uid: number, gid: number, mode: number}, boolean][]} */
  const cases = [
    ["docker", { uid: 1000, gid: 0, mode: 0o700 }, true],
    ["docker", { uid: 1000, gid: 0, mode: 0o600 }, false],
    ["docker", { uid: 1000, gid: 1000, mode: 0o500 }, false],
    ["docker", { uid: 1000, gid: 1000, mode: 0o077 }, false],
    ["docker", { uid: 0, gid: 1000, mode: 0o770 }, true],
    ["docker", { uid: 0, gid: 1000, mode: 0o750 }, false],
    ["docker", { uid: 0, gid: 0, mode: 0o773 }, true],
    ["docker", { uid: 0, gid: 0, mode: 0o775 }, false],
    ["docker", { uid: runnerUid, gid: 0, mode: 0o700 }, false],
    ["podman", { uid: runnerUid, gid: 0, mode: 0o700 }, true],
    ["podman", { uid: 1000, gid: 1000, mode: 0o770 }, false],
    ["podman", { uid: 0, gid: 0, mode: 0o1777 }, true],
  ];
  for (const [engine, directory, writable] of cases)
    assert.equal(
      volumeDirectoryWritable(engine, directory, runnerUid),
      writable,
      `${engine} ${JSON.stringify(directory)}`,
    );
});

/**
 * Files a suite writes, owner-only, in a directory of their own.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files each one's text, by name
 * @param {number} mode
 */
async function filesWritten(t, files, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(directory, name), text, { mode });
    await chmod(join(directory, name), mode);
  }
  return directory;
}

/** What each fixture file holds that is secret, which no finding may print. */
const claudeSecrets = {
  "claude-token": "sk-ant-oat01-fixture-token",
  "api-key": "sk-ant-api03-fixture-key",
  "bedrock-key": "ABSKfixturebedrockkey",
  aws: "fixtureAwsSecretAccessKey",
  aws_id: "AKIAFIXTUREACCESSKEY",
  google: "fixture-private-key-body",
  google_id: "fixture-private-key-id",
};

/** Each kind's file, its text holding the secrets above. */
const claudeFiles = {
  "claude-token": `${claudeSecrets["claude-token"]}\n`,
  "api-key": claudeSecrets["api-key"],
  "bedrock-key": claudeSecrets["bedrock-key"],
  aws: `[default]\naws_access_key_id = AKIAOTHERPROFILE\naws_secret_access_key = other\n[chuggy]\naws_access_key_id = ${claudeSecrets.aws_id}\naws_secret_access_key = ${claudeSecrets.aws}\n`,
  "google.json": JSON.stringify({
    type: "service_account",
    project_id: "chuggy-jobs",
    private_key_id: claudeSecrets.google_id,
    private_key: `-----BEGIN PRIVATE KEY-----\n${claudeSecrets.google}\n-----END PRIVATE KEY-----\n`,
    client_email: "jobs@chuggy-jobs.iam.gserviceaccount.com",
  }),
};

test("the Claude credential check names the kind and its settings, and never what its file holds", async (t) => {
  const directory = await filesWritten(t, claudeFiles);
  const at = (/** @type {string} */ name) => join(directory, name);
  for (const [runner, detail] of [
    [
      { claudeTokenFile: at("claude-token") },
      `Subscription, from the Claude token file ${at("claude-token")}, this runner's own`,
    ],
    [
      { claudeCredential: { kind: "ApiKey", apiKeyFile: at("api-key") } },
      `ApiKey, from the Anthropic API key file ${at("api-key")}, this runner's own`,
    ],
    [
      {
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          apiKeyFile: at("bedrock-key"),
        },
      },
      `Bedrock, region us-west-2, from the Bedrock API key file ${at("bedrock-key")}, this runner's own`,
    ],
    [
      {
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          credentialsFile: at("aws"),
          profile: "chuggy",
        },
      },
      `Bedrock, region us-west-2, profile chuggy, from the AWS credentials file ${at("aws")}, this runner's own`,
    ],
    [
      {
        claudeCredential: {
          kind: "Vertex",
          region: "us-east5",
          project: "chuggy-jobs",
          credentialsFile: at("google.json"),
        },
      },
      `Vertex, region us-east5, project chuggy-jobs, from the Google service account key file ${at("google.json")}, this runner's own`,
    ],
    [
      {
        claudeCredential: {
          kind: "Foundry",
          resource: "chuggy-jobs",
          apiKeyFile: at("api-key"),
        },
      },
      `Foundry, resource chuggy-jobs, from the Foundry API key file ${at("api-key")}, this runner's own`,
    ],
  ]) {
    const { findings } = await doctored(t, {
      runner: { claudeTokenFile: undefined, ...runner },
    });
    assert.deepEqual(
      findings.find((found) => found.check === "Claude credential"),
      { check: "Claude credential", passed: true, detail },
    );
    const said = findings.map(findingLine).join("\n");
    for (const secret of Object.values(claudeSecrets))
      assert.equal(said.includes(secret), false, secret);
  }
});

test("a Claude credential's file that is no credential of its kind fails the check, saying what it lacks and never what it holds", async (t) => {
  const secret = "sk-ant-fixture-never-printed";
  const directory = await filesWritten(t, {
    "two-lines": `${secret}\n${secret}\n`,
    blank: " \n\n",
    "no-profile": `[default]\naws_access_key_id = ${secret}\naws_secret_access_key = ${secret}\n`,
    "no-secret": `[chuggy]\naws_access_key_id = ${secret}\n`,
    "not-json": `{"private_key": "${secret}"`,
    "not-service-account": JSON.stringify({
      type: "authorized_user",
      refresh_token: secret,
    }),
    "no-private-key": JSON.stringify({
      type: "service_account",
      private_key_id: secret,
    }),
  });
  const at = (/** @type {string} */ name) => join(directory, name);
  /** @param {string} name */
  const bedrock = (name) => ({
    kind: "Bedrock",
    region: "us-west-2",
    credentialsFile: at(name),
    profile: "chuggy",
  });
  /** @param {string} name */
  const vertex = (name) => ({
    kind: "Vertex",
    region: "us-east5",
    project: "chuggy-jobs",
    credentialsFile: at(name),
  });
  for (const [claudeCredential, detail] of [
    [
      { kind: "Subscription", tokenFile: at("two-lines") },
      `the Claude token file ${at("two-lines")} holds more than one line; save \`claude setup-token\`'s output there, alone`,
    ],
    [
      { kind: "ApiKey", apiKeyFile: at("blank") },
      `the Anthropic API key file ${at("blank")} is empty; save a key from the Claude Console there, alone`,
    ],
    [
      bedrock("no-profile"),
      `the AWS credentials file ${at("no-profile")} has no [chuggy] profile; name the profile its keys are under, or give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key`,
    ],
    [
      bedrock("no-secret"),
      `the AWS credentials file ${at("no-secret")} gives its [chuggy] profile no aws_secret_access_key; give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key`,
    ],
    [
      vertex("not-json"),
      `the Google service account key file ${at("not-json")} is not JSON; save the JSON key Google Cloud made for a service account there`,
    ],
    [
      vertex("not-service-account"),
      `the Google service account key file ${at("not-service-account")} is not a service account's key; save the JSON key Google Cloud made for a service account there`,
    ],
    [
      vertex("no-private-key"),
      `the Google service account key file ${at("no-private-key")} holds no private_key; save the JSON key Google Cloud made for a service account there`,
    ],
  ]) {
    const { findings } = await doctored(t, {
      runner: { claudeTokenFile: undefined, claudeCredential },
    });
    assert.deepEqual(
      findings.find((found) => found.check === "Claude credential"),
      { check: "Claude credential", passed: false, detail },
    );
    assert.equal(findings.map(findingLine).join("\n").includes(secret), false);
  }
});

test("on a pool registered with --host, the Claude credential check names the claude a job on this machine itself runs, on the PATH it is started with, and warns, passing, where there is none", async (t) => {
  const bin = await filesWritten(t, { claude: "#!/bin/sh\n" }, 0o700);
  const empty = await filesWritten(t, {});
  await mkdir(join(empty, "claude"));
  const claude = join(bin, "claude");
  const serviceBin = await filesWritten(t, { claude: "#!/bin/sh\n" }, 0o700);
  const pool = { ...fixturePool, host: true };
  const agentVersions = { [claude]: "2.1.282 (Claude Code)" };
  /**
   * Whether the check passed or warned, and what it says past the credential.
   *
   * @param {Parameters<typeof doctored>[1]} options
   */
  const found = async (options) => {
    const { findings } = await doctored(t, {
      pool,
      agentVersions,
      ...options,
    });
    const finding = findings.find(
      (found) => found.check === "Claude credential",
    );
    const [credential, ...rest] = (finding?.detail ?? "").split("; ");
    assert.match(
      credential,
      /^Subscription, from the Claude token file \/.*\/claude-token, this runner's own$/u,
    );
    return {
      passed: finding?.passed,
      warning: finding?.warning ?? false,
      host: rest.join("; "),
    };
  };
  for (const [options, whose] of [
    [
      {
        runner: { environment: { PATH: `${empty}:relative:${bin}` } },
        servicePath: serviceBin,
      },
      "the PATH the runner's file sets",
    ],
    [
      { servicePath: `${empty}:${bin}`, path: empty },
      "the PATH the service manager starts the runner with",
    ],
    [{ path: bin }, "doctor's own PATH"],
  ])
    assert.deepEqual(await found(options), {
      passed: true,
      warning: false,
      host: `a job on this machine itself runs ${claude}, 2.1.282 (Claude Code), found on ${whose}`,
    });
  assert.deepEqual(await found({ path: bin, agentVersions: {} }), {
    passed: true,
    warning: false,
    host: `a job on this machine itself runs ${claude}, which says no version, found on doctor's own PATH`,
  });
  assert.deepEqual(await found({ servicePath: empty, path: bin }), {
    passed: true,
    warning: true,
    host: `no claude is on the PATH the service manager starts the runner with, ${empty}, so a job on this machine itself runs no Claude Code`,
  });
  assert.equal(
    (await found({ path: relative(process.cwd(), bin) })).warning,
    true,
  );
  await chmod(claude, 0o600);
  assert.equal((await found({ path: bin })).warning, true);
  assert.deepEqual(await found({ pool: fixturePool, path: bin }), {
    passed: true,
    warning: false,
    host: "",
  });
});

/** The remedy a refusal of the Codex credential's file names. */
const codexRemedy = "run codex login, which writes it to ~/.codex/auth.json";

/** What the Codex fixture file holds that is secret, which no finding may print. */
const codexSecret = "codex-refresh-token-fixture";

/** A pool registered declaring `Agent:Codex`. */
const codexPool = {
  ...fixturePool,
  capabilities: ["container", "Agent:Codex"],
};

/** An image its owner lists as running Codex. */
const codexImages = [
  { image: "registry.example/codex", capabilities: ["Agent:Codex"] },
];

/**
 * Catches the Codex file's check printing what it holds, or appearing on a
 * runner neither whose file nor whose pool names Codex.
 */
test("the Codex credential check names its file and never what it holds, and is made only where the runner's file or the pool names Codex", async (t) => {
  const directory = await filesWritten(t, {
    "auth.json": JSON.stringify({ tokens: { refresh_token: codexSecret } }),
  });
  const authFile = join(directory, "auth.json");
  const { findings } = await doctored(t, {
    pool: codexPool,
    runner: { codexCredential: { authFile }, images: codexImages },
  });
  assert.deepEqual(
    findings.find((found) => found.check === "Codex credential"),
    {
      check: "Codex credential",
      passed: true,
      detail: `the Codex auth file ${authFile}, this runner's own`,
    },
  );
  assert.equal(
    findings.map(findingLine).join("\n").includes(codexSecret),
    false,
  );
  const unnamed = await doctored(t);
  assert.equal(
    unnamed.findings.some((found) => found.check === "Codex credential"),
    false,
  );
});

/**
 * Catches a Codex file no core could read passed, its text or a parser's
 * message printed, or one a job cannot be handed passed.
 */
test("a Codex credential's file that is no JSON object, or that a job cannot be handed, fails the check, never naming what it holds", async (t) => {
  for (const text of [
    `["${codexSecret}"]`,
    `{"refresh_token": ${codexSecret}`,
    "null",
    `"${codexSecret}"`,
  ]) {
    const directory = await filesWritten(t, { "auth.json": text });
    const authFile = join(directory, "auth.json");
    const { findings } = await doctored(t, {
      pool: codexPool,
      runner: { codexCredential: { authFile } },
    });
    assert.deepEqual(
      findings.find((found) => found.check === "Codex credential"),
      {
        check: "Codex credential",
        passed: false,
        detail: `the Codex auth file ${authFile} is not a JSON object; ${codexRemedy}`,
      },
      text,
    );
    assert.equal(
      findings.map(findingLine).join("\n").includes(codexSecret),
      false,
    );
  }
  const shared = await filesWritten(t, { "auth.json": "{}" }, 0o640);
  const missing = join(shared, "missing.json");
  for (const [authFile, detail] of [
    [
      join(shared, "auth.json"),
      /is mode 640; only its owner may read or write it/u,
    ],
    [
      missing,
      new RegExp(`^the Codex auth file ${missing} cannot be found; `, "u"),
    ],
  ]) {
    const { findings } = await doctored(t, {
      pool: codexPool,
      runner: { codexCredential: { authFile } },
    });
    const finding = findings.find(
      (found) => found.check === "Codex credential",
    );
    assert.equal(finding?.passed, false);
    assert.match(finding?.detail ?? "", detail);
  }
});

/**
 * Catches a pool whose Codex jobs are handed the Claude credential's file
 * passing unwarned, or failing doctor, which would stop register starting
 * it, and one warned of that advertises no Codex.
 */
test("a pool advertising Agent:Codex is warned of, and passes, where the runner's file names no codexCredential, its Codex jobs handed the Claude credential's file", async (t) => {
  for (const runner of [
    { images: codexImages },
    { capabilities: ["Agent:Codex"] },
  ]) {
    const { findings } = await doctored(t, { pool: codexPool, runner });
    const finding = findings.find(
      (found) => found.check === "Codex credential",
    );
    assert.equal(finding?.passed, true, JSON.stringify(runner));
    assert.equal(finding?.warning, true);
    assert.match(
      finding?.detail ?? "",
      /^this pool advertises Agent:Codex and \/.*\/runner\.json names no codexCredential, so its Codex jobs are handed the Claude credential's file; add codexCredential to hand them a Codex auth\.json$/u,
    );
  }
  const unrun = await doctored(t, { pool: codexPool });
  assert.equal(
    unrun.findings.some((found) => found.check === "Codex credential"),
    false,
  );
});

/**
 * Catches a Codex credential no pool here brings a job to passing unwarned,
 * or warned of where this pool or another here advertises Agent:Codex.
 */
test("a Codex credential no pool here advertises Agent:Codex for is warned of, and passes where an image, or another pool's host, runs Codex", async (t) => {
  const directory = await filesWritten(t, { "auth.json": "{}" });
  const authFile = join(directory, "auth.json");
  /** @param {Parameters<typeof doctored>[1]} options */
  const found = async (options) =>
    (await doctored(t, options)).findings.find(
      (finding) => finding.check === "Codex credential",
    );
  const own = `the Codex auth file ${authFile}, this runner's own`;
  for (const options of [
    { runner: { codexCredential: { authFile }, images: codexImages } },
    {
      runner: { codexCredential: { authFile } },
      registered: {
        "vteng.chuggy.other.json": {
          ...fixturePool,
          pool: "other",
          host: true,
        },
      },
    },
  ])
    assert.deepEqual(await found(options), {
      check: "Codex credential",
      passed: true,
      detail: own,
    });
  for (const options of [
    { runner: { codexCredential: { authFile } } },
    {
      runner: { codexCredential: { authFile } },
      registered: { "vteng.chuggy.other.json": codexPool },
    },
  ])
    assert.deepEqual(await found(options), {
      check: "Codex credential",
      passed: true,
      warning: true,
      detail: `${own}; no pool here advertises Agent:Codex, since no images entry declares it and no pool here was registered with --host, so no job requiring Agent:Codex reaches this runner`,
    });
});

/**
 * Catches a host job's Codex left unnamed, or its absence passing unwarned.
 */
test("on a pool registered with --host, the Codex credential check names the codex a job on this machine itself runs, and warns, passing, where there is none", async (t) => {
  const directory = await filesWritten(t, { "auth.json": "{}" });
  const authFile = join(directory, "auth.json");
  const bin = await filesWritten(t, { codex: "#!/bin/sh\n" }, 0o700);
  const empty = await filesWritten(t, {});
  const codex = join(bin, "codex");
  /** @param {string} path */
  const found = async (path) =>
    (
      await doctored(t, {
        pool: { ...codexPool, host: true },
        runner: { codexCredential: { authFile } },
        path,
        agentVersions: { [codex]: "codex-cli 0.50.0" },
      })
    ).findings.find((finding) => finding.check === "Codex credential");
  const own = `the Codex auth file ${authFile}, this runner's own`;
  assert.deepEqual(await found(bin), {
    check: "Codex credential",
    passed: true,
    detail: `${own}; a job on this machine itself runs ${codex}, codex-cli 0.50.0, found on doctor's own PATH`,
  });
  assert.deepEqual(await found(empty), {
    check: "Codex credential",
    passed: true,
    warning: true,
    detail: `${own}; no codex is on doctor's own PATH, ${empty}, so a job on this machine itself runs no Codex`,
  });
});
