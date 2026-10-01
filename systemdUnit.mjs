/**
 * The systemd user unit a pool's service runs under, one per pool file, so
 * several pools serve from one machine. It restarts the runner after any
 * failure but one: a pool the plane denied exits `deniedExitStatus`, and no
 * restart of it would be answered differently.
 */

import { Buffer } from "node:buffer";
import { basename } from "node:path";

/** The exit status of a run the plane ended by denying the pool. */
export const deniedExitStatus = 3;

/** The one unit a machine served a pool under before each pool had its own. */
export const legacyServiceUnitName = "chuggy-linux.service";

const serviceUnitPrefix = "chuggy-linux-";
const serviceUnitSuffix = ".service";

/** The longest unit name systemd accepts. */
const unitNameCharsMax = 255;

/** The longest pool file name, less `.json`, whose unit is named without escaping. */
export const serviceUnitBaseCharsMax =
  unitNameCharsMax - serviceUnitPrefix.length - serviceUnitSuffix.length;

/**
 * The unit serving a pool file, named for the file less its `.json`. A byte a
 * unit name may not carry is escaped as `systemd-escape` writes it; a hyphen,
 * which only a path's escaping reserves, is kept.
 *
 * @param {string} poolFile
 */
export function serviceUnitName(poolFile) {
  let escaped = "";
  for (const byte of Buffer.from(basename(poolFile, ".json"), "utf8")) {
    const char = String.fromCharCode(byte);
    escaped += /^[A-Za-z0-9:_.-]$/u.test(char)
      ? char
      : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  const name = `${serviceUnitPrefix}${escaped}${serviceUnitSuffix}`;
  if (name.length > unitNameCharsMax)
    throw new RangeError(
      `${poolFile} makes a unit name longer than systemd accepts; give the pool file a shorter name`,
    );
  return name;
}

/**
 * One argument of `ExecStart`, quoted so a space cannot split it and escaped
 * so systemd expands neither a specifier nor a variable inside it.
 *
 * @param {string} argument
 */
export function systemdQuoted(argument) {
  const escaped = argument
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/** An `ExecStart` whose every argument `systemdQuoted` wrote. */
const quotedExecStartPattern = /^ExecStart=(?:"(?:[^"\\]|\\.)*"(?: |$))+$/u;

/**
 * The pool file a unit this runner wrote serves, read back from its
 * `ExecStart`, or nothing for a unit it did not write.
 *
 * @param {string} unit the unit file's text
 * @returns {string | undefined}
 */
export function unitPoolFile(unit) {
  const execStart = unit
    .split("\n")
    .find((line) => quotedExecStartPattern.test(line));
  if (execStart === undefined) return undefined;
  const argv = [...execStart.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(
    ([, quoted]) =>
      quoted.replace(/\\(.)|%%|\$\$/gu, (escape, char) => char ?? escape[0]),
  );
  const pool = argv.indexOf("--pool");
  return pool < 0 ? undefined : argv[pool + 1];
}

/**
 * @param {{node: string, cli: string, poolFile: string}} service absolute paths
 */
export function serviceUnit(service) {
  const command = [service.node, service.cli, "run", "--pool", service.poolFile]
    .map(systemdQuoted)
    .join(" ");
  return [
    "[Unit]",
    "Description=chuggy-linux: a chuggy worker pool's jobs in containers",
    "",
    "[Service]",
    `ExecStart=${command}`,
    "Restart=always",
    "RestartSec=10",
    `RestartPreventExitStatus=${String(deniedExitStatus)}`,
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * One argument of a command the operator is told to run, quoted for a POSIX
 * shell unless it holds only characters no shell reads specially.
 *
 * @param {string} argument
 */
export function shellQuoted(argument) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * What the operator runs once a unit is written; lingering keeps it running
 * without a login. Where the legacy unit serves the same pool, it is stopped
 * and removed first, so the two never poll the pool together.
 *
 * @param {string} unitName
 * @param {string} [legacyUnit] the legacy unit's file, where it serves this pool
 */
export function serviceCommands(unitName, legacyUnit) {
  return [
    ...(legacyUnit === undefined
      ? []
      : [
          `systemctl --user disable --now ${legacyServiceUnitName}`,
          `rm ${shellQuoted(legacyUnit)}`,
        ]),
    "systemctl --user daemon-reload",
    `systemctl --user enable --now ${shellQuoted(unitName)}`,
    "loginctl enable-linger",
  ];
}
