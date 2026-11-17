/**
 * A member's chat host composed: the worker core's chat host over this
 * machine's engine, from the runner's file, with what of this machine the
 * core cannot know: who owns the Claude credentials as the engine shows it.
 * The host holds one selector over the file's sets for its life, and each
 * session runs on the Claude credential it chooses.
 *
 * THE SUPERVISOR READS THE CLAUDE CREDENTIAL AS ITS OWNER, as the engine
 * shows that owner inside the container. Rootful docker maps no user, so the
 * owner is this user's uid and gid there, and a session is run as this
 * machine's uid of its own number: a user whose uid a session takes is
 * refused. Rootless podman runs the container in this user's own namespace,
 * root inside being this user, so the owner is root there; its tmpfs takes
 * no owner but the container's user, which is then root too.
 */

import { setTimeout as delay } from "node:timers/promises";

import { agentCredentialSetCredentials } from "@chuggy/worker-core/agentCredentialSet.mjs";
import {
  chatCredentialAloneRefusal,
  chatHost,
  chatHostConfigured,
  chatHostVolumes,
  chatSupervisorNaming,
  chatSupervisorStarted,
  checkedChatHostSettings,
} from "@chuggy/worker-core/chatHost.mjs";
import { chatSessionLogs } from "@chuggy/worker-core/chatHostLog.mjs";
import {
  chatSessionUidCount,
  chatSessionUidFirst,
} from "@chuggy/worker-core/chatSession.mjs";

import {
  engineEndpoint,
  ownScratchRemoved,
  poolRuntimeDirectory,
  runnerEngine,
  runnerUpdates,
} from "./runner.mjs";
import {
  credentialFileRefusal,
  runnerCredentialDescribed,
  runnerCredentialSets,
  runnerCredentialsHanded,
} from "./runnerConfig.mjs";
import {
  serviceStopTimeoutMsDefault,
  unrestartedExitStatus,
  updatedExitStatus,
} from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatHostSettings} ChatHostSettings
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatSupervisorPlaces} ChatSupervisorPlaces
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
 * @typedef {object} ChatRunnerHost
 * @property {ChatUser} user
 * @property {(line: string) => void} log
 * @property {Engine} [engine] when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] when not the host's issuer
 * @property {typeof globalThis.fetch} [fetch] what the plane is reached by, when not the global fetch
 * @property {typeof import("node:child_process").spawn} [spawn] what starts the engine's `run`, when not Node's own
 * @property {() => number} [nowMs]
 */

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
 * volumes, and a selector over the file's credentials, the Claude ones owned
 * as `chatCredentialOwner` says.
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
  return {
    volumes: chatHostVolumes(identity),
    credentialOwner: chatCredentialOwner(config.engine, user),
    credentials: runnerCredentialsHanded(config).credentials,
  };
}

/**
 * A chat host's settings from the runner's file, checked as the core checks
 * them against its engine.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @param {ChatUser} user
 * @returns {ChatHostSettings}
 */
export function chatHostSettings(identity, config, user) {
  return checkedChatHostSettings(
    {
      ...chatHostConfigured(config.chat, config.outputBytesMax),
      places: chatHostPlaces(identity, config, user),
    },
    config.engine,
  );
}

/**
 * Why the Claude credentials cannot be handed to the supervisor, or nothing:
 * the first of the file's Claude set that is not this user's alone, whom the
 * supervisor reads it as, or is not alone in its directory. The supervisor
 * is given the directory of every one of them whole, whichever a session
 * runs on.
 *
 * @param {RunnerConfig} config
 * @param {number} uid this process's
 * @returns {Promise<string | undefined>}
 */
