import assert from "node:assert/strict";
import test from "node:test";

import { registerPoolFileName } from "@chuggy/worker-core/register.mjs";

import {
  serviceCommands,
  serviceUnit,
  serviceUnitBaseCharsMax,
  serviceUnitName,
  shellQuoted,
  systemdQuoted,
  unitPoolFile,
  unitService,
} from "./systemdUnit.mjs";

test("the unit runs the runner under this Node, restarting it after any failure but a denial", () => {
  assert.equal(
    serviceUnit({
      node: "/home/op/.nvm/versions/node/v24.8.0/bin/node",
      cli: "/home/op/.nvm/versions/node/v24.8.0/lib/node_modules/chuggy-linux/cli.mjs",
      poolFile: "/home/op/.config/chuggy/pools/vteng-chuggy-shame.json",
    }),
    [
      "[Unit]",
      "Description=chuggy-linux: a chuggy worker pool's jobs in containers",
      "",
      "[Service]",
      'ExecStart="/home/op/.nvm/versions/node/v24.8.0/bin/node" "/home/op/.nvm/versions/node/v24.8.0/lib/node_modules/chuggy-linux/cli.mjs" "run" "--pool" "/home/op/.config/chuggy/pools/vteng-chuggy-shame.json"',
      "Restart=always",
      "RestartSec=10",
      "RestartPreventExitStatus=3",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

test("a chat host's unit is a pool's, run and restarted alike, saying what it is", () => {
  const service = {
    node: "/home/op/.nvm/versions/node/v24.8.0/bin/node",
    cli: "/home/op/.nvm/versions/node/v24.8.0/lib/node_modules/chuggy-linux/cli.mjs",
    poolFile: "/home/op/.config/chuggy/pools/vteng.28_3amember.chat.host.json",
  };
  const pool = serviceUnit(service).split("\n");
  const chat = serviceUnit({ ...service, chat: true }).split("\n");
  assert.equal(
    chat[1],
    "Description=chuggy-linux: a member's chat host, its sessions in a container",
  );
  assert.deepEqual(chat.slice(2), pool.slice(2));
  assert.deepEqual(unitService(chat.join("\n")), service);
  assert.equal(
    serviceUnitName(service.poolFile),
    "chuggy-linux-vteng.28_3amember.chat.host.service",
  );
});

test("an argument is quoted, and systemd expands nothing inside it", () => {
  assert.equal(
    systemdQuoted('/home/o p/100%/$HOME/"q"\\x'),
    '"/home/o p/100%%/$$HOME/\\"q\\"\\\\x"',
  );
});

test("the operator is told to start the unit and to keep it running without a login", () => {
  assert.deepEqual(serviceCommands("chuggy-linux-vteng.chuggy.shame.service"), [
    "systemctl --user daemon-reload",
    "systemctl --user enable --now chuggy-linux-vteng.chuggy.shame.service",
    "loginctl enable-linger",
  ]);
});

test("where the legacy unit serves the pool, the operator is told to stop and remove it before starting the pool's own", () => {
  assert.deepEqual(
    serviceCommands(
      "chuggy-linux-vteng\\x20x.service",
      "/home/o p/.config/systemd/user/chuggy-linux.service",
    ),
    [
      "systemctl --user disable --now chuggy-linux.service",
      "rm '/home/o p/.config/systemd/user/chuggy-linux.service'",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now 'chuggy-linux-vteng\\x20x.service'",
      "loginctl enable-linger",
    ],
  );
});

test("a pool file's unit is named for the file, a byte a unit name may not carry escaped and a hyphen kept", () => {
  assert.equal(
    serviceUnitName("/home/op/.config/chuggy/pools/vteng.chuggy.shame.json"),
    "chuggy-linux-vteng.chuggy.shame.service",
  );
  assert.equal(
    serviceUnitName("/p/vteng-chuggy-shame.json"),
    "chuggy-linux-vteng-chuggy-shame.service",
  );
  assert.equal(
    serviceUnitName("/p/my pool@é\\x.json"),
    "chuggy-linux-my\\x20pool\\x40\\xc3\\xa9\\x5cx.service",
  );
  assert.equal(serviceUnitName("/p/pool"), "chuggy-linux-pool.service");
  assert.notEqual(
    serviceUnitName("/p/a b.json"),
    serviceUnitName("/p/a\\x20b.json"),
  );
});

test("a unit name is at most as long as systemd accepts", () => {
  const longest = "a".repeat(serviceUnitBaseCharsMax);
  assert.equal(serviceUnitName(`/p/${longest}.json`).length, 255);
  assert.throws(
    () => serviceUnitName(`/p/${longest}a.json`),
    /makes a unit name longer than systemd accepts/u,
  );
  assert.throws(
    () => serviceUnitName(`/p/${"é".repeat(serviceUnitBaseCharsMax)}.json`),
    /makes a unit name longer than systemd accepts/u,
  );
});

test("the pool file a unit serves is read back from its ExecStart, whatever the path holds", () => {
  for (const poolFile of [
    "/home/op/.config/chuggy/pools/vteng.chuggy.shame.json",
    '/home/o p/100%/$HOME/"q"\\x/--pool.json',
  ])
    assert.equal(
      unitPoolFile(
        serviceUnit({ node: "/n/node", cli: "/c/cli.mjs", poolFile }),
      ),
      poolFile,
    );
});

test("a unit this runner did not write serves no pool file it can name", () => {
  for (const unit of [
    "[Service]\nExecStart=/usr/bin/sleep infinity\n",
    '[Service]\nExecStart="/n/node" "/c/cli.mjs" "run"\n',
    '[Service]\nExecStart="/n/node" "/c/cli.mjs" "run" "--pool" "/p" extra\n',
    "",
  ])
    assert.equal(unitPoolFile(unit), undefined, unit);
});

test("what a unit runs is read back from an ExecStart exactly as this runner writes one, and from no other", () => {
  const service = {
    node: "/home/o p/.nvm/versions/node/v24.8.0/bin/node",
    cli: '/home/o p/100%/$HOME/"q"\\x/cli.mjs',
    poolFile: "/home/o p/.config/chuggy/pools/vteng.chuggy.shame.json",
  };
  assert.deepEqual(unitService(serviceUnit(service)), service);
  for (const unit of [
    "[Service]\nExecStart=/usr/bin/node /c/cli.mjs run --pool /p\n",
    '[Service]\nExecStart="/n/node" "/c/cli.mjs" "run" "--pool"\n',
    '[Service]\nExecStart="/n/node" "/c/cli.mjs" "run" "--pool" "/p" "--x"\n',
    '[Service]\nExecStart="/n/node" "/c/cli.mjs" "once" "--pool" "/p"\n',
    '[Service]\nExecStart="/usr/bin/env" "node" "/c/cli.mjs" "run" "--pool" "/p"\n',
    "",
  ])
    assert.equal(unitService(unit), undefined, unit);
});

test("an argument the operator is told is quoted for a shell only where it must be", () => {
  assert.equal(
    shellQuoted("/home/op/.config/chuggy/pools/a.b.c.json"),
    "/home/op/.config/chuggy/pools/a.b.c.json",
  );
  assert.equal(shellQuoted("/home/o p/it's"), "'/home/o p/it'\\''s'");
  assert.equal(shellQuoted("a\\x2db;$(x)"), "'a\\x2db;$(x)'");
});

test("every pool file register names under the unit bound names a unit systemd accepts", () => {
  const tenant = "t".repeat(
    serviceUnitBaseCharsMax - "p".length - "shame".length - "..".length,
  );
  const longest = registerPoolFileName(
    { tenant, project: "p", pool: "shame" },
    serviceUnitBaseCharsMax,
  );
  assert.equal(longest, `${tenant}.p.shame.json`);
  serviceUnitName(`/p/${longest}`);
  const digest = registerPoolFileName(
    { tenant: `${tenant}t`, project: "p", pool: "shame" },
    serviceUnitBaseCharsMax,
  );
  assert.match(serviceUnitName(`/p/${digest}`), /^chuggy-linux-pool-/u);
  const owner = "28:https://auth.chuggy.example/0f3c9a52-member";
  const personal = registerPoolFileName(
    { kind: "Personal", tenant: "vteng", owner },
    serviceUnitBaseCharsMax,
  );
  assert.equal(
    serviceUnitName(`/p/${personal}`),
    `chuggy-linux-${personal.slice(0, -".json".length)}.service`,
  );
  const personalDigest = registerPoolFileName(
    { kind: "Personal", tenant, owner },
    serviceUnitBaseCharsMax,
  );
  assert.match(
    serviceUnitName(`/p/${personalDigest}`),
    /^chuggy-linux-personal-[0-9a-f]+\.service$/u,
  );
});
