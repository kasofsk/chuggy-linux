/**
 * systemd's own commands, `systemctl` and `loginctl`, run with `execFile` and
 * never a shell. An answer is the exit code and both streams. A command that
 * could not start, or that ran past its cap, is answered with code -1 and why
 * on its stderr.
 */

import { execFile } from "node:child_process";

/**
 * @typedef {object} SystemdAnswer
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {(argv: readonly string[]) => Promise<SystemdAnswer>} Systemd runs `argv[0]` with the rest as its arguments
 */

/** The cap on one call, which guards a hung manager and not a slow one. */
const systemdCallTimeoutMs = 60_000;

/** @type {Systemd} */
export function systemdCalled(argv) {
  const [command, ...rest] = argv;
  return new Promise((resolve) => {
    execFile(
      command,
      rest,
      { timeout: systemdCallTimeoutMs, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === "number")
          resolve({ code: error.code, stdout, stderr });
        else resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
      },
    );
  });
}