export async function chatCredentialRefusal(config, uid) {
  const set = runnerCredentialSets(config).Claude;
  for (const credential of set === undefined
    ? []
    : agentCredentialSetCredentials(set)) {
    const refusal =
      (await credentialFileRefusal(
        runnerCredentialDescribed(credential),
        credential.file,
        "host",
        uid,
      )) ?? (await chatCredentialAloneRefusal(credential.file));
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * A member's chat host from the files read, its settings checked against its
 * engine and its credential against what the supervisor is handed, and the
 * runtime directory its pulls and door are kept in.
 *
 * @param {RunnerSetup} setup
 * @param {ChatRunnerHost} host
 * @param {RunnerCopy} copy
 */
export async function chatRunnerParts(setup, host, copy) {
  const { config, paths } = setup;
  const identity = /** @type {ChatHostIdentity} */ (setup.credentials);
  const settings = chatHostSettings(identity, config, host.user);
  const refusal = await chatCredentialRefusal(config, host.user.uid);
  if (refusal !== undefined) throw new Error(refusal);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(config.engine, engine);
  const runtime = poolRuntimeDirectory(paths, identity);
  const nowMs = host.nowMs ?? Date.now;
  const chat = chatHost(setup.credentials, settings, {
    engine,
    site: { engine: config.engine, runtimeDir: runtime, dockerHost },
    started: chatSupervisorStarted({
      engine,
      naming: chatSupervisorNaming(identity, config.network),
      ...(host.spawn === undefined ? {} : { spawn: host.spawn }),
    }),
    log: host.log,
    logFor: chatSessionLogs(paths.logs, identity, { log: host.log, nowMs }),
    sleep: (ms) => delay(ms),
    nowMs,
    ...(host.tokens === undefined ? {} : { tokens: host.tokens }),
    ...(host.fetch === undefined ? {} : { fetch: host.fetch }),
    runner: { package: copy.package, version: copy.version },
    updates: runnerUpdates(setup, copy),
  });
  return { chat, engine, runtime };
}

/** What a signal gives the host's end: a third of systemd's stop timeout. */
export const chatRunnerEndWaitMs = serviceStopTimeoutMsDefault / 3;

/**
 * How long after a signal a host not yet ended is ended by it anyway: two
 * thirds of systemd's stop timeout, so the process ends before systemd
 * kills it.
 */
export const chatRunnerEndExitMs = (serviceStopTimeoutMsDefault * 2) / 3;

/**
 * @typedef {object} ChatRunnerSignals what a signal is heard and raised by, as `process` does
 * @property {(signal: NodeJS.Signals, listener: () => void) => unknown} once
 * @property {(pid: number, signal: NodeJS.Signals) => unknown} kill
 * @property {number} pid
 */

/**
 * Has a SIGTERM, SIGINT or SIGHUP end the chat host within
 * `chatRunnerEndWaitMs`, after which its run answers `Ended`. A host still
 * running at `chatRunnerEndExitMs` has this process's own scratch removed
 * and the process ended by that signal, as a pool's run is at once.
 *
 * @param {import("@chuggy/worker-core/chatHost.mjs").ChatHost} chat
 * @param {string} runtime the host's runtime directory
 * @param {ChatRunnerSignals} [signals]
 */
export function chatRunnerEndedOnSignal(chat, runtime, signals = process) {
  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
    signals.once(signal, () => {
      chat.end(chatRunnerEndWaitMs);
      globalThis
        .setTimeout(() => {
          try {
            ownScratchRemoved(runtime, signals.pid);
          } finally {
            signals.kill(signals.pid, signal);
          }
        }, chatRunnerEndExitMs)
        .unref();
    });
}

/**
 * The chat host until the plane denies it, which the unit does not restart,
 * until the runner has installed a release of itself, which the unit
 * restarts it on, or until it is ended, which exits 0, a stop systemd takes
 * as clean. Each way its supervisor has ended, and every session with it.
 *
 * @param {import("@chuggy/worker-core/chatHost.mjs").ChatHost} chat
 * @param {{log: (line: string) => void, underService: boolean, package: string}} seams
 * @returns {Promise<number>} the exit status
 */
export async function chatRunnerLoop(chat, seams) {
  const pass = await chat.run();
  if (pass.passed === "Ended") return 0;
  if (pass.passed === "Denied") return unrestartedExitStatus;
  const release = `${seams.package} ${pass.version}`;
  seams.log(
    seams.underService
      ? `ending, for the service to restart on ${release}`
      : `ending: start this run again to run ${release}`,
  );
  return updatedExitStatus;
}
