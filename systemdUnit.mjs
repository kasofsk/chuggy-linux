/**
 * The systemd user unit the service runs under. It restarts the runner after
 * any failure but one: a pool the plane denied exits `deniedExitStatus`, and
 * no restart of it would be answered differently.
 */

/** The exit status of a run the plane ended by denying the pool. */
export const deniedExitStatus = 3;

export const serviceUnitName = "chuggy-linux.service";

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

/** What the operator runs once the unit is written; lingering keeps it running without a login. */
export const serviceCommands = [
  "systemctl --user daemon-reload",
  `systemctl --user enable --now ${serviceUnitName}`,
  "loginctl enable-linger",
];
