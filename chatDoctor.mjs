/**
 * What `doctor` checks of a member's chat host beyond what it checks of any
 * pool: its settings and the memory its supervisor's engine is asked to cap
 * it at; the Claude credential's directory, which the supervisor is given
 * whole; whether a session's user can be run beside this one; a
 * supervisor's container no service here runs, which refuses every start;
 * and the image the supervisor runs, which doctor pulls where it is not
 * here, as a run would before starting it.
 *
 * A SERVICE THAT ANSWERS IS THERE, whether or not this copy can read what it
 * says, as an older copy of the runner mid-update may answer: its
 * supervisor's container is its own, and nothing here says to remove it.
 */

import { claudeCredentialFile } from "@chuggy/worker-core/claudeCredential.mjs";
import {
  chatCredentialAloneRefusal,
  chatHostMemoryBytes,
  chatHostStatusAsked,
  chatSessionIdsNeeded,
  chatSupervisorName,
} from "@chuggy/worker-core/chatHost.mjs";
import {
  chatSessionUidCount,
  chatSessionUidFirst,
} from "@chuggy/worker-core/chatSession.mjs";
import {
  imageInspectArgv,
  inspectArgv,
  listArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolLabelValue } from "@chuggy/worker-core/poolIdentity.mjs";
import {
  imageRegistryHost,
  registryPull,
} from "@chuggy/worker-core/registryAuth.mjs";

import { chatDockerUidRefusal, chatHostSettings } from "./chatRunner.mjs";
import { runnerClaudeCredential } from "./runnerConfig.mjs";

/**
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatHostStatus} ChatHostStatus
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./chatRunner.mjs").ChatUser} ChatUser
 * @typedef {import("./doctor.mjs").DoctorFinding} DoctorFinding
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/registryAuth.mjs").PullSite} PullSite
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {{none: true} | {status: ChatHostStatus} | {unreadable: string}} ChatDoctorService no service answers at the host's door, or one answers what this copy reads, or one answers what it cannot
 */

/** The most lines an id map is read to, far above the kernel's own bound. */
const idMapLinesMax = 340;

/**
 * How many ids, from 0 up, an id map such as `/proc/self/uid_map` maps
 * without a gap.
 *
 * @param {string} text each line an id inside, the id it maps onto, and how many follow
 */
export function idMapContiguous(text) {
  const ranges = text
    .split("\n")
    .slice(0, idMapLinesMax)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/u).map(Number);
      return fields.length === 3 && fields.every(Number.isSafeInteger)
        ? [{ first: fields[0], count: fields[2] }]
        : [];
    })
    .sort((one, other) => one.first - other.first);
  let next = 0;
  for (const { first, count } of ranges) {
    if (first > next) break;
    next = Math.max(next, first + count);
  }
  return next;
}

/**
 * What of podman's namespace a chat container needs and lacks: every
 * session's uid, and every mirror's group, below what it maps.
 *
 * @param {{uids: number, gids: number}} mapped how many of each it maps from 0 without a gap
 * @returns {string | undefined}
 */
export function chatPodmanIdsRefusal(mapped) {
  const short = [
    mapped.uids < chatSessionIdsNeeded.uids
      ? `${String(mapped.uids)} uids where its sessions need ${String(chatSessionIdsNeeded.uids)}`
      : undefined,
    mapped.gids < chatSessionIdsNeeded.gids
      ? `${String(mapped.gids)} gids where its sessions and mirrors need ${String(chatSessionIdsNeeded.gids)}`
      : undefined,
  ].filter((line) => line !== undefined);
  if (short.length === 0) return undefined;
  return `podman's namespace for this user maps ${short.join(", and ")}; give this user a range in /etc/subuid and /etc/subgid at least that large, then run podman system migrate`;
}

/**
 * Whether a session can be run as a user of its own beside this one: on
 * docker, as this machine's uid of its number, which must not be this
 * user's; on rootless podman, as an id of this user's namespace, which must
 * map every one a session and a mirror takes. Rootful podman runs each as
 * this machine's uid of its number, which root never is.
 *
 * @param {Engine} engine
 * @param {RunnerConfig["engine"]} name
 * @param {number} uid this process's
 * @returns {Promise<DoctorFinding>}
 */
