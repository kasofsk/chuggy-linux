import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  doctorFindings,
  engineSocketReach,
  findingLine,
  volumeDirectoryWritable,
} from "./doctor.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import {
  engineSocketFixture,
  fixturePool,
  runnerFixture,
} from "./runner.fixture.mjs";
import { serviceUnit } from "./systemdUnit.mjs";

/** The copy doctor is run as, and the Node it runs under. */
const copy = { node: "/opt/node/bin/node", cli: "/opt/chuggy-linux/cli.mjs" };

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, pool?: Record<string, unknown>, token?: unknown, uid?: number, securityOptions?: string[], podmanVersion?: string, podmanServiceRemote?: string, podmanSocket?: string, contextHost?: string, registries?: Record<string, string>, unit?: (poolFile: string, unit: string) => Promise<unknown>, poolFileName?: string, volumes?: string[], volumesUnanswered?: boolean}} options podman's registries.conf and its drop-ins, by path under a directory of their own, what makes the pool file's unit, the name of a pool file in the home to ask of in place of the fixture's, and the named volumes the engine has
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
  const paths = runnerPaths(environment, home);
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
  for (const volume of options.volumes ?? []) state.volumes.set(volume, {});
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
    parts: {
      engine: () => engine,
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
  return { findings, state, polls, poolFile, registries, unit };
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
      ["Claude token file", true],
      ["podman credential helpers", true],
      ["service unit", true],
      ["container engine", true],
      ["engine socket", true],
      ["job network", true],
      ["volumes", true],
      ["pool token", true],
      ["plane", true],
    ],
  );
  assert.equal(findings[0].detail, `${poolFile} names pool vteng/chuggy/shame`);
  assert.match(
    findings[1].detail,
    /\/chuggy-linux\/runner\.json: concurrencyMax 1, sessionsMax 2$/u,
  );
  assert.deepEqual(findings[4], {
    check: "podman credential helpers",
    passed: true,
    detail: "none named in the 0 registries.conf files read",
  });
  assert.deepEqual(findings[7], {
    check: "engine socket",
    passed: true,
    detail: "off",
  });
  assert.equal(
    findings[8].detail,
    "chuggy-jobs is missing, and a run makes it",
  );
  assert.equal(findings[9].detail, "none");
  assert.deepEqual(polls, [["pool-token", [], 0, 0]]);
  assert.deepEqual(
    state.calls.map((call) => call.argv[0]),
    ["version", "info", "ps", "network"],
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
    verbs: ["info", "context", "ps", "network"],
  });
  const rootless = await engineFinding(["name=rootless", "name=cgroupns"]);
  assert.equal(rootless.finding?.passed, false);
  assert.match(
    rootless.finding?.detail ?? "",
    /^docker is running rootless, .*; use rootful docker without userns-remap, or rootless podman/u,
  );
  assert.deepEqual(rootless.verbs, ["info"]);
});

test("under docker, a runner that is not uid 1000 fails the Claude token file check", async (t) => {
  const { findings } = await doctored(t, {
    runner: { engine: "docker" },
    uid: 1234,
  });
  const finding = findings.find((found) => found.check === "Claude token file");
  assert.equal(finding?.passed, false);
  assert.match(
    finding?.detail ?? "",
    /docker runs a job as uid 1000, and this runner is uid 1234.*use rootless podman/u,
  );
});

test("a credential helper podman's registries.conf sets is warned of, and passes", async (t) => {
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
    "40-quoted",
    "50-literal",
    "60-commented",
    "80-hash",
  ].map((name) => join(registries, "registries.conf.d", `${name}.conf`));
  assert.deepEqual(finding, {
    check: "podman credential helpers",
    passed: true,
    warning: true,
    detail: `${warned.join(", ")} name a credential helper, whose logins podman presents on every pull, the pool's token notwithstanding`,
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

test("a podman that reads this machine's stored logins fails the engine check", async (t) => {
  const { findings, state } = await doctored(t, { podmanVersion: "4.3.1" });
  assert.deepEqual(
    findings.find((found) => found.check === "container engine"),
    {
      check: "container engine",
      passed: false,
      detail:
        "podman 4.3.1 reads this machine's stored logins even when told not to; podman 4.4 or later is required",
    },
  );
  assert.ok(!findings.some((found) => found.check === "job network"));
  assert.ok(state.calls.every((call) => call.argv[0] === "version"));
});

test("the registries.conf files read are counted, and podman's own default helper is none", async (t) => {
  for (const [registries, detail] of [
    [
      { "registries.conf": 'credential-helpers = ["containers-auth.json"]\n' },
      "none named in the 1 registries.conf file read",
    ],
    [
      {
        "registries.conf": 'credential-helpers = ["containers-auth.json"]\n',
        "registries.conf.d/10-search.conf":
          'unqualified-search-registries = ["docker.io"]\n',
      },
      "none named in the 2 registries.conf files read",
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
    ["info", "context", "ps", "network"],
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
