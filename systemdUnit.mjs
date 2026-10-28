/**
 * The systemd user unit a pool's service runs under, one per pool file, so
 * several pools serve from one machine. It restarts the runner after any exit
 * but one: a pool the plane denied exits `deniedExitStatus`, and no restart of
 * it would be answered differently. A run that installed a release of itself
 * exits `updatedExitStatus`, and is restarted on that release.
 */

import { Buffer } from "node:buffer";
import { basename } from "node:path";

/** The exit status of a run the plane ended by denying the pool. */
export const deniedExitStatus = 3;

/**
 * The exit status of a run that installed a release of itself, to be started
 * again on it: sysexits' `EX_TEMPFAIL`, which systemd's journal names
 * `TEMPFAIL`.
 */
export const updatedExitStatus = 75;

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
 * The arguments of a unit's `ExecStart`, where `systemdQuoted` wrote every one
 * of them, or nothing.
 *
 * @param {string} unit the unit file's text
 * @returns {string[] | undefined}
 */
function unitExecStartArgv(unit) {
  const execStart = unit
    .split("\n")
    .find((line) => quotedExecStartPattern.test(line));
  if (execStart === undefined) return undefined;
  return [...execStart.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(([, quoted]) =>
    quoted.replace(/\\(.)|%%|\$\$/gu, (escape, char) => char ?? escape[0]),
  );
}

/**
 * The pool file a unit this runner wrote serves, read back from its
 * `ExecStart`, or nothing for a unit it did not write.
 *
 * @param {string} unit the unit file's text
 * @returns {string | undefined}
 */
export function unitPoolFile(unit) {
  const argv = unitExecStartArgv(unit) ?? [];
  const pool = argv.indexOf("--pool");
  return pool < 0 ? undefined : argv[pool + 1];
}

/**
 * What a unit runs, read back from an `ExecStart` exactly as `serviceUnit`
 * writes one, or nothing for any other.
 *
 * @param {string} unit the unit file's text
 * @returns {{node: string, cli: string, poolFile: string} | undefined}
 */
export function unitService(unit) {
  const argv = unitExecStartArgv(unit);
  if (argv?.length !== 5 || argv[2] !== "run" || argv[3] !== "--pool")
    return undefined;
  const [node, cli, , , poolFile] = argv;
  return { node, cli, poolFile };
}

/**
 * A pool's unit, or a member's chat host's, which differs only in what it
 * says it is.
 *
 * @param {{node: string, cli: string, poolFile: string, chat?: boolean}} service absolute paths, and whether the pool file is a chat host's
 */
export function serviceUnit(service) {
  const command = [service.node, service.cli, "run", "--pool", service.poolFile]
    .map(systemdQuoted)
    .join(" ");
  return [
    "[Unit]",
    service.chat === true
      ? "Description=chuggy-linux: a member's chat host, its sessions in a container"
      : "Description=chuggy-linux: a chuggy worker pool's jobs in containers",
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
 * A command as the operator types it, each argument `shellQuoted`.
 *
 * @param {readonly string[]} argv
 */
export function commandLine(argv) {
  return argv.map(shellQuoted).join(" ");
}

/** What reads the user's units again, once one is written. */
export const serviceReloadArgv = ["systemctl", "--user", "daemon-reload"];

/**
 * What starts a unit once it is written: the user's units read again, then
 * the unit enabled and started.
 *
 * @param {string} unitName
 */
export function serviceStartArgvs(unitName) {
  return [
    serviceReloadArgv,
    ["systemctl", "--user", "enable", "--now", unitName],
  ];
}

/** @param {string} unitName */
export function serviceEnableArgv(unitName) {
  return ["systemctl", "--user", "enable", unitName];
}

/** @param {string} unitName */
export function serviceRestartArgv(unitName) {
  return ["systemctl", "--user", "restart", unitName];
}

/** Lingering on, as the operator turns it on; it keeps their services running without a login. */
export const serviceLingerArgv = ["loginctl", "enable-linger"];

/**
 * What the operator runs once a unit is written. Where the legacy unit serves
 * the same pool, it is stopped and removed first, so the two never poll the
 * pool together.
 *
 * @param {string} unitName
 * @param {string} [legacyUnit] the legacy unit's file, where it serves this pool
 */
export function serviceCommands(unitName, legacyUnit) {
  return [
    ...(legacyUnit === undefined
      ? []
      : [
          ["systemctl", "--user", "disable", "--now", legacyServiceUnitName],
          ["rm", legacyUnit],
        ]),
    ...serviceStartArgvs(unitName),
    serviceLingerArgv,
  ].map(commandLine);
}
