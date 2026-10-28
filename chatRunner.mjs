/**
 * A member's chat host composed: the worker core's chat host loop over this
 * machine's engine, its supervisor run as `docker run` or `podman run` from
 * the spec the core states, and its sessions' logs kept beside a job's.
 *
 * THE SUPERVISOR READS THE CLAUDE CREDENTIAL AS ITS OWNER, as the engine
 * shows that owner inside the container. Rootful docker maps no user, so the
 * owner is this user's uid and gid there, and a session is run as this
 * machine's uid of its own number: a user whose uid a session takes is
 * refused. Rootless podman runs the container in this user's own namespace,
 * root inside being this user, so the owner is root there; its tmpfs takes
 * no owner but the container's user, which is then root too.
 *
 * ONE SUPERVISOR A HOST, BY NAME. Its container is named for the host, so a
 * second started beside a first, which would share its volumes, is refused
 * by the engine, and the core starts it again after its backoff.
 */

import { Buffer } from "node:buffer";
import { spawn as spawnDefault } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { claudeAgent } from "@chuggy/worker-core/claude.mjs";
import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
import { chatHost, chatHostVolumes } from "@chuggy/worker-core/chatHost.mjs";
import {
  chatMirrorGroupCount,
  chatMirrorGroupFirst,
} from "@chuggy/worker-core/chatCheckout.mjs";
import {
  chatSessionUidCount,
  chatSessionUidFirst,
} from "@chuggy/worker-core/chatSession.mjs";
import {
  killArgv,
  poolLabel,
  removeArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  poolIdentityDigest,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";
import { savedLogBytesMax } from "@chuggy/worker-core/savedLog.mjs";

import {
  engineEndpoint,
  poolRuntimeDirectory,
  runnerEngine,
  runnerUpdates,
} from "./runner.mjs";
import {
  credentialFileRefusal,
  runnerChatSettings,
  runnerClaudeCredential,
} from "./runnerConfig.mjs";
import { deniedExitStatus, updatedExitStatus } from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatSupervisorContainer} ChatSupervisorContainer
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatSupervisorPlaces} ChatSupervisorPlaces
 * @typedef {import("@chuggy/worker-core/chatHostBackend.mjs").ChatSupervisorHandle} ChatSupervisorHandle
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./runner.mjs").RunnerSetup} RunnerSetup
 * @typedef {import("./runner.mjs").RunnerCopy} RunnerCopy
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {object} ChatUser this process's user
 * @property {number} uid
 * @property {number} gid
 *
 * @typedef {object} ChatSupervisorNaming what the supervisor's container is called and joins
 * @property {string} name
 * @property {string} label the pool label's value, of the host
 * @property {string} network
 *
 * @typedef {object} ChatRunnerHost
 * @property {ChatUser} user
 * @property {(line: string) => void} log
 * @property {Engine} [engine] when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] when not the host's issuer
 * @property {typeof globalThis.fetch} [fetch] what the plane is reached by, when not the global fetch
 * @property {typeof spawnDefault} [spawn] what starts the engine's `run`, when not Node's own
 * @property {() => number} [nowMs]
 */

/** The users a session is run as, and the groups a mirror is given, each above the last it takes. */
export const chatSessionIdsNeeded = {
  uids: chatSessionUidFirst + chatSessionUidCount,
  gids: Math.max(
    chatSessionUidFirst + chatSessionUidCount,
    chatMirrorGroupFirst + chatMirrorGroupCount,
  ),
};

/**
 * The supervisor's container's name, one per host, as its volumes are named.
 *
 * @param {ChatHostIdentity} identity
 */
export function chatSupervisorName(identity) {
  return `chuggy-chat-${poolIdentityDigest(identity)}`;
}

/**
 * Why docker cannot run a session beside this user, or nothing: docker maps
 * no user, so a session is run as this machine's uid of its number, and one
 * that is this user's could read the credential.
 *
 * @param {number} uid
 * @returns {string | undefined}
 */
export function chatDockerUidRefusal(uid) {
  const last = chatSessionUidFirst + chatSessionUidCount - 1;
  if (uid < chatSessionUidFirst || uid > last) return undefined;
  return `docker runs each chat session as this machine's uid ${String(chatSessionUidFirst)} to ${String(last)}, and this user is uid ${String(uid)}, so a session would be this user; run the chat host as another user, or on rootless podman ("engine": "podman")`;
}

