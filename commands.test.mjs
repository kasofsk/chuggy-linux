import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { cliMain } from "./commands.mjs";
import { controlSocketPath } from "./control.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import { answeringFetch, registeredFixture } from "./register.fixture.mjs";
import { poolRuntimeDirectory, runtimeDirectory } from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import {
  fixturePool,
  poolFileWritten,
  runnerFixture,
} from "./runner.fixture.mjs";
import { serviceUnit } from "./systemdUnit.mjs";

/**
 * @typedef {object} Machine
 * @property {Record<string, string>} [environment]
 * @property {string} [home]
 * @property {string} [hostname]
 * @property {string} [arch]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {import("./engine.mjs").Engine} [engine]
 */

/** A token source whose issuer has revoked the pool, so a pass ends without the network. */
const deniedTokens = {
  acquire: async () => ({
    acquired: "Denied",
    evidence: "the pool was revoked",
  }),
  invalidate: () => undefined,
};

/**
 * @param {readonly string[]} argv
 * @param {Machine} machine
 */
async function called(argv, machine = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const status = await cliMain(argv, {
    environment: machine.environment ?? {},
    home: machine.home ?? "/nonexistent",
    uid: 1000,
    hostname: machine.hostname ?? "shame",
    arch: machine.arch ?? "x64",
    fetch:
      machine.fetch ??
      (async () => {
        throw new Error("a suite reaches no network");
      }),
    engine: machine.engine ?? fakeEngine().engine,
    tokens: deniedTokens,
    node: "/opt/node/bin/node",
    cli: "/opt/chuggy-linux/cli.mjs",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/**
 * A machine's files with a runtime directory short enough for a socket's path.
 *
 * @param {import("node:test").TestContext} t
 * @param {Parameters<typeof runnerFixture>[1]} [documents]
 */
async function served(t, documents) {
  const fixture = await runnerFixture(t, documents);
  const runtime = await mkdtemp("/tmp/chuggy-linux-run-");
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const environment = { ...fixture.environment, XDG_RUNTIME_DIR: runtime };
  return {
    ...fixture,
    environment,
    paths: runnerPaths(environment, fixture.home),
  };
}

/**
 * Writes the legacy unit serving `poolFile`.
 *
 * @param {string} units
 * @param {string} poolFile
 */
async function legacyUnitWritten(units, poolFile) {
  const unit = join(units, "chuggy-linux.service");
  await mkdir(units, { recursive: true });
  await writeFile(
    unit,
    serviceUnit({ node: "/old/node", cli: "/old/cli.mjs", poolFile }),
  );
  return unit;
}

test("help is asked for and answered", async () => {
  for (const argv of [["--help"], ["help"], ["-h"]]) {
    const { status, out } = await called(argv);
    assert.equal(status, 0);
    assert.match(out, /^usage: chuggy-linux <command>/u);
  }
});

test("a call asked wrongly exits 2 with the usage", async () => {
  for (const argv of [
    [],
    ["launch", "--pool", "/p"],
    ["run", "--pool"],
    ["run", "--pools", "/p"],
    ["stop", "--pool", "/p"],
    ["stop", "a", "b", "--pool", "/p"],
    ["status", "extra", "--pool", "/p"],
  ]) {
    const { status, err } = await called(argv);
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, /usage: chuggy-linux/u, argv.join(" "));
  }
});

test("a command needs a pool file, named by --pool or CHUGGY_LINUX_POOL", async () => {
  const { status, err } = await called(["doctor"]);
  assert.equal(status, 2);
  assert.match(
    err,
    /^no pool file: name one with --pool or CHUGGY_LINUX_POOL/u,
  );
});

test("install-service writes the pool file's own unit, which runs this CLI under this Node, and prints how to start it", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const { status, out } = await called(["install-service"], {
    home,
    environment: { ...environment, CHUGGY_LINUX_POOL: poolFile },
  });
  assert.equal(status, 0);
  const unit = join(
    environment.XDG_CONFIG_HOME,
    "systemd",
    "user",
    "chuggy-linux-pool.service",
  );
  assert.match(
    await readFile(unit, "utf8"),
    new RegExp(
      `^ExecStart="/opt/node/bin/node" "/opt/chuggy-linux/cli.mjs" "run" "--pool" "${poolFile}"$`,
      "mu",
    ),
  );
  assert.equal(
    out,
    [
      `wrote ${unit}; start it with:`,
      "  systemctl --user daemon-reload",
      "  systemctl --user enable --now chuggy-linux-pool.service",
      "  loginctl enable-linger",
    ].join("\n"),
  );
});

test("install-service writes nothing for a pool file it cannot read", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: { tenant: "vteng" },
  });
  const { status, err } = await called(
    ["install-service", "--pool", poolFile],
    { home, environment },
  );
  assert.equal(status, 1);
  assert.match(err, /^pool credentials .*: project /u);
  await assert.rejects(stat(join(environment.XDG_CONFIG_HOME, "systemd")), {
    code: "ENOENT",
  });
});

