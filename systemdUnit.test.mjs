import assert from "node:assert/strict";
import test from "node:test";

import {
  serviceCommands,
  serviceUnit,
  serviceUnitBaseCharsMax,
  serviceUnitName,
  shellQuoted,
  systemdQuoted,
  unitPoolFile,
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

test("an argument the operator is told is quoted for a shell only where it must be", () => {
  assert.equal(
    shellQuoted("/home/op/.config/chuggy/pools/a.b.c.json"),
    "/home/op/.config/chuggy/pools/a.b.c.json",
  );
  assert.equal(shellQuoted("/home/o p/it's"), "'/home/o p/it'\\''s'");
  assert.equal(shellQuoted("a\\x2db;$(x)"), "'a\\x2db;$(x)'");
});