/**
 * Who owns the credential's file as the container shows it: this user on
 * docker, and root on podman, whose rootless container maps root onto this
 * user and whose rootful one maps nothing for a user that is root.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {ChatUser} user
 */
export function chatCredentialOwner(engine, user) {
  return engine === "podman" ? { uid: 0, gid: 0 } : { ...user };
}

/**
 * What the supervisor's container is given of this machine: the host's
 * volumes, the Claude credential in the slot Claude's sessions name, owned
 * as `chatCredentialOwner` says, and its kind.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @param {ChatUser} user
 * @returns {ChatSupervisorPlaces}
 */
export function chatHostPlaces(identity, config, user) {
  if (config.engine === "docker") {
    const refusal = chatDockerUidRefusal(user.uid);
    if (refusal !== undefined) throw new Error(refusal);
  }
  const credential = runnerClaudeCredential(config);
  return {
    volumes: chatHostVolumes(identity),
    credentialFiles: {
      [claudeAgent.credential]: claudeCredentialFile(credential),
    },
    credentialOwner: chatCredentialOwner(config.engine, user),
    claudeCredential: claudeCredentialSetting(credential),
  };
}

/**
 * Why a credential's directory is not its own, or nothing: the supervisor is
 * given the directory whole, so whatever else is in it, it can read.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export async function chatCredentialDirectoryRefusal(file) {
  const directory = dirname(file);
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return `${directory}, which holds the credential ${file}, cannot be read`;
  }
  const others = entries.filter((entry) => entry !== basename(file));
  if (others.length === 0) return undefined;
  return `${directory} holds ${others.join(", ")} beside the credential ${file}, and the chat supervisor is given the directory whole; move the credential into a directory of its own`;
}

/**
 * The places, refused where the Claude credential is not this user's alone,
 * which the supervisor reads it as, or its directory holds anything else.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @param {ChatUser} user
 */
async function chatHostPlacesChecked(identity, config, user) {
  const places = chatHostPlaces(identity, config, user);
  const file = places.credentialFiles[claudeAgent.credential];
  const refusal =
    (await credentialFileRefusal(
      claudeCredentialDescribed(
        claudeCredentialSetting(runnerClaudeCredential(config)),
      ),
      file,
      "host",
      user.uid,
    )) ?? (await chatCredentialDirectoryRefusal(file));
  if (refusal !== undefined) throw new Error(refusal);
  return places;
}

/**
 * One tmpfs's options. Docker takes its owner as `uid` and `gid`; podman
 * refuses those and leaves it the container's user's, root, so a tmpfs to be
 * anyone else's is refused, and it copies nothing of the image's directory
 * into it, as docker does not.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {ChatSupervisorContainer["tmpfs"][number]} tmpfs
 */
export function chatSupervisorTmpfs(engine, tmpfs) {
  const options = [
    "rw",
    ...tmpfs.flags,
    `size=${String(tmpfs.sizeBytes)}`,
    `mode=0${tmpfs.mode.toString(8)}`,
  ];
  if (engine === "docker")
    options.push(`uid=${String(tmpfs.uid)}`, `gid=${String(tmpfs.gid)}`);
  else if (tmpfs.uid !== 0 || tmpfs.gid !== 0)
    throw new RangeError(
      `podman leaves a tmpfs root's, and ${tmpfs.target} is to be ${String(tmpfs.uid)}:${String(tmpfs.gid)}'s`,
    );
  else options.push("notmpcopyup");
  return `${tmpfs.target}:${options.join(",")}`;
}

/**
 * The supervisor's `run`, attached and removed once it exits, from the
 * container the core states: its input held open, its image never pulled
 * here, since the core has pulled it, and no log kept by the engine, since
 * every line is the host's to route. Its environment is named in the argv
 * and carried by the engine's own, so no value of it is in an argv. On
 * podman the container runs in this user's own namespace whatever
 * containers.conf says, so root inside is this user.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {ChatSupervisorContainer} container
 * @param {ChatSupervisorNaming} naming
 * @returns {{argv: string[], environment: Record<string, string>}}
 */
