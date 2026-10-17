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
import { controlSocketPath } from "@chuggy/worker-core/control.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import {
  answeringFetch,
  registeredFixture,
  registeredPersonalFixture,
} from "./register.fixture.mjs";
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
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine]
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens]
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["plane"]} [plane]
 * @property {Readonly<Record<string, Partial<import("./systemd.mjs").SystemdAnswer>>>} [systemd] what a command answers, by its argv joined with spaces, where it does not succeed
 */

/** A token source whose issuer has revoked the pool, so a pass ends without the network. */
const deniedTokens = {
  acquire: async () => ({
    acquired: "Denied",
    evidence: "the pool was revoked",
  }),
  invalidate: () => undefined,
};

/** A plane a suite never reaches. */
const unreachedPlane = {
  poll: async () => {
    throw new Error("a suite reaches no network");
  },
  settle: async () => {
    throw new Error("a suite reaches no network");
  },
};

/** A pool's issuer and plane answering as chuggy's do, so every check doctor makes passes. */
const ready = {
  tokens: {
    acquire: async () => ({ acquired: "Token", token: "pool-token" }),
    invalidate: () => undefined,
  },
  plane: {
    poll: async () => ({ polled: "Reconciled", assignments: [], stop: [] }),
    settle: async () => "Settled",
  },
};

/** The copy a suite's calls are made of, and the Node they run under. */
const copyVersion = "9.8.7";
const copyNode = "/opt/node/bin/node";
const copyCli = "/opt/chuggy-linux/cli.mjs";

/** What doctor says first, of the copy a suite's calls are made of. */
const copyLine = `chuggy-linux ${copyVersion} at ${copyCli}, under Node 24.8.0 at ${copyNode}`;

/**
 * @param {readonly string[]} argv
 * @param {Machine} machine
 */
