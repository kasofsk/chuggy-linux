/**
 * A member's chat host composed: the worker core's chat host over this
 * machine's engine, from the runner's file, with what of this machine the
 * core cannot know: who owns the Claude credential as the engine shows it.
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

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
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
  poolRuntimeDirectory,
  runnerEngine,
  runnerUpdates,
} from "./runner.mjs";
import {
  credentialFileRefusal,
  runnerClaudeCredential,
} from "./runnerConfig.mjs";
import { unrestartedExitStatus, updatedExitStatus } from "./systemdUnit.mjs";

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
 * volumes, the Claude credential owned as `chatCredentialOwner` says, and
 * its kind.
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
    credentialFile: claudeCredentialFile(credential),
    credentialOwner: chatCredentialOwner(config.engine, user),
    claudeCredential: claudeCredentialSetting(credential),
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
 * Why the Claude credential cannot be handed to the supervisor, or nothing:
 * it is not this user's alone, whom the supervisor reads it as, or is not
 * alone in its directory, which the supervisor is given whole.
 *
 * @param {RunnerConfig} config
 * @param {number} uid this process's
 * @returns {Promise<string | undefined>}
 */
export async function chatCredentialRefusal(config, uid) {
  const credential = runnerClaudeCredential(config);
  const file = claudeCredentialFile(credential);
  return (
    (await credentialFileRefusal(
      claudeCredentialDescribed(claudeCredentialSetting(credential)),
      file,
      "host",
      uid,
    )) ?? (await chatCredentialAloneRefusal(file))
  );
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
  if (pass.passed === "Denied") return unrestartedExitStatus;
  const release = `${seams.package} ${pass.version}`;
  seams.log(
    seams.underService
      ? `ending, for the service to restart on ${release}`
      : `ending: start this run again to run ${release}`,
  );
  return updatedExitStatus;
}