export function chatSupervisorRunArgv(engine, container, naming) {
  if (container.interactive !== true)
    throw new RangeError("a chat supervisor's input is held open");
  const [entrypoint, ...command] = container.command;
  const { drop, add } = container.capabilities;
  return {
    argv: [
      "run",
      "-i",
      "--rm",
      "--pull=never",
      "--name",
      naming.name,
      "--label",
      `${poolLabel}=${naming.label}`,
      "--log-driver",
      "none",
      "--user",
      container.user,
      ...(engine === "podman" ? ["--userns=host"] : []),
      ...drop.flatMap((capability) => ["--cap-drop", capability]),
      ...add.flatMap((capability) => ["--cap-add", capability]),
      ...container.securityOptions.flatMap((option) => [
        "--security-opt",
        option,
      ]),
      ...container.volumes.flatMap(({ volume, target }) => [
        "--volume",
        `${volume}:${target}`,
      ]),
      ...container.tmpfs.flatMap((tmpfs) => [
        "--tmpfs",
        chatSupervisorTmpfs(engine, tmpfs),
      ]),
      ...container.binds.flatMap(({ source, target }) => [
        "--mount",
        `type=bind,source=${source},target=${target},readonly`,
      ]),
      ...Object.keys(container.environment).flatMap((name) => ["--env", name]),
      "--network",
      naming.network,
      "--entrypoint",
      entrypoint,
      container.image,
      ...command,
    ],
    environment: { ...container.environment },
  };
}

/**
 * What starts the supervisor: the engine's `run` as a child of this process,
 * its standard streams the supervisor's, once a container of its name that
 * has exited is removed, which a run the engine did not see end leaves
 * behind and which would refuse every start after. One still running is not
 * removed, and refuses this start instead. It has exited once the child has,
 * or could not start, leaving its output to be read to its end. A kill ends
 * the child and asks the engine to kill the container, which a client's end
 * alone does not.
 *
 * @param {RunnerConfig["engine"]} engineName
 * @param {Engine} engine
 * @param {typeof spawnDefault} spawn
 * @param {ChatSupervisorNaming} naming
 * @returns {(container: ChatSupervisorContainer) => Promise<ChatSupervisorHandle>}
 */
export function chatSupervisorStarted(engineName, engine, spawn, naming) {
  return async (container) => {
    await engine.exec(removeArgv(naming.name));
    const { argv, environment } = chatSupervisorRunArgv(
      engineName,
      container,
      naming,
    );
    const child = spawn(engineName, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...environment },
    });
    const exited = new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    });
    return {
      input: child.stdin,
      output: child.stdout,
      errors: child.stderr,
      exited,
      kill: () => {
        child.kill("SIGKILL");
        engine.exec(killArgv(naming.name)).catch(() => undefined);
      },
    };
  };
}

/** How many sessions' logs are kept open at once, the least recently written let go and found again from its file. */
const chatSessionLogsKeptMax = 256;

/**
 * Each session's log, `chuggy-chat-<digest>.log` under `directory`, the
 * digest of the host and the session's assignment as a job's log is named,
 * owner-only. A new log opens naming its assignment, and every line is
 * stamped. One that reaches `savedLogBytesMax` keeps nothing more, and says
 * so once; one that cannot be written is said so of on the host's log, once.
 *
 * @param {string} directory
 * @param {ChatHostIdentity} identity
 * @param {{log: (line: string) => void, nowMs: () => number}} seams
 * @returns {(assignment: string) => (line: string) => void}
 */
export function chatSessionLogs(directory, identity, seams) {
  /** @type {Map<string, {file: string, bytes: number, stopped: boolean}>} */
  const kept = new Map();
  const opened = (assignment) => {
    const known = kept.get(assignment);
    if (known !== undefined) {
      kept.delete(assignment);
      kept.set(assignment, known);
      return known;
    }
    const file = join(
      directory,
      `chuggy-chat-${poolIdentityDigest(identity, assignment)}.log`,
    );
    let bytes;
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }
    const log = { file, bytes, stopped: bytes >= savedLogBytesMax };
    kept.set(assignment, log);
    while (kept.size > chatSessionLogsKeptMax)
      kept.delete(/** @type {string} */ (kept.keys().next().value));
    if (bytes === 0) chatSessionLogWritten(log, `session ${assignment}`, seams);
    return log;
  };
  return (assignment) => (line) => {
    const log = opened(assignment);
    if (log.stopped) return;
    const stamped = `${new Date(seams.nowMs()).toISOString()} ${line}`;
    if (log.bytes + Buffer.byteLength(stamped) + 1 > savedLogBytesMax) {
      chatSessionLogWritten(
        log,
        `[chuggy keeps no more of this log, past ${String(savedLogBytesMax)} bytes]`,
        seams,
      );
      log.stopped = true;
      return;
    }
    chatSessionLogWritten(log, stamped, seams);
  };
}