async function called(argv, machine = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @type {string[][]} */
  const systemd = [];
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
    tokens: machine.tokens ?? deniedTokens,
    plane: machine.plane ?? unreachedPlane,
    systemd: async (command) => {
      systemd.push([...command]);
      return {
        code: 0,
        stdout: "",
        stderr: "",
        ...machine.systemd?.[command.join(" ")],
      };
    },
    version: copyVersion,
    node: copyNode,
    nodeVersion: "24.8.0",
    cli: copyCli,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n"), systemd };
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

test("--version names this copy, whatever else is asked, and usage names it", async () => {
  for (const argv of [["--version"], ["doctor", "--version"]]) {
    const { status, out, err } = await called(argv);
    assert.equal(status, 0, argv.join(" "));
    assert.equal(out, `chuggy-linux ${copyVersion}`);
    assert.equal(err, "");
  }
  assert.match((await called(["help"])).out, /^ {7}chuggy-linux --version$/mu);
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
    [
      copyLine,
      `ok    runtime directory: ${join(environment.XDG_RUNTIME_DIR, "chuggy-linux")}`,
      `ok    service unit: none yet at ${join(environment.XDG_CONFIG_HOME, "systemd", "user", "chuggy-linux-pool.service")}`,
    ].join("\n"),
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

test("doctor says first which copy is speaking under which Node, and warns where the pool file's unit runs another, passing still", async (t) => {
  const { home, environment, poolFile } = await runnerFixture(t);
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  const unit = join(units, "chuggy-linux-pool.service");
  await mkdir(units, { recursive: true });
  await writeFile(
    unit,
    serviceUnit({
      node: "/usr/bin/node",
      cli: "/usr/lib/node_modules/chuggy-linux/cli.mjs",
      poolFile,
    }),
  );
  const { status, out, err } = await called(["doctor", "--pool", poolFile], {
    home,
    environment,
    ...ready,
  });
  assert.equal(status, 0, err);
  assert.equal(out.split("\n")[0], copyLine);
  assert.equal(
    err,
    `warn  service unit: ${unit} runs /usr/lib/node_modules/chuggy-linux/cli.mjs under /usr/bin/node, not this copy under this Node; to have it run this one: ${copyNode} ${copyCli} install-service --pool ${poolFile} && systemctl --user daemon-reload && systemctl --user restart chuggy-linux-pool.service`,
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
  const again = await called(["doctor", "--pool", poolFile], {
    home,
    environment,
    ...ready,
  });
  assert.equal(again.err, "");
  assert.match(
    again.out,
    new RegExp(
      `^ok {4}service unit: ${unit} runs this copy under this Node$`,
      "mu",
    ),
  );
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

test("status and stop reach this pool's service, and status names each workload's kind and the runner's limits", async (t) => {
  const { home, environment, poolFile, paths } = await served(t, {
    runner: { concurrencyMax: 3, sessionsMax: 4 },
  });
  const { stopped } = await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const { engine, state } = fakeEngine();
  for (const [name, labels] of [
    ["chuggy-shame-a", { "io.chuggy.assignment": "asg-2" }],
    [
      "chuggy-shame-b",
      { "io.chuggy.assignment": "ses-1", "io.chuggy.kind": "Session" },
    ],
  ])
    state.containers.set(name, {
      id: `id-${name}`,
      name,
      status: "running",
      image: "i",
      labels: {
        "io.chuggy.pool": "vteng/chuggy/shame",
        "io.chuggy.deadline": "1800000000",
        ...labels,
      },
    });
  const status = await called(["status", "--pool", poolFile], {
    home,
    environment,
    engine,
  });
  assert.equal(
    status.out,
    [
      "service: running",
      "limits: concurrencyMax 3, sessionsMax 4",
      `${inFlightFixture.name}  session  pulling  i  asg-1`,
      "chuggy-shame-a  job  running  deadline 2027-01-15T08:00:00.000Z  asg-2",
      "chuggy-shame-b  session  running  deadline 2027-01-15T08:00:00.000Z  ses-1",
    ].join("\n"),
  );
  const stop = await called(["stop", "asg-1", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(stop.status, 0);
  assert.equal(stop.out, "stopped asg-1");
  assert.deepEqual(stopped, ["asg-1"]);
});

test("status and stop ask nothing of the socket a runner hands jobs, so they answer while podman's is down, and once is refused for it", async (t) => {
  const { home, environment, poolFile } = await served(t, {
    runner: { engineSocket: true },
  });
  const { engine, state } = fakeEngine();
  state.podmanSocket = "/run/user/1000/podman/podman.sock false";
  state.containers.set("chuggy-shame-a", {
    id: "id-chuggy-shame-a",
    name: "chuggy-shame-a",
    status: "running",
    image: "i",
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.deadline": "1800000000",
      "io.chuggy.assignment": "asg-2",
    },
  });
  const machine = { home, environment, engine };
  const status = await called(["status", "--pool", poolFile], machine);
  assert.equal(status.status, 0);
  assert.match(status.out, /^chuggy-shame-a {2}job {2}running .* asg-2$/mu);
  const stop = await called(["stop", "asg-2", "--pool", poolFile], machine);
  assert.equal(stop.status, 0);
  assert.match(stop.out, /^stopped asg-2$/mu);
  assert.ok(!state.containers.has("chuggy-shame-a"));
  assert.ok(
    state.calls.every(({ argv }) => !argv.join(" ").includes("RemoteSocket")),
  );
  const once = await called(["once", "--pool", poolFile], machine);
  assert.equal(once.status, 1);
  assert.match(
    once.err,
    /^podman's socket \/run\/user\/1000\/podman\/podman\.sock is not there; start it with systemctl --user enable --now podman\.socket$/u,
  );
});

test("status names a job what a service from before sessions answers it is placing, which carries no kind", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  const { assignment, name, image, phase, deadlineEpochSecs } = inFlightFixture;
  await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
    [{ assignment, name, image, phase, deadlineEpochSecs }],
  );
  const status = await called(["status", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status.status, 0);
  assert.equal(
    status.out,
    [
      "service: running",
      "limits: concurrencyMax 1, sessionsMax 2",
      `${inFlightFixture.name}  job  pulling  i  asg-1`,
    ].join("\n"),
  );
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
  assert.match(err, /^a runner's service already answers at /u);
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

/**
 * A machine to register the pool on, with where its file and unit go. Its
 * runner is on docker, so podman's registries.conf, which is the machine's
 * own, reaches no line a suite asserts.
 *
 * @param {import("node:test").TestContext} t
 */
async function registering(t) {
  const { home, environment } = await runnerFixture(t, {
    runner: { engine: "docker" },
  });
  const units = join(environment.XDG_CONFIG_HOME, "systemd", "user");
  const name = "chuggy-linux-newtenant.arbbot.shame.service";
  const file = join(
    environment.XDG_CONFIG_HOME,
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  return {
    home,
    environment,
    units,
    name,
    unit: join(units, name),
    file,
    /** @param {Machine} [machine] where every check passes unless it says otherwise */
    registered: (machine = {}) =>
      called(registerArgv, {
        home,
        environment,
        fetch: answeringFetch(201, registeredFixture).fetch,
        ...ready,
        ...machine,
      }),
  };
}

/**
 * What register says on stderr before doctor's checks, on a machine where it
 * wrote the file.
 *
 * @param {string} file
 */
const checking = (file) =>
  `wrote ${file}, and the token is spent; checking this machine before starting its service`;

/** What starts a unit no unit here serves, lingering read and turned on. */
const startedSystemd = (/** @type {string} */ name) => [
  ["systemctl", "--user", "daemon-reload"],
  ["systemctl", "--user", "enable", "--now", name],
  ["loginctl", "show-user", "1000", "--property", "Linger"],
  ["loginctl", "--no-ask-password", "enable-linger", "1000"],
];

test("register writes the pool file it redeems the token for, and where every check passes writes its unit, starts it, turns lingering on and prints no secret", async (t) => {
  const { home, environment, file, name, unit } = await registering(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, out, err, systemd } = await called(registerArgv, {
    home,
    environment: { ...environment, CHUGGY_LINUX_POOL: "/elsewhere.json" },
    hostname: "Shame.lan",
    fetch,
    ...ready,
  });
  assert.equal(status, 0, err);
  assert.equal(out, `wrote ${file}; its service is running: started ${name}`);
  assert.equal(err, checking(file));
  assert.deepEqual(systemd, startedSystemd(name));
  assert.match(
    await readFile(unit, "utf8"),
    new RegExp(
      `^ExecStart="/opt/node/bin/node" "/opt/chuggy-linux/cli.mjs" "run" "--pool" "${file}"$`,
      "mu",
    ),
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)).pool, "shame");
  const pools = dirname(file);
  assert.equal((await stat(pools)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registeredFixture);
  assert.ok(!`${out}${err}`.includes(registeredFixture.clientSecret));
  assert.ok(
    !systemd
      .flat()
      .some((word) => word.includes(registeredFixture.clientSecret)),
  );
  const again = await called(registerArgv, { home, environment, fetch });
  assert.match(again.out, /^replaced /u);
});

test("register --personal redeems a member's personal token for their runner's file, named for its tenant and member, asking for no pool", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const { fetch, requests } = answeringFetch(201, registeredPersonalFixture);
  const { status, out } = await called([...registerArgv, "--personal"], {
    home,
    environment,
    fetch,
    ...ready,
  });
  assert.equal(status, 0);
  const base =
    "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member";
  const file = join(
    environment.XDG_CONFIG_HOME,
    "chuggy",
    "pools",
    `${base}.json`,
  );
  assert.equal(
    out,
    `wrote ${file}; its service is running: started chuggy-linux-${base}.service`,
  );
  assert.equal(
    requests[0].url,
    "https://chuggy.example/api/v1/personal-runner-registrations",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    token: "registration-token-fixture",
    capabilities: ["Platform:Linux:Amd64"],
  });
  assert.deepEqual(
    JSON.parse(await readFile(file, "utf8")),
    registeredPersonalFixture,
  );
});

test("register prints a warning a check gave, and starts the service still", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const registries = join(
    environment.XDG_CONFIG_HOME,
    "containers",
    "registries.conf",
  );
  await mkdir(dirname(registries), { recursive: true });
  await writeFile(registries, 'credential-helpers = ["secretservice"]\n');
  const { status, out, err } = await called(registerArgv, {
    home,
    environment,
    fetch: answeringFetch(201, registeredFixture).fetch,
    ...ready,
  });
  assert.equal(status, 0);
  assert.match(out, /^wrote .*; its service is running: started /u);
  assert.match(err, /^warn {2}podman credential helpers: .*registries\.conf/mu);
  assert.ok(err.includes(registries), err);
});

test("register starts nothing where a check fails, and prints the failed check and what is left", async (t) => {
  const { file, units, registered } = await registering(t);
  const { status, out, err, systemd } = await registered({
    tokens: deniedTokens,
  });
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since a check failed; next:`,
      `  chuggy-linux doctor --pool ${file}`,
      `  chuggy-linux install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    err,
    [checking(file), "FAIL  pool token: the pool was revoked"].join("\n"),
  );
  assert.deepEqual(systemd, []);
  await assert.rejects(stat(units), { code: "ENOENT" });
});

test("register stops where the user's service manager cannot be reached, or fails to start the unit, and prints why and what is left", async (t) => {
  const reloading = await registering(t);
  const unreached = await reloading.registered({
    systemd: {
      "systemctl --user daemon-reload": {
        code: 1,
        stderr: "Failed to connect to bus: No medium found\n",
      },
    },
  });
  assert.equal(unreached.status, 0);
  assert.equal(
    unreached.out,
    [
      `wrote ${reloading.file}; its service is not running, since systemctl --user daemon-reload failed; next:`,
      "  systemctl --user daemon-reload",
      `  systemctl --user enable --now ${reloading.name}`,
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.equal(
    unreached.err,
    [
      checking(reloading.file),
      "systemctl --user daemon-reload: Failed to connect to bus: No medium found",
    ].join("\n"),
  );
  assert.deepEqual(unreached.systemd, [
    ["systemctl", "--user", "daemon-reload"],
  ]);
  assert.match(await readFile(reloading.unit, "utf8"), /^ExecStart=/mu);

  const starting = await registering(t);
  const unstarted = await starting.registered({
    systemd: {
      [`systemctl --user enable --now ${starting.name}`]: { code: 1 },
    },
  });
  assert.equal(unstarted.status, 0);
  assert.equal(
    unstarted.out,
    [
      `wrote ${starting.file}; its service is not running, since systemctl --user enable --now ${starting.name} failed; next:`,
      `  systemctl --user enable --now ${starting.name}`,
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.equal(
    unstarted.err,
    [
      checking(starting.file),
      `systemctl --user enable --now ${starting.name}: exited 1`,
    ].join("\n"),
  );
});

test("register leaves lingering on where it is on, and where it cannot turn it on says the service runs only while you are logged in", async (t) => {
  const lingering = await registering(t);
  const on = await lingering.registered({
    systemd: {
      "loginctl show-user 1000 --property Linger": { stdout: "Linger=yes\n" },
    },
  });
  assert.equal(
    on.out,
    `wrote ${lingering.file}; its service is running: started ${lingering.name}`,
  );
  assert.deepEqual(on.systemd, startedSystemd(lingering.name).slice(0, 3));

  const refusing = await registering(t);
  const refused = await refusing.registered({
    systemd: {
      "loginctl show-user 1000 --property Linger": { stdout: "Linger=no\n" },
      "loginctl --no-ask-password enable-linger 1000": {
        code: 1,
        stderr:
          "Could not enable linger: Interactive authentication required.\n",
      },
    },
  });
  assert.equal(refused.status, 0);
  assert.equal(
    refused.out,
    [
      `wrote ${refusing.file}; its service is running: started ${refusing.name}`,
      "it runs only while you are logged in, until you run:",
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.equal(
    refused.err,
    [
      checking(refusing.file),
      "loginctl --no-ask-password enable-linger 1000: Could not enable linger: Interactive authentication required.",
    ].join("\n"),
  );
  assert.deepEqual(refused.systemd, startedSystemd(refusing.name));
});

test("where the legacy unit serves the pool, register writes the pool's own unit, starts nothing, and prints what install-service does", async (t) => {
  const { home, file, units, unit, name, registered } = await registering(t);
  const legacyFile = await poolFileWritten(
    join(home, "newtenant-arbbot-shame.json"),
    registeredFixture,
  );
  const legacy = await legacyUnitWritten(units, legacyFile);
  const before = await readFile(legacy, "utf8");
  const { status, out, err, systemd } = await registered();
  assert.equal(status, 0, err);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since chuggy-linux.service serves this pool already; next:`,
      "  systemctl --user disable --now chuggy-linux.service",
      `  rm ${legacy}`,
      "  systemctl --user daemon-reload",
      `  systemctl --user enable --now ${name}`,
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.deepEqual(systemd, []);
  assert.match(await readFile(unit, "utf8"), /^ExecStart=/mu);
  assert.equal(await readFile(legacy, "utf8"), before);
});

test("registering again where the legacy unit serves the pool, from its own file or this one, restarts nothing and prints what install-service does", async (t) => {
  const { home, file, units, name, registered } = await registering(t);
  const legacyFile = await poolFileWritten(
    join(home, "newtenant-arbbot-shame.json"),
    registeredFixture,
  );
  const legacy = await legacyUnitWritten(units, legacyFile);
  assert.equal((await registered()).status, 0);
  const retire = [
    `replaced ${file}; its service is not running, since chuggy-linux.service serves this pool already; next:`,
    "  systemctl --user disable --now chuggy-linux.service",
    `  rm ${legacy}`,
    "  systemctl --user daemon-reload",
    `  systemctl --user enable --now ${name}`,
    "  loginctl enable-linger",
  ].join("\n");
  for (const served of [legacyFile, file]) {
    await legacyUnitWritten(units, served);
    const { status, out, err, systemd } = await registered();
    assert.equal(status, 0, err);
    assert.equal(out, retire);
    assert.equal(err, "");
    assert.deepEqual(systemd, []);
  }
});

test("where the legacy unit serves exactly the file and the file's own unit is not there, register writes that unit and starts nothing", async (t) => {
  const { file, units, unit, registered } = await registering(t);
  await registered({ tokens: deniedTokens });
  const legacy = await legacyUnitWritten(units, file);
  const { status, out, err, systemd } = await registered();
  assert.equal(status, 0, err);
  assert.equal(
    out.split("\n").slice(0, 3).join("\n"),
    [
      `replaced ${file}; its service is not running, since chuggy-linux.service serves this pool already; next:`,
      "  systemctl --user disable --now chuggy-linux.service",
      `  rm ${legacy}`,
    ].join("\n"),
  );
  assert.deepEqual(systemd, []);
  assert.match(await readFile(unit, "utf8"), /^ExecStart=/mu);
});

test("registering again restarts the file's own unit beside a legacy unit whose pool file cannot be read, as install-service leaves it", async (t) => {
  const { home, file, units, name, registered } = await registering(t);
  assert.equal((await registered()).status, 0);
  await legacyUnitWritten(units, join(home, "gone.json"));
  const { status, out } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
});

test("register refuses, as install-service does, a unit of the file's name serving another pool file, and starts nothing", async (t) => {
  const { home, file, units, unit, registered } = await registering(t);
  const elsewhere = join(home, "elsewhere", "newtenant.arbbot.shame.json");
  await mkdir(units, { recursive: true });
  const written = serviceUnit({ node: "/n", cli: "/c", poolFile: elsewhere });
  await writeFile(unit, written);
  const { status, out, err, systemd } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since its unit could not be written; next:`,
      `  chuggy-linux install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    err,
    [
      checking(file),
      `warn  service unit: ${unit} serves ${elsewhere}, not this pool file`,
      `${unit} serves ${elsewhere}, not ${file}; remove that unit if it is stale, or rename the pool file`,
    ].join("\n"),
  );
  assert.deepEqual(systemd, []);
  assert.equal(await readFile(unit, "utf8"), written);
});

test("register exits 0 once the file is written, saying why and what is left, whatever it could not read of this machine's units", async (t) => {
  const { file, unit, registered } = await registering(t);
  await mkdir(unit, { recursive: true });
  const { status, out, err, systemd } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since it could not be started; next:`,
      `  chuggy-linux doctor --pool ${file}`,
      `  chuggy-linux install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.match(err, /^EISDIR: /u);
  assert.deepEqual(systemd, []);
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
    [
      [...registerArgv, "--personal", "--pool", "shame"],
      {},
      /^--pool names a pool, and a personal runner is its member's one in the tenant/u,
    ],
    [[...registerArgv, "extra"], {}, /^usage: chuggy-linux/u],
    [["run", "--pool", "/p", "--token", "t"], {}, /^usage: chuggy-linux/u],
    [["doctor", "--pool", "/p", "--personal"], {}, /^usage: chuggy-linux/u],
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

test("register declares each --capability after this machine's platform, writes --host into the pool file, and refuses one that is not a capability before spending the token", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const declared = {
    ...registeredFixture,
    capabilities: ["Platform:Linux:Amd64", "Agent:Claude", "Tool:Bazel"],
  };
  const { fetch, requests } = answeringFetch(201, declared);
  await called(
    [
      ...registerArgv,
      "--capability",
      "Agent:Claude",
      "--capability",
      "Tool:Bazel",
    ],
    { home, environment, fetch },
  );
  assert.deepEqual(
    JSON.parse(String(requests[0].init.body)).capabilities,
    declared.capabilities,
  );
  const hosted = answeringFetch(201, registeredFixture);
  const { status: hostedStatus, err: hostedErr } = await called(
    [...registerArgv, "--host"],
    { home, environment, fetch: hosted.fetch },
  );
  assert.equal(hostedStatus, 0, hostedErr);
  assert.equal(
    "host" in JSON.parse(String(hosted.requests[0].init.body)),
    false,
  );
  const file = join(
    environment.XDG_CONFIG_HOME,
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    ...registeredFixture,
    host: true,
  });
  for (const [capability, why] of [
    ["Platform:Linux:Arm64", /names a platform, which register finds/u],
    ["has space", /is not a capability/u],
  ]) {
    const refused = answeringFetch(201, declared);
    const { status, err } = await called(
      [...registerArgv, "--capability", capability],
      { home, environment, fetch: refused.fetch },
    );
    assert.equal(status, 2);
    assert.match(err, why);
    assert.deepEqual(refused.requests, []);
  }
  assert.equal(
    (await called(["status", "--pool", "x", "--capability", "Tool:Bazel"]))
      .status,
    2,
  );
  assert.equal((await called(["run", "--pool", "x", "--host"])).status, 2);
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
    /^ {7}chuggy-linux register --api <origin> --token=<token> \[--pool <name> \| --personal\]\n {29}\[--host\] \[--capability <token>\]\.\.\.$/mu,
  );
});

test("registering a pool its own unit here serves restarts that unit, and checks nothing", async (t) => {
  const { home, environment, file, name, registered } = await registering(t);
  assert.equal(
    (await registered({ tokens: deniedTokens })).out.split("\n")[0],
    `wrote ${file}; its service is not running, since a check failed; next:`,
  );
  assert.equal(
    (await called(["install-service", "--pool", file], { home, environment }))
      .status,
    0,
  );
  const { status, out, err, systemd } = await registered({
    tokens: deniedTokens,
  });
  assert.equal(status, 0, err);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(err, "");
  assert.deepEqual(systemd, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", name],
    ["systemctl", "--user", "restart", name],
    ...startedSystemd(name).slice(2),
  ]);
});

test("registering a pool its own unit here serves writes that unit again first, so what is restarted is this copy under this Node", async (t) => {
  const { file, units, unit, name, registered } = await registering(t);
  await mkdir(units, { recursive: true });
  await writeFile(
    unit,
    serviceUnit({ node: "/old/node", cli: "/old/cli.mjs", poolFile: file }),
  );
  const { status, out, err, systemd } = await registered();
  assert.equal(status, 0, err);
  assert.equal(out, `wrote ${file}; its service is running: restarted ${name}`);
  assert.equal(err, "");
  assert.equal(
    await readFile(unit, "utf8"),
    serviceUnit({ node: copyNode, cli: copyCli, poolFile: file }),
  );
  assert.deepEqual(systemd, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", name],
    ["systemctl", "--user", "restart", name],
    ...startedSystemd(name).slice(2),
  ]);
});

test(
  "registering a pool its own unit here serves restarts nothing where that unit cannot be written again, and says why and what is left",
  { skip: process.getuid?.() === 0 && "root writes a file whatever its mode" },
  async (t) => {
    const { file, units, unit, name, registered } = await registering(t);
    await mkdir(units, { recursive: true });
    const written = serviceUnit({
      node: "/old/node",
      cli: "/old/cli.mjs",
      poolFile: file,
    });
    await writeFile(unit, written);
    await chmod(unit, 0o444);
    const { status, out, err, systemd } = await registered();
    assert.equal(status, 0);
    assert.equal(
      out,
      [
        `wrote ${file}; its service is not running, since chuggy denies the pool's earlier registration and its unit could not be written; next:`,
        `  chuggy-linux install-service --pool ${file}`,
        "  systemctl --user daemon-reload",
        `  systemctl --user enable ${name}`,
        `  systemctl --user restart ${name}`,
        "  loginctl enable-linger",
      ].join("\n"),
    );
    assert.equal(err, `EACCES: permission denied, open '${unit}'`);
    assert.deepEqual(systemd, []);
    assert.equal(await readFile(unit, "utf8"), written);
  },
);

test("registering again over a unit written and never started reads the units again, enables and restarts it and turns lingering on, and says it is not running where any of those failed", async (t) => {
  const { file, name, registered } = await registering(t);
  const first = await registered({
    systemd: {
      "systemctl --user daemon-reload": {
        code: 1,
        stderr: "Failed to connect to bus: No medium found\n",
      },
    },
  });
  assert.match(
    first.out,
    /since systemctl --user daemon-reload failed; next:$/mu,
  );
  const steps = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", name],
    ["systemctl", "--user", "restart", name],
  ];
  for (const [index, failing] of steps.entries()) {
    const failed = await registered({
      systemd: { [failing.join(" ")]: { code: 1, stderr: "Failed\n" } },
    });
    assert.equal(failed.status, 0);
    assert.equal(
      failed.out,
      [
        `replaced ${file}; its service is not running, since chuggy denies the pool's earlier registration and ${failing.join(" ")} failed; next:`,
        ...[...steps.slice(index), ["loginctl", "enable-linger"]].map(
          (argv) => `  ${argv.join(" ")}`,
        ),
      ].join("\n"),
    );
    assert.equal(failed.err, `${failing.join(" ")}: Failed`);
    assert.deepEqual(failed.systemd, steps.slice(0, index + 1));
  }
  const again = await registered();
  assert.equal(again.status, 0);
  assert.equal(
    again.out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(again.err, "");
  assert.deepEqual(again.systemd, [...steps, ...startedSystemd(name).slice(2)]);
});

test("registering a personal runner its service here runs restarts the unit named for its file, and where the restart fails says so of the runner", async (t) => {
  const { home, environment } = await runnerFixture(t);
  const argv = [...registerArgv, "--personal"];
  const fetch = answeringFetch(201, registeredPersonalFixture).fetch;
  const base =
    "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member";
  const name = `chuggy-linux-${base}.service`;
  const file = join(
    environment.XDG_CONFIG_HOME,
    "chuggy",
    "pools",
    `${base}.json`,
  );
  assert.equal((await called(argv, { home, environment, fetch })).status, 0);
  const service = await called(["install-service", "--pool", file], {
    home,
    environment,
  });
  assert.equal(service.status, 0, service.err);
  assert.equal(
    service.out.split("\n")[0],
    `wrote ${join(environment.XDG_CONFIG_HOME, "systemd", "user", name)}; start it with:`,
  );
  const again = await called(argv, { home, environment, fetch });
  assert.equal(again.status, 0, again.err);
  assert.equal(
    again.out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  const failed = await called(argv, {
    home,
    environment,
    fetch,
    systemd: {
      [`systemctl --user restart ${name}`]: {
        code: 5,
        stderr: `Failed to restart ${name}: Unit ${name} not found.\n`,
      },
    },
  });
  assert.equal(failed.status, 0);
  assert.equal(
    failed.out,
    [
      `replaced ${file}; its service is not running, since chuggy denies this personal runner's earlier registration and systemctl --user restart ${name} failed; next:`,
      `  systemctl --user restart ${name}`,
      "  loginctl enable-linger",
    ].join("\n"),
  );
  assert.equal(
    failed.err,
    `systemctl --user restart ${name}: Failed to restart ${name}: Unit ${name} not found.`,
  );
});

test("a legacy unit whose pool file cannot be read refuses no run while nothing answers at the root socket", async (t) => {
  const { home, environment, poolFile, paths } = await served(t);
  await legacyUnitWritten(paths.units, join(home, "moved.json"));
  const { status, err } = await called(["run", "--pool", poolFile], {
    home,
    environment,
  });
  assert.equal(status, 3, err);
  assert.equal(err, "");
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