test("doctor exits 1 on a failed check, printing every check it made", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: { tenant: "vteng" },
    runner: undefined,
  });
  const { status, out, err } = await called(["doctor", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status, 1);
  assert.equal(
    out,
    `ok    runtime directory: ${join(environment.XDG_RUNTIME_DIR, "chuggy-linux")}`,
  );
  assert.match(
    err,
    /^FAIL {2}pool file: pool credentials .*\nFAIL {2}runner configuration: .*ENOENT/u,
  );
});

test("doctor prints a warning with the failures, on stderr and never on stdout, of the user's registries.conf and one the environment names", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t, {
    pool: { tenant: "vteng" },
  });
  const registries = join(
    environment.XDG_CONFIG_HOME,
    "containers",
    "registries.conf",
  );
  await mkdir(dirname(registries), { recursive: true });
  await writeFile(registries, 'credential-helpers = ["secretservice"]\n');
  const named = join(home, "named.conf");
  await writeFile(named, 'credential-helpers = ["pass"]\n');
  const { out, err } = await called(["doctor", "--pool", poolFile], {
    home,
    environment: { ...environment, CONTAINERS_REGISTRIES_CONF: named },
  });
  const warned = err
    .split("\n")
    .filter((line) => line.startsWith("warn  podman credential helpers: "));
  assert.equal(warned.length, 1, err);
  assert.ok(warned[0].includes(registries), warned[0]);
  assert.ok(warned[0].includes(named), warned[0]);
  assert.ok(!out.includes("podman credential helpers"), out);
  assert.match(out, /^ok {4}runner configuration: /mu);
});

test("two pools' files get two units, and installing one leaves the other's alone", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const other = await poolFileWritten(
    join(home, "newtenant.arbbot.shame.json"),
    {
      ...fixturePool,
      tenant: "newtenant",
      project: "arbbot",
    },
  );
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  assert.equal(
    (
      await called(["install-service", "--pool", poolFile], {
        home,
        environment,
      })
    ).status,
    0,
  );
  const first = await readFile(
    join(units, "chuggy-linux-pool.service"),
    "utf8",
  );
  const { status, out } = await called(["install-service", "--pool", other], {
    home,
    environment,
  });
  assert.equal(status, 0);
  assert.deepEqual((await readdir(units)).sort(), [
    "chuggy-linux-newtenant.arbbot.shame.service",
    "chuggy-linux-pool.service",
  ]);
  assert.equal(
    await readFile(join(units, "chuggy-linux-pool.service"), "utf8"),
    first,
  );
  assert.match(
    out,
    /^ {2}systemctl --user enable --now chuggy-linux-newtenant\.arbbot\.shame\.service$/mu,
  );
});

