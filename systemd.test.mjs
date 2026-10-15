import assert from "node:assert/strict";
import test from "node:test";

import { systemdCalled } from "./systemd.mjs";

test("a command is run without a shell, its every argument reaching it as written", async () => {
  const argument = "$(exit 9); `exit 9` 'q' \"r\" *";
  assert.deepEqual(
    await systemdCalled([
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1])",
      argument,
    ]),
    { code: 0, stdout: argument, stderr: "" },
  );
});

test("a command that fails is answered with its exit code and both streams", async () => {
  assert.deepEqual(
    await systemdCalled([
      process.execPath,
      "-e",
      "process.stdout.write('o'); process.stderr.write('e'); process.exit(4)",
    ]),
    { code: 4, stdout: "o", stderr: "e" },
  );
});

test("a command that cannot start is answered with code -1 and why, never thrown", async () => {
  const answer = await systemdCalled(["/nonexistent/systemctl", "--user"]);
  assert.equal(answer.code, -1);
  assert.match(answer.stderr, /ENOENT/u);
});
