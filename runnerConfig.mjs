/**
 * The runner's own file and where on this machine the runner keeps what it
 * writes. The file is refused unless only its owner can read or write it, and
 * is read strictly, so a misspelt key is an error rather than a default. The
 * pool's credentials are the worker core's to read.
 */

import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { jobUid, reservedJobVariables } from "./job.mjs";

/**
 * @typedef {z.infer<typeof runnerConfigSchema>} RunnerConfig
 *
 * @typedef {object} RunnerPaths
 * @property {string} config
 * @property {string} unit the systemd user unit
 * @property {string} logs where an ended job's logs are saved
 * @property {string | undefined} runtime where pull credentials, env files and the control socket live; absent without XDG_RUNTIME_DIR
 */

/** The permission bits a group or anyone else would read or write by. */
const sharedModeBits = 0o077;

/** Far above what a runner's file holds, so a file past it is not one. */
const runnerConfigBytesMax = 64 * 1024;

const positiveSchema = z.number().int().positive().safe();

/** A name docker and podman both give a network, less the host's own. */
const networkSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  .refine((network) => network !== "host", {
    error: "may not be the host's network",
  });

const environmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z.string().regex(/^[^\r\n]*$/u, { error: "may not break a line" }),
  )
  .superRefine((environment, context) => {
    for (const name of reservedJobVariables)
      if (Object.hasOwn(environment, name))
        context.addIssue({
          code: "custom",
          path: [name],
          message: "is the runner's to set",
        });
  });

export const runnerConfigSchema = z.strictObject({
  engine: z.enum(["docker", "podman"]).default("docker"),
  concurrencyMax: positiveSchema.default(1),
  /** Where `claude setup-token`'s output was saved, named in a bind mount. */
  claudeTokenFile: z
    .string()
    .refine((file) => isAbsolute(file), { error: "must be an absolute path" })
    .refine((file) => !/[,\r\n]/u.test(file), {
      error: "cannot be named in a bind mount",
    }),
  timeoutSecsMax: positiveSchema,
  outputBytesMax: positiveSchema,
  environment: environmentSchema.default({}),
  network: networkSchema.default("chuggy-jobs"),
});

/**
 * Where the runner reads and writes, by the XDG base directories and their
 * defaults. A relative XDG value is ignored, as the specification says.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @returns {RunnerPaths}
 */
export function runnerPaths(environment, home) {
  const based = (variable, fallback) => {
    const value = environment[variable];
    return value !== undefined && isAbsolute(value) ? value : fallback;
  };
  const configHome = based("XDG_CONFIG_HOME", join(home, ".config"));
  const stateHome = based("XDG_STATE_HOME", join(home, ".local", "state"));
  const runtimeHome = based("XDG_RUNTIME_DIR", undefined);
  return {
    config: join(configHome, "chuggy-linux", "runner.json"),
    unit: join(configHome, "systemd", "user", "chuggy-linux.service"),
    logs: join(stateHome, "chuggy-linux", "logs"),
    runtime:
      runtimeHome === undefined ? undefined : join(runtimeHome, "chuggy-linux"),
  };
}

/**
 * The runner's file, checked and read through one handle so the file checked
 * is the file read.
 *
 * @param {string} file
 * @returns {Promise<RunnerConfig>}
 */
export async function runnerConfig(file) {
  const handle = await open(file, "r");
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`runner configuration ${file} is not a file`);
    if ((stats.mode & sharedModeBits) !== 0)
      throw new Error(
        `runner configuration ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`,
      );
    if (stats.size > runnerConfigBytesMax)
      throw new Error(`runner configuration ${file} is larger than one`);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`runner configuration ${file} is not JSON`);
  }
  const parsed = runnerConfigSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `runner configuration ${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

/**
 * Why this runner cannot hand its jobs the Claude token file, or nothing. The
 * file is its owner's alone and a job reads it as the image's user. Docker
 * runs that user as the same uid on this machine, so only a runner that is
 * that uid can hand the file over; rootless podman maps it onto the runner
 * itself. Only the file's metadata is read: the token reaches the job by mount
 * and never this process.
 *
 * @param {string} file
 * @param {"docker" | "podman"} engine
 * @param {number} runnerUid this process's uid, which must own the file
 * @returns {Promise<string | undefined>}
 */
export async function claudeTokenFileRefusal(file, engine, runnerUid) {
  if (engine === "docker" && runnerUid !== jobUid)
    return `docker runs a job as uid ${String(jobUid)}, and this runner is uid ${String(runnerUid)}, so no job could read a token file only this runner can; use rootless podman ("engine": "podman")`;
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return `the Claude token file ${file} cannot be found; save \`claude setup-token\`'s output there`;
  }
  if (!stats.isFile()) return `the Claude token file ${file} is not a file`;
  if ((stats.mode & sharedModeBits) !== 0)
    return `the Claude token file ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`;
  if (stats.size === 0) return `the Claude token file ${file} is empty`;
  if (stats.uid !== runnerUid)
    return `the Claude token file ${file} is owned by uid ${String(stats.uid)}, not by this runner's uid ${String(runnerUid)}`;
  return undefined;
}

/**
 * How a directory this process makes under the runtime directory is named:
 * what it is for, then the process, so a process leaving can find its own.
 *
 * @param {"pull" | "job"} kind
 * @param {number} pid
 */
export function runtimeScratch(kind, pid = process.pid) {
  return `${kind}-${String(pid)}-`;
}