test("install-service refuses a unit of the pool file's name that serves another pool file", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const elsewhere = await poolFileWritten(
    join(home, "elsewhere", "pool.json"),
    {
      ...fixturePool,
      project: "arbbot",
    },
  );
  assert.equal(
    (
      await called(["install-service", "--pool", poolFile], {
        home,
        environment,
      })
    ).status,
    0,
  );
  const unit = join(
    environment.XDG_CONFIG_HOME,
    "systemd",
    "user",
    "chuggy-linux-pool.service",
  );
  const written = await readFile(unit, "utf8");
  const { status, err } = await called(
    ["install-service", "--pool", elsewhere],
    {
      home,
      environment,
    },
  );
  assert.equal(status, 1);
  assert.equal(
    err,
    `${unit} serves ${poolFile}, not ${elsewhere}; remove that unit if it is stale, or rename the pool file`,
  );
  assert.equal(await readFile(unit, "utf8"), written);
  assert.equal(
    (
      await called(["install-service", "--pool", poolFile], {
        home,
        environment,
      })
    ).status,
    0,
  );
});

test("where the legacy unit serves the same pool, install-service leaves it and says to retire it before starting the pool's own", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  const legacyFile = await poolFileWritten(
    join(home, "vteng-chuggy-shame.json"),
    fixturePool,
  );
  const legacy = await legacyUnitWritten(units, legacyFile);
  const before = await readFile(legacy, "utf8");
  const { status, out } = await called(
    ["install-service", "--pool", poolFile],
    {
      home,
      environment,
    },
  );
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${join(units, "chuggy-linux-pool.service")}; chuggy-linux.service serves this pool already, so retire it and start this one with:`,
      "  systemctl --user disable --now chuggy-linux.service",
      `  rm ${legacy}`,
      "  systemctl --user daemon-reload",
      "  systemctl --user enable --now chuggy-linux-pool.service",
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.equal(await readFile(legacy, "utf8"), before);
});

test("where the legacy unit serves another pool, or a file it cannot read, install-service leaves it to run beside the pool's own", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  const legacyFile = await poolFileWritten(join(home, "other.json"), {
    ...fixturePool,
    tenant: "newtenant",
    project: "arbbot",
  });
  const legacy = await legacyUnitWritten(units, legacyFile);
  const before = await readFile(legacy, "utf8");
  const { status, out } = await called(
    ["install-service", "--pool", poolFile],
    {
      home,
      environment,
    },
  );
  assert.equal(status, 0);
  assert.match(out, /^wrote .*chuggy-linux-pool\.service; start it with:$/mu);
  assert.doesNotMatch(out, /disable|rm /u);
  assert.equal(await readFile(legacy, "utf8"), before);
  await rm(legacyFile);
  const unread = await called(["install-service", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(unread.status, 0, unread.err);
  assert.doesNotMatch(unread.out, /disable|rm /u);
});

test("once is refused while this pool's service runs, and not while another pool's does", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  await controlServed(
    t,
    controlSocketPath(
      poolRuntimeDirectory(paths, { ...fixturePool, project: "arbbot" }),
    ),
  );
  const passed = await called(["once", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(passed.status, 3, passed.err);
  assert.equal(passed.err, "Denied: the pool was revoked");
  await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const refused = await called(["once", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(refused.status, 1);
  assert.equal(
    refused.err,
    "a chuggy-linux service is running this pool; stop it before a pass of your own",
  );
});

test("once is refused while a legacy service serving this pool runs, and not while one serving another pool does", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  await controlServed(t, controlSocketPath(runtimeDirectory(paths)));
  const legacyFile = await poolFileWritten(join(home, "legacy.json"), {
    ...fixturePool,
    project: "arbbot",
  });
  await legacyUnitWritten(paths.units, legacyFile);
  assert.equal(
    (await called(["once", "--pool", poolFile], { home, environment })).status,
    3,
  );
  await legacyUnitWritten(paths.units, poolFile);
  const refused = await called(["once", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(refused.status, 1);
  assert.match(refused.err, /^a chuggy-linux service is running this pool/u);
});

test("status and stop reach this pool's service", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  const { stopped } = await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const status = await called(["status", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(
    status.out,
    `service: running\n${inFlightFixture.name}  pulling  i  asg-1`,
  );
  const stop = await called(["stop", "asg-1", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(stop.status, 0);
  assert.equal(stop.out, "stopped asg-1");
  assert.deepEqual(stopped, ["asg-1"]);
});

test("a run is refused while a legacy service serving its pool runs", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  await controlServed(t, controlSocketPath(runtimeDirectory(paths)));
  await legacyUnitWritten(paths.units, poolFile);
  const { status, err } = await called(["run", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status, 1);
  assert.equal(
    err,
    "chuggy-linux.service is running this pool; stop it before starting another service of it",
  );
});

test("a second run of a pool is refused before it removes anything of the first's", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await controlServed(t, controlSocketPath(runtime));
  await mkdir(join(runtime, "pull-1-inflight"));
  const { status, err } = await called(["run", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status, 1);
  assert.match(err, /^a chuggy-linux service already answers at /u);
  assert.deepEqual((await readdir(runtime)).sort(), [
    "control.sock",
    "pull-1-inflight",
  ]);
});

const registerArgv = [
  "register",
  "--api",
  "https://chuggy.example",
  "--token=registration-token-fixture",
];

test("register writes the pool file it redeems the token for, prints what to run next, and prints no secret", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, out, err } = await called(registerArgv, {
    home,
    environment: { ...environment, CHUGGY_LINUX_POOL: "/elsewhere.json" },
    hostname: "Shame.lan",
    fetch,
  });
  assert.equal(status, 0, err);
  const pools = join(environment.XDG_CONFIG_HOME, "chuggy", "pools");
  const file = join(pools, "newtenant.arbbot.shame.json");
  assert.equal(
    out,
    [
      `wrote ${file}; next:`,
      `  chuggy-linux doctor --pool ${file}`,
      `  chuggy-linux install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(err, "");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)).pool, "shame");
  assert.equal((await stat(pools)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registeredFixture);
  assert.ok(!`${out}${err}`.includes(registeredFixture.clientSecret));
  const again = await called(registerArgv, { home, environment, fetch });
  assert.match(again.out, /^replaced /u);
});

