import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { cliMain } from "./commands.mjs";
import { runnerFixture } from "./runner.fixture.mjs";

/**
 * @param {readonly string[]} argv
 * @param {{environment?: Record<string, string>, home?: string}} machine
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
    node: "/opt/node/bin/node",
    cli: "/opt/chuggy-linux/cli.mjs",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
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

test("install-service writes the unit that runs this CLI under this Node, and prints how to start it", async (t) => {
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
    "chuggy-linux.service",
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
      "  systemctl --user enable --now chuggy-linux.service",
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
