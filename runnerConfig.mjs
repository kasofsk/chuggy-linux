/**
 * The runner's own file and where on this machine the runner keeps what it
 * writes. The file is refused unless only its owner can read or write it, and
 * is read strictly, so a misspelt key is an error rather than a default; a
 * pool's name in `pools` is not a key of the file's own, and `doctor` checks
 * it against the pool files instead. The pool's credentials are the worker
 * core's to read.
 *
 * THE FILE NAMES ONE CLAUDE CREDENTIAL, by `claudeCredential` of any kind the
 * core takes or by `claudeTokenFile`, a subscription's, and may name another
 * agent's beside it, which a job requiring that agent is handed in its place:
 * Codex's by `codexCredential`.
 */

import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialSchema,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
import {
  ownerImagesSchema,
  ownerVolumesSchema,
} from "@chuggy/worker-core/containerBackend.mjs";
import { bindMountNameable } from "@chuggy/worker-core/engineArgv.mjs";
import { imageUnusedSecsMaxDefault } from "@chuggy/worker-core/imageCleanup.mjs";
import {
  jobEngineSocketEnvironment,
  jobUid,
  reservedJobVariables,
} from "@chuggy/worker-core/job.mjs";
import { registerDeclaredSchema } from "@chuggy/worker-core/register.mjs";

/**
 * @typedef {z.infer<typeof runnerConfigSchema>} RunnerConfig
 * @typedef {import("@chuggy/worker-core/claudeCredential.mjs").ClaudeCredential} ClaudeCredential
 * @typedef {import("@chuggy/worker-core/claudeCredential.mjs").ClaudeCredentialSetting} ClaudeCredentialSetting
 *
 * @typedef {object} RunnerPaths
 * @property {string} config
 * @property {string} units where systemd reads the user's units
 * @property {string} pools where `register` writes a pool file
 * @property {string} signIns where `mcp` keeps each site's sign-in
 * @property {string} logs where an ended job's logs are saved
 * @property {string} jobs where a job run on this machine itself has its directory
 * @property {string} images where the record of this machine's images is kept, one file per engine
 * @property {string | undefined} runtime where each pool's pull credentials, env files and control socket live; absent without XDG_RUNTIME_DIR
 */

/** The permission bits a group or anyone else would read or write by. */
const sharedModeBits = 0o077;

/** Far above what a runner's file holds, so a file past it is not one. */
const runnerConfigBytesMax = 64 * 1024;

const positiveSchema = z.number().int().positive().safe();

const nonnegativeSchema = z.number().int().nonnegative().safe();

/** The most GiB kept free whose bytes are still a safe integer. */
const freeGibMax = Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30);

/** A pool's service's own limits, each in place of the file's for that service alone. */
const poolLimitsSchema = z.strictObject({
  concurrencyMax: nonnegativeSchema.optional(),
  sessionsMax: nonnegativeSchema.optional(),
});

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

/** A credential's file, which each job is handed by a bind mount. */
const credentialFileSchema = z
  .string()
  .refine((file) => isAbsolute(file), { error: "must be an absolute path" })
  .refine((file) => bindMountNameable(file), {
    error: "cannot be named in a bind mount",
  });

/** The keys a credential of any kind names its file under. */
const credentialFileKeys = /** @type {const} */ ([
  "tokenFile",
  "apiKeyFile",
  "credentialsFile",
]);

/** The core's credential, its file held to what a bind mount names. */
const credentialSchema = claudeCredentialSchema.superRefine(
  (credential, context) => {
    for (const key of credentialFileKeys) {
      const file = /** @type {Record<string, unknown>} */ (credential)[key];
      if (file === undefined) continue;
      for (const issue of credentialFileSchema.safeParse(file).error?.issues ??
        [])
        context.addIssue({
          code: "custom",
          path: [key],
          message: issue.message,
        });
    }
  },
);