test("register asked wrongly exits 2 before the token is spent", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  for (const [argv, machine, line] of [
    [registerArgv, { arch: "ia32" }, /^this machine is ia32/u],
    [
      [...registerArgv, "--pool", "Shame"],
      {},
      /^--pool Shame is not a pool name/u,
    ],
    [
      ["register", "--api", "https://chuggy.example"],
      {},
      /^register needs --api and --token$/u,
    ],
    [[...registerArgv, "extra"], {}, /^usage: chuggy-linux/u],
    [["run", "--pool", "/p", "--token", "t"], {}, /^usage: chuggy-linux/u],
    [
      ["status", "--pool", "/p", "--api", "https://chuggy.example"],
      {},
      /^usage: chuggy-linux/u,
    ],
  ]) {
    const { status, err } = await called(argv, {
      home,
      environment,
      fetch,
      ...machine,
    });
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, line, argv.join(" "));
  }
  assert.deepEqual(requests, []);
  await assert.rejects(stat(join(environment.XDG_CONFIG_HOME, "chuggy")), {
    code: "ENOENT",
  });
});

test("register writes nothing when chuggy refuses the token, and exits 1 with why", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const { status, out, err } = await called(registerArgv, {
    home,
    environment,
    fetch: answeringFetch(404, { error: { code: "NotFound" } }).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.equal(
    err,
    "the registration token is unknown, spent or expired; mint another in chuggy's console",
  );
  assert.deepEqual(
    await readdir(join(environment.XDG_CONFIG_HOME, "chuggy", "pools")),
    [],
  );
});

test("register spends no token where it could not write the pool file", async (t) => {
  const { home, environment } = await runnerFixture(t);
  await writeFile(join(environment.XDG_CONFIG_HOME, "chuggy"), "");
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, err } = await called(registerArgv, {
    home,
    environment,
    fetch,
  });
  assert.equal(status, 1);
  assert.match(
    err,
    /cannot be made a directory only you can write, so no token was spent: E(NOTDIR|EXIST)/u,
  );
  assert.deepEqual(requests, []);
});