/** One line appended to a session's log, which stops at a failure and says so on the host's. */
function chatSessionLogWritten(log, text, seams) {
  if (log.stopped) return;
  const line = `${text}\n`;
  try {
    mkdirSync(dirname(log.file), { recursive: true, mode: 0o700 });
    appendFileSync(log.file, line, { mode: 0o600 });
    log.bytes += Buffer.byteLength(line);
  } catch (failure) {
    log.stopped = true;
    seams.log(
      `${log.file} could not be written, and keeps nothing more: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
}

/**
 * The supervisor's naming for a host: its name, its label, and the runner's
 * network, which every job here joins too.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @returns {ChatSupervisorNaming}
 */
export function chatSupervisorNaming(identity, config) {
  return {
    name: chatSupervisorName(identity),
    label: poolLabelValue(identity),
    network: config.network,
  };
}

/**
 * A member's chat host from the files read, its engine checked to be one a
 * supervisor can be run by, and the runtime directory its pulls and door
 * are kept in.
 *
 * @param {RunnerSetup} setup
 * @param {ChatRunnerHost} host
 * @param {RunnerCopy} copy
 */
export async function chatRunnerParts(setup, host, copy) {
  const { config, paths } = setup;
  const identity = /** @type {ChatHostIdentity} */ (setup.credentials);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(config.engine, engine);
  const runtime = poolRuntimeDirectory(paths, identity);
  const places = await chatHostPlacesChecked(identity, config, host.user);
  const nowMs = host.nowMs ?? Date.now;
  const chat = chatHost(
    setup.credentials,
    { ...runnerChatSettings(config), places },
    {
      engine,
      site: { engine: config.engine, runtimeDir: runtime, dockerHost },
      started: chatSupervisorStarted(
        config.engine,
        engine,
        host.spawn ?? spawnDefault,
        chatSupervisorNaming(identity, config),
      ),
      log: host.log,
      logFor: chatSessionLogs(paths.logs, identity, { log: host.log, nowMs }),
      sleep: (ms) => delay(ms),
      nowMs,
      ...(host.tokens === undefined ? {} : { tokens: host.tokens }),
      ...(host.fetch === undefined ? {} : { fetch: host.fetch }),
      runner: { package: copy.package, version: copy.version },
      updates: runnerUpdates(setup, copy),
    },
  );
  return { chat, engine, runtime };
}

/**
 * What the service's door answers of a chat host: its status, as the one
 * entry of what it is placing, and a refusal of every stop, since a
 * session is stopped in chuggy.
 *
 * @param {import("@chuggy/worker-core/chatHost.mjs").ChatHost} chat
 * @returns {import("@chuggy/worker-core/control.mjs").ControlBackend}
 */
export function chatHostControl(chat) {
  return {
    inFlight: () => [chat.status()],
    stop: async () => ({
      refused: "a chat host's sessions are stopped in chuggy",
    }),
  };
}

/**
 * The chat host until the plane denies it, which the unit does not restart,
 * or until the runner has installed a release of itself, which the unit
 * restarts it on. Either way its supervisor has ended, and every session
 * with it.
 *
 * @param {import("@chuggy/worker-core/chatHost.mjs").ChatHost} chat
 * @param {{log: (line: string) => void, underService: boolean, package: string}} seams
 * @returns {Promise<number>} the exit status
 */
export async function chatRunnerLoop(chat, seams) {
  const pass = await chat.run();
  if (pass.passed === "Denied") return deniedExitStatus;
  const release = `${seams.package} ${pass.version}`;
  seams.log(
    seams.underService
      ? `ending, for the service to restart on ${release}`
      : `ending: start this run again to run ${release}`,
  );
  return updatedExitStatus;
}