export const runnerConfigSchema = z
  .strictObject({
    engine: z.enum(["docker", "podman"]).default("docker"),
    /** The jobs held at once, none where it is 0, as on a runner kept for sessions. */
    concurrencyMax: nonnegativeSchema.default(1),
    /** The sessions held beside the jobs, none where it is 0. */
    sessionsMax: nonnegativeSchema.default(2),
    /** Where `claude setup-token`'s output was saved, a subscription's credential. */
    claudeTokenFile: credentialFileSchema.optional(),
    /** The credential Claude Code runs on, of any kind, in place of `claudeTokenFile`. */
    claudeCredential: credentialSchema.optional(),
    /** The `auth.json` `codex login` writes, which a job requiring `Agent:Codex` is handed. */
    codexCredential: z
      .strictObject({ authFile: credentialFileSchema })
      .optional(),
    timeoutSecsMax: positiveSchema,
    outputBytesMax: positiveSchema,
    environment: environmentSchema.default({}),
    network: networkSchema.default("chuggy-jobs"),
    /**
     * Whether each job is handed this machine's engine through its socket;
     * while it is, the variables that tell the job of it are the runner's.
     */
    engineSocket: z.boolean().default(false),
    /**
     * The images a job that pins none runs in, each with the capabilities its
     * owner declares it meets: the first meeting every one the job names.
     */
    images: ownerImagesSchema.default([]),
    /**
     * What this machine meets beside its platform and the agents the file
     * can run, which each pool's service advertises in place of what
     * `--capability` declared when its pool was registered.
     */
    capabilities: registerDeclaredSchema.optional(),
    /**
     * The named volumes and directories of this machine mounted into every
     * job, each field but `scope` named as `--mount` names it on docker and
     * podman alike. A named volume whose `scope` is "project" is one per
     * project, and no personal runner's job mounts it.
     */
    volumes: ownerVolumesSchema.default([]),
    /**
     * Limits of a pool's own, by its pool file's name without `.json`, as
     * `runnerPoolName` names it.
     */
    pools: z.record(z.string(), poolLimitsSchema).default({}),
    /** Whether the service installs the release of itself chuggy names. */
    autoUpdate: z.boolean().default(true),
    /**
     * How long a job's image this runner pulled may go unused before it is
     * removed, 0 keeping them until the disk is under `diskFreeGibMin`.
     */
    imageUnusedSecsMax: nonnegativeSchema.default(imageUnusedSecsMaxDefault),
    /**
     * The GiB the engine's storage keeps free: under it the service removes
     * the images it may and takes no job, and under half of it stops one.
     * None is kept where it is 0.
     */
    diskFreeGibMin: nonnegativeSchema.max(freeGibMax).default(20),
    /**
     * The GiB of the engine's memory its containers leave free, a reserve
     * for what the engine and its machine use outside every container. The
     * rest is the budget every running container and every held job is
     * counted against: a job is held until it has room and refused where it
     * asks more than the whole budget, and no job is taken while one is held
     * or the room is short. None is kept unless the file sets it, so the
     * whole of the engine's memory is the budget.
     */
    memoryFreeGibMin: nonnegativeSchema.max(freeGibMax).default(0),
  })
  // Beside whatever else the file gets wrong, as a missing key always was.
  .superRefine(configCredentialNamed, {
    when: ({ value }) => typeof value === "object" && value !== null,
  })
  .superRefine((config, context) => {
    configCredentialChecked(config, context);
    configLimitsChecked(config, context);
    if (!config.engineSocket) return;
    for (const name of Object.keys(
      jobEngineSocketEnvironment(config.engine, ""),
    ))
      if (Object.hasOwn(config.environment, name))
        context.addIssue({
          code: "custom",
          path: ["environment", name],
          message: "is the runner's to set while engineSocket is true",
        });
  });

/**
 * Holds the file to naming a Claude credential, telling one that names
 * neither key what one that named no token file always was.
 *
 * @param {Partial<RunnerConfig>} config
 * @param {z.core.$RefinementCtx} context
 */
function configCredentialNamed(config, context) {
  if (
    config.claudeTokenFile === undefined &&
    config.claudeCredential === undefined
  )
    context.addIssue({
      code: "invalid_type",
      expected: "string",
      input: undefined,
      path: ["claudeTokenFile"],
    });
}

/**
 * Holds the file to naming one Claude credential.
 *
 * @param {RunnerConfig} config
 * @param {z.core.$RefinementCtx} context
 */
function configCredentialChecked(config, context) {
  const { claudeTokenFile, claudeCredential } = config;
  if (claudeTokenFile !== undefined && claudeCredential !== undefined)
    context.addIssue({
      code: "custom",
      path: ["claudeCredential"],
      message:
        "names a Claude credential, and so does claudeTokenFile; keep one",
    });
}

/**
 * Holds the file to a runner that takes some work, and each pool's service
 * its `pools` entry limits to one that takes some.
 *
 * @param {RunnerConfig} config
 * @param {z.core.$RefinementCtx} context
 */