test("register makes a pools directory you cannot write yours to write before spending the token, and spends none where it cannot", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const pools = join(environment.XDG_CONFIG_HOME, "chuggy", "pools");
  await mkdir(pools, { recursive: true });
  await chmod(pools, 0o500);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const written = await called(registerArgv, { home, environment, fetch });
  assert.equal(written.status, 0, written.err);
  assert.equal((await stat(pools)).mode & 0o777, 0o700);
  await rm(pools, { recursive: true });
  await symlink("/proc/self/fd", pools);
  const refused = await called(registerArgv, { home, environment, fetch });
  assert.equal(refused.status, 1);
  assert.equal(
    refused.err.split(": ")[0],
    `${pools} cannot be made a directory only you can write, so no token was spent`,
  );
  assert.equal(requests.length, 1);
});

test("register says the token is spent where chuggy answered but the pool file could not be written", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const pools = join(environment.XDG_CONFIG_HOME, "chuggy", "pools");
  await mkdir(join(pools, "newtenant.arbbot.shame.json", "blocking"), {
    recursive: true,
  });
  const { status, out, err } = await called(registerArgv, {
    home,
    environment,
    fetch: answeringFetch(201, registeredFixture).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.match(
    err,
    /^the pool file could not be written, and the token is spent, so mint another: E/u,
  );
  assert.ok(!err.includes(registeredFixture.clientSecret));
});

test("a token beginning with a dash is taken as --token=<token>, as usage says, and the space form keeps working for one that does not", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const dashed = `-${"a".repeat(42)}`;
  for (const [argv, token] of [
    [
      ["register", "--api", "https://chuggy.example", `--token=${dashed}`],
      dashed,
    ],
    [["register", "--api", "https://chuggy.example", "--token", "t-1"], "t-1"],
  ]) {
    const { fetch, requests } = answeringFetch(201, registeredFixture);
    const { status, err } = await called(argv, { home, environment, fetch });
    assert.equal(status, 0, err);
    assert.equal(JSON.parse(String(requests[0].init.body)).token, token);
  }
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const spaced = await called(
    ["register", "--api", "https://chuggy.example", "--token", dashed],
    { home, environment, fetch },
  );
  assert.equal(spaced.status, 2);
  assert.match(spaced.err, /--token=-XYZ/u);
  assert.deepEqual(requests, []);
  assert.match(
    (await called(["help"])).out,
    /^ {7}chuggy-linux register --api <origin> --token=<token> \[--pool <name>\]$/mu,
  );
});

test("registering a pool its service here runs says the service stops until restarted, and how", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  const file = join(
    environment.XDG_CONFIG_HOME,
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  const fetch = answeringFetch(201, registeredFixture).fetch;
  assert.equal(
    (await called(registerArgv, { home, environment, fetch })).status,
    0,
  );
  const notInstalled = await called(registerArgv, { home, environment, fetch });
  assert.equal(
    notInstalled.out,
    [
      `replaced ${file}; next:`,
      `  chuggy-linux doctor --pool ${file}`,
      `  chuggy-linux install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    (await called(["install-service", "--pool", file], { home, environment }))
      .status,
    0,
  );
  await legacyUnitWritten(units, file);
  const installed = await called(registerArgv, { home, environment, fetch });
  assert.equal(installed.status, 0, installed.err);
  assert.equal(
    installed.out,
    [
      `replaced ${file}; chuggy denies the pool's earlier registration, so its service stops until it is restarted:`,
      `  chuggy-linux doctor --pool ${file}`,
      "  systemctl --user restart chuggy-linux-newtenant.arbbot.shame.service",
      "  systemctl --user restart chuggy-linux.service",
    ].join("\n"),
  );
});

test("a run is refused while a legacy service whose pool file cannot be read runs, and not while one serving another pool does", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  await controlServed(t, controlSocketPath(runtimeDirectory(paths)));
  const legacyFile = await poolFileWritten(join(home, "legacy.json"), {
    ...fixturePool,
    project: "arbbot",
  });
  await legacyUnitWritten(paths.units, legacyFile);
  const beside = await called(["run", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(beside.status, 3, beside.err);
  await rm(legacyFile);
  const { status, err } = await called(["run", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status, 1);
  assert.equal(
    err,
    "chuggy-linux.service is running a pool file this runner cannot read, which may be this pool's; stop it before starting another service of this pool",
  );
});
