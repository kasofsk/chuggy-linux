import assert from "node:assert/strict";
import test from "node:test";

import { serviceCommands, serviceUnit, systemdQuoted } from "./systemdUnit.mjs";

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
  assert.deepEqual(serviceCommands, [
    "systemctl --user daemon-reload",
    "systemctl --user enable --now chuggy-linux.service",
    "loginctl enable-linger",
  ]);
});