function configLimitsChecked(config, context) {
  if (config.concurrencyMax === 0 && config.sessionsMax === 0)
    context.addIssue({
      code: "custom",
      path: ["concurrencyMax"],
      message: "is 0 and so is sessionsMax, so this runner would take no work",
    });
  for (const [name, own] of Object.entries(config.pools)) {
    const limits = runnerPoolLimitsOver(config, own);
    if (limits.concurrencyMax === 0 && limits.sessionsMax === 0)
      context.addIssue({
        code: "custom",
        path: ["pools", name],
        message:
          "leaves this pool's service concurrencyMax 0 and sessionsMax 0, so it would take no work",
      });
  }
}

/**
 * The Claude credential a checked file names: its `claudeCredential`, or a
 * subscription's token where it names `claudeTokenFile`.
 *
 * @param {RunnerConfig} config
 * @returns {ClaudeCredential}
 */
export function runnerClaudeCredential(config) {
  if (config.claudeCredential !== undefined) return config.claudeCredential;
  if (config.claudeTokenFile === undefined)
    throw new Error("the runner's file names no Claude credential");
  return { kind: "Subscription", tokenFile: config.claudeTokenFile };
}

/** The agent `codexCredential` is the credential of, as an `Agent:` capability names it. */
export const runnerCodexAgent = "Codex";

/** How a refusal names the Codex credential's file, and what its owner does to make one. */
export const codexCredentialDescribed = {
  label: "Codex auth file",
  remedy: "run codex login, which writes it to ~/.codex/auth.json",
};

/**
 * What the backends are handed of a checked file's credentials: the Claude
 * credential's file and the setting that names its kind, which every run
 * names so that the core withholds what would choose another, and the file of
 * each other agent it names a credential for, by that agent's name.
 *
 * @param {RunnerConfig} config
 * @returns {{tokenFile: string, claudeCredential: ClaudeCredentialSetting, agentCredentialFiles: Record<string, string>}}
 */
export function runnerCredentialsHanded(config) {
  const credential = runnerClaudeCredential(config);
  return {
    tokenFile: claudeCredentialFile(credential),
    claudeCredential: claudeCredentialSetting(credential),
    agentCredentialFiles: {
      ...(config.codexCredential === undefined
        ? {}
        : { [runnerCodexAgent]: config.codexCredential.authFile }),
    },
  };
}

/**
 * How a refusal names the credential file of an agent, and what its owner
 * does to make one: Claude's by the kind its setting names.
 *
 * @param {ClaudeCredentialSetting} claudeCredential
 * @param {string} agent
 * @returns {{label: string, remedy: string}}
 */
export function runnerCredentialDescribed(claudeCredential, agent) {
  return agent === runnerCodexAgent
    ? codexCredentialDescribed
    : claudeCredentialDescribed(claudeCredential);
}

/**
 * The name a pool's own limits are found by in `pools`: its file's, without
 * `.json`, as `register` writes it and its service's unit is named for it.
 *
 * @param {string} poolFile
 */
export function runnerPoolName(poolFile) {
  return basename(poolFile, ".json");
}

/**
 * The limits a pool's service holds: those its entry in `pools` names, and
 * the file's for the rest.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
export function runnerPoolLimits(config, poolFile) {
  return runnerPoolLimitsOver(config, runnerPoolOwn(config, poolFile));
}

/**
 * @param {RunnerConfig} config
 * @param {RunnerConfig["pools"][string] | undefined} own
 */
function runnerPoolLimitsOver(config, own) {
  return {
    concurrencyMax: own?.concurrencyMax ?? config.concurrencyMax,
    sessionsMax: own?.sessionsMax ?? config.sessionsMax,
  };
}

/**
 * A pool's entry in `pools`, or nothing.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
function runnerPoolOwn(config, poolFile) {
  const name = runnerPoolName(poolFile);
  return Object.hasOwn(config.pools, name) ? config.pools[name] : undefined;
}

/**
 * How many jobs and sessions a pool's service holds at once, in the file's
 * own terms, and whether its entry in `pools` sets them.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
export function runnerConfigLimits(config, poolFile) {
  const { concurrencyMax, sessionsMax } = runnerPoolLimits(config, poolFile);
  const own =
    runnerPoolOwn(config, poolFile) === undefined
      ? ""
      : `, as pools.${runnerPoolName(poolFile)} sets them`;
  return `concurrencyMax ${String(concurrencyMax)}, sessionsMax ${String(sessionsMax)}${own}`;
}

/**
 * An XDG base directory, or its default where the variable is unset or, as
 * the specification says to ignore it, relative.
 *
 * @template {string | undefined} T
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} variable
 * @param {T} fallback
 */