export async function chatSessionUsersFinding(engine, name, uid) {
  const check = "chat session users";
  const last = chatSessionUidFirst + chatSessionUidCount - 1;
  const range = `uids ${String(chatSessionUidFirst)} to ${String(last)}`;
  if (name === "docker") {
    const refusal = chatDockerUidRefusal(uid);
    return refusal === undefined
      ? {
          check,
          passed: true,
          detail: `docker runs each session as this machine's ${range}, none of them this user's uid ${String(uid)}`,
        }
      : { check, passed: false, detail: refusal };
  }
  if (uid === 0)
    return {
      check,
      passed: true,
      detail: `rootful podman runs each session as this machine's ${range}`,
    };
  /** @param {string} file */
  const mapped = async (file) => {
    const answer = await engine.exec(["unshare", "cat", file]);
    if (answer.code !== 0)
      throw new Error(
        `podman unshare cat ${file}: ${engineFailureLine(answer)}`,
      );
    return idMapContiguous(answer.stdout);
  };
  try {
    const ids = {
      uids: await mapped("/proc/self/uid_map"),
      gids: await mapped("/proc/self/gid_map"),
    };
    const refusal = chatPodmanIdsRefusal(ids);
    if (refusal !== undefined) return { check, passed: false, detail: refusal };
    return {
      check,
      passed: true,
      detail: `podman maps ${String(ids.uids)} uids and ${String(ids.gids)} gids for this user, root among them being this user, so each session's ${range} is one of this user's subordinate ids`,
    };
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

/**
 * Whether the Claude credential is in a directory of its own, which the
 * supervisor is given whole.
 *
 * @param {RunnerConfig} config
 * @returns {Promise<DoctorFinding>}
 */
export async function chatCredentialDirectoryFinding(config) {
  const check = "chat credential directory";
  const file = claudeCredentialFile(runnerClaudeCredential(config));
  const refusal = await chatCredentialAloneRefusal(file);
  return refusal === undefined
    ? {
        check,
        passed: true,
        detail: `${file} is alone in its directory, which the chat supervisor is given read-only`,
      }
    : { check, passed: false, detail: refusal };
}

/**
 * How many of the host's containers the engine lists: its supervisor, while
 * one runs.
 *
 * @param {Engine} engine
 * @param {RunnerConfig["engine"]} name
 * @param {string | undefined} endpoint
 * @param {PoolCredentials} credentials
 * @returns {Promise<DoctorFinding>}
 */
export async function chatEngineFinding(engine, name, endpoint, credentials) {
  const check = "container engine";
  const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
  if (listed.code !== 0)
    return { check, passed: false, detail: engineFailureLine(listed) };
  const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
  return {
    check,
    passed: true,
    detail: `${name}${endpoint === undefined ? "" : ` at ${endpoint}`} lists ${String(count)} of this chat host's containers`,
  };
}

/**
 * Whether the supervisor's image is here or can be pulled, as a run pulls
 * it: the host's own as its setting says, or the one the plane names, under
 * the pool's token where it is in the pool's registry.
 *
 * @param {object} reach
 * @param {Engine} reach.engine
 * @param {PullSite} reach.site
 * @param {PoolCredentials} reach.credentials
 * @param {WorkerPoolClient["tokens"]} reach.tokens
 * @param {RunnerConfig["chat"]} chat
 * @param {string | undefined} named the image the plane named, where it was polled
 * @returns {Promise<DoctorFinding>}
 */
export async function chatImageFinding(reach, chat, named) {
  const check = "chat image";
  const own = chat?.image;
  const image = own?.image ?? named;
  if (image === undefined)
    return {
      check,
      passed: false,
      detail:
        "the plane named no session image and the runner's file sets no chat.image, so no supervisor can start",
    };
  const whose = own === undefined ? "the plane's" : "the host's own";
  const here = (await reach.engine.exec(imageInspectArgv(image))).code === 0;
  if (here)
    return {
      check,
      passed: true,
      detail: `${whose} ${image} is here${own?.pull === "always" ? ", and is pulled again before each start" : ""}`,
    };
  if (own?.pull === "never")
    return {
      check,
      passed: false,
      detail: `${whose} ${image} is not here, and chat.image.pull is never`,
    };
  const registry = imageRegistryHost(image);
  let credential;
  if (own === undefined && registry === reach.credentials.registryHost) {
    const acquired = await reach.tokens.acquire();
    if (acquired.acquired !== "Token")
      return {
        check,
        passed: false,
        detail: `the pool has no token to pull ${image} with: ${acquired.evidence}`,
      };
    credential = { host: registry, token: acquired.token };
  }
  const answer = await registryPull(
    reach.site,
    image,
    undefined,
    credential,
    (argv, environment) => reach.engine.exec(argv, { environment }),
  );
  return answer.code === 0
    ? { check, passed: true, detail: `${whose} ${image} was pulled` }
    : {
        check,
        passed: false,
        detail: `${whose} ${image} could not be pulled: ${engineFailureLine(answer)}`,
      };
}

/**
 * Whether the host's settings start a supervisor on its engine, as a run
 * checks them, and the memory it is capped at: room for each session it runs
 * at once, with no swap past it.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @param {ChatUser} user
 * @returns {DoctorFinding}
 */
export function chatSettingsFinding(identity, config, user) {
  const check = "chat settings";
  try {
    const settings = chatHostSettings(identity, config, user);
    const mib = (bytes) => String(Math.floor(bytes / 2 ** 20));
    return {
      check,
      passed: true,
      detail: `${config.engine} is asked to cap the supervisor at ${mib(chatHostMemoryBytes(settings))} MiB, ${mib(settings.sessionMemoryBytes)} MiB for each of its ${String(settings.sessionsMax)} sessions at once, with no swap past it`,
    };
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

/**
 * What the host's service at `socket` says, told apart from none being
 * there, which is the only answer read as no service: one that answers what
 * this copy cannot read, or whose door this copy cannot enter, is still
 * there.
 *
 * @param {string} socket
 * @returns {Promise<ChatDoctorService>}
 */
export async function chatServiceAsked(socket) {
  try {
    const status = await chatHostStatusAsked(socket);
    return status === undefined ? { none: true } : { status };
  } catch (failure) {
    return {
      unreadable: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

/**
 * Whether a supervisor's container is left that no service here runs: one of
 * the host's name that is running while no service answers, or while the
 * one that answers runs no supervisor and is starting none, refuses every
 * start of the host's, which never kills it. One whose service answers what
 * this copy cannot read is that service's, and is warned of, never named for
 * removal. One that has exited is removed by the next start.
 *
 * @param {Engine} engine
 * @param {RunnerConfig["engine"]} name
 * @param {ChatHostIdentity} identity
 * @param {ChatDoctorService} service what the host's service said of itself
 * @returns {Promise<DoctorFinding>}
 */
export async function chatSupervisorFinding(engine, name, identity, service) {
  const check = "chat supervisor";
  const container = chatSupervisorName(identity);
  const inspected = await engine.exec(inspectArgv([container]));
  if (inspected.code !== 0)
    return engineFailure(inspected) === "NoSuchContainer"
      ? { check, passed: true, detail: `no container ${container} is here` }
      : { check, passed: false, detail: engineFailureLine(inspected) };
  let running;
  try {
    running = JSON.parse(inspected.stdout)[0]?.State?.Status === "running";
  } catch {
    return {
      check,
      passed: false,
      detail: `${name} container inspect ${container} answered no JSON`,
    };
  }
  if (!running)
    return {
      check,
      passed: true,
      detail: `${container} has exited, and the next start removes it`,
    };
  if ("unreadable" in service)
    return {
      check,
      passed: true,
      warning: true,
      detail: `${container} is running, and the service answers what this copy could not read, so it is taken as that service's: ${service.unreadable}`,
    };
  const status = "status" in service ? service.status : undefined;
  if (
    status !== undefined &&
    (status.starting ||
      (status.supervisor !== "Absent" && status.supervisor !== "Ended"))
  )
    return {
      check,
      passed: true,
      detail: `${container} is the service's supervisor, ${status.supervisor.toLowerCase()}${status.starting ? ", starting" : ""}`,
    };
  return {
    check,
    passed: false,
    detail: `${container} is running and no service here runs it, so every start of this host's supervisor is refused; remove it with ${name} rm -f ${container}, which ends every session it runs`,
  };
}