function xdgBased(environment, variable, fallback) {
  const value = environment[variable];
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/**
 * Where the runner reads and writes, by the XDG base directories and their
 * defaults.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @returns {RunnerPaths}
 */
export function runnerPaths(environment, home) {
  const configHome = xdgBased(
    environment,
    "XDG_CONFIG_HOME",
    join(home, ".config"),
  );
  const stateHome = xdgBased(
    environment,
    "XDG_STATE_HOME",
    join(home, ".local", "state"),
  );
  const runtimeHome = xdgBased(environment, "XDG_RUNTIME_DIR", undefined);
  return {
    config: join(configHome, "chuggy-linux", "runner.json"),
    units: join(configHome, "systemd", "user"),
    pools: join(configHome, "chuggy", "pools"),
    signIns: join(configHome, "chuggy", "sign-ins"),
    logs: join(stateHome, "chuggy-linux", "logs"),
    jobs: join(stateHome, "chuggy-linux", "jobs"),
    images: join(stateHome, "chuggy-linux", "images"),
    runtime:
      runtimeHome === undefined ? undefined : join(runtimeHome, "chuggy-linux"),
  };
}

/** Where a podman package puts its registries.conf, then where this machine does. */
const containersSystemDirs = ["/usr/share/containers", "/etc/containers"];

/** What names a registries.conf in the environment, in place of or over the ones podman finds. */
const registriesConfVariables = [
  "CONTAINERS_REGISTRIES_CONF",
  "REGISTRIES_CONFIG_PATH",
  "CONTAINERS_REGISTRIES_CONF_OVERRIDE",
];

/**
 * Every registries.conf file and drop-in directory some supported podman
 * reads as this uid: those the environment names, the system's, and the
 * user's under both XDG_CONFIG_HOME and ~/.config, which older podman reads
 * whatever XDG_CONFIG_HOME says.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @param {number} uid
 * @returns {string[]}
 */
export function podmanRegistriesConf(environment, home, uid) {
  const named = registriesConfVariables.flatMap((variable) => {
    const value = environment[variable];
    return value === undefined || value === "" ? [] : [value];
  });
  const dropIns =
    uid === 0
      ? ["registries.rootful.conf.d"]
      : [
          "registries.rootless.conf.d",
          join("registries.rootless.conf.d", String(uid)),
        ];
  const system = containersSystemDirs.flatMap((root) => [
    join(root, "registries.conf"),
    join(root, "registries.conf.d"),
    ...dropIns.map((dropIn) => join(root, dropIn)),
  ]);
  const users = new Set([
    join(
      xdgBased(environment, "XDG_CONFIG_HOME", join(home, ".config")),
      "containers",
    ),
    join(home, ".config", "containers"),
  ]);
  return [
    ...named,
    ...system,
    ...[...users].flatMap((user) => [
      join(user, "registries.conf"),
      join(user, "registries.conf.d"),
    ]),
  ];
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
 * Why this runner cannot hand its jobs a credential's file, or nothing. The
 * file is its owner's alone and a job reads it as the image's user. Docker
 * runs that user as the same uid on this machine, so only a runner that is
 * that uid can hand the file over; rootless podman maps it onto the runner
 * itself. A job run on this machine itself reads it as this runner. Only the
 * file's metadata is read: the credential reaches the job by mount or by its
 * path, and never this process.
 *
 * @param {{label: string, remedy: string}} described how the file is named, as `runnerCredentialDescribed` names it
 * @param {string} file
 * @param {"docker" | "podman" | "host"} engine what runs the job that reads it
 * @param {number} runnerUid this process's uid, which must own the file
 * @returns {Promise<string | undefined>}
 */
export async function credentialFileRefusal(
  described,
  file,
  engine,
  runnerUid,
) {
  const { label, remedy } = described;
  if (engine === "docker" && runnerUid !== jobUid)
    return `docker runs a job as uid ${String(jobUid)}, and this runner is uid ${String(runnerUid)}, so no job could read the ${label} ${file}, which only this runner can; use rootless podman ("engine": "podman")`;
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return `the ${label} ${file} cannot be found; ${remedy}`;
  }
  if (!stats.isFile()) return `the ${label} ${file} is not a file`;
  if ((stats.mode & sharedModeBits) !== 0)
    return `the ${label} ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`;
  if (stats.size === 0) return `the ${label} ${file} is empty; ${remedy}`;
  if (stats.uid !== runnerUid)
    return `the ${label} ${file} is owned by uid ${String(stats.uid)}, not by this runner's uid ${String(runnerUid)}`;
  return undefined;
}
