import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chatHostMemoryBytes,
  chatHostSessionsMaxDefault,
  chatHostVolumes,
  chatSessionMemoryBytesDefault,
  chatSupervisorContainer,
  chatSupervisorNaming,
} from "@chuggy/worker-core/chatHost.mjs";
import { chatSupervisorRunArgv } from "@chuggy/worker-core/engineArgv.mjs";

import {
  chatCredentialOwner,
  chatCredentialRefusal,
  chatDockerUidRefusal,
  chatHostPlaces,
  chatHostSettings,
  chatRunnerLoop,
} from "./chatRunner.mjs";

/** A member's chat host, as its file names it. */
const identity = /** @type {const} */ ({
  kind: "ChatHost",
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/0f3c9a52-member",
});

const tokenFile = "/home/m/.config/chuggy-linux/claude/token";

/** The fields of a runner's file the chat host reads. */
const config = /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
  /** @type {unknown} */ ({
    engine: "docker",
    claudeTokenFile: tokenFile,
    network: "chuggy-jobs",
    outputBytesMax: 65536,
  })
);

const podman = { ...config, engine: /** @type {const} */ ("podman") };

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("docker refuses a user whose uid a session takes, and no other", () => {
  for (const uid of [0, 1000, 19_999, 20_032])
    assert.equal(chatDockerUidRefusal(uid), undefined);
  for (const uid of [20_000, 20_031])
    assert.match(
      chatDockerUidRefusal(uid) ?? "",
      new RegExp(
        `uid 20000 to 20031, and this user is uid ${String(uid)}, so a session would be this user`,
        "u",
      ),
    );
});

test("the credential is owned by this user as docker shows it, and by root as podman does", () => {
  const user = { uid: 1000, gid: 1001 };
  assert.deepEqual(chatCredentialOwner("docker", user), user);
  assert.deepEqual(chatCredentialOwner("podman", user), { uid: 0, gid: 0 });
});

test("a host's places are its volumes and the Claude credential, and docker beside a session's user is refused", () => {
  const user = { uid: 1000, gid: 1000 };
  assert.deepEqual(chatHostPlaces(identity, config, user), {
    volumes: chatHostVolumes(identity),
    credentialFile: tokenFile,
    credentialOwner: user,
    claudeCredential: { kind: "Subscription" },
  });
  assert.deepEqual(chatHostPlaces(identity, podman, user).credentialOwner, {
    uid: 0,
    gid: 0,
  });
  assert.throws(
    () => chatHostPlaces(identity, config, { uid: 20_005, gid: 20_005 }),
    /a session would be this user/u,
  );
  assert.equal(
    chatHostPlaces(identity, podman, { uid: 20_005, gid: 20_005 })
      .credentialOwner.uid,
    0,
  );
});

test("a host's settings are the core's defaults where the file names none, its own where it does", () => {
  const user = { uid: 1000, gid: 1000 };
  const settings = chatHostSettings(identity, config, user);
  assert.equal(settings.sessionsMax, chatHostSessionsMaxDefault);
  assert.equal(settings.sessionMemoryBytes, chatSessionMemoryBytesDefault);
  assert.equal(settings.outputBytesMax, config.outputBytesMax);
  assert.deepEqual(settings.places, chatHostPlaces(identity, config, user));
  const own = chatHostSettings(
    identity,
    {
      ...config,
      chat: {
        sessionsMax: 3,
        sessionMemoryMib: 1024,
        image: { image: "img:1", pull: "never" },
      },
    },
    user,
  );
  assert.equal(chatHostMemoryBytes(own), 3 * 1024 * 2 ** 20);
  assert.deepEqual(own.image, { image: "img:1", pull: "never" });
});

test("each engine is handed the credential as its owner shows inside: docker's tmpfs this user's, podman's root's in this user's own namespace", () => {
  const user = { uid: 1000, gid: 1001 };
  const naming = chatSupervisorNaming(identity, config.network);
  /** @param {typeof config} file */
  const argv = (file) => {
    const settings = chatHostSettings(identity, file, user);
    return chatSupervisorRunArgv(
      file.engine,
      chatSupervisorContainer(
        "img:1",
        settings.places,
        chatHostMemoryBytes(settings),
      ),
      naming,
    ).argv;
  };
  const docker = argv(config);
  assert.ok(
    docker.some(
      (word) =>
        word.startsWith("/var/run/chuggy/credentials:") &&
        word.endsWith(",uid=1000,gid=1001"),
    ),
    docker.join(" "),
  );
  assert.ok(!docker.includes("--userns=host"));
  const rootless = argv(podman);
  assert.ok(rootless.includes("--userns=host"));
  assert.ok(
    rootless.some(
      (word) =>
        word.startsWith("/var/run/chuggy/credentials:") &&
        word.endsWith(",notmpcopyup"),
    ),
    rootless.join(" "),
  );
  assert.ok(rootless.includes("chuggy-jobs"));
});

test("a credential not this user's alone, or not alone in its directory, is refused", async (t) => {
  const directory = await scratch(t);
  const own = join(directory, "claude");
  await mkdir(own);
  const file = join(own, "token");
  await writeFile(file, "x", { mode: 0o600 });
  await chmod(file, 0o600);
  const uid = process.getuid?.() ?? -1;
  const at = { ...config, claudeTokenFile: file };
  assert.equal(await chatCredentialRefusal(at, uid), undefined);
  await chmod(file, 0o640);
  assert.match(
    (await chatCredentialRefusal(at, uid)) ?? "",
    /is mode 640; only its owner may read or write it/u,
  );
  await chmod(file, 0o600);
  await writeFile(join(own, "pool.json"), "{}");
  assert.match(
    (await chatCredentialRefusal(at, uid)) ?? "",
    /holds pool\.json beside the credential .*, and a chat host's supervisor is handed the directory whole/u,
  );
});

test("a denied host exits for the unit not to restart it, and an updated one for it to", async () => {
  /** @type {string[]} */
  const said = [];
  const seams = {
    log: (/** @type {string} */ line) => said.push(line),
    underService: true,
    package: "chuggy-linux",
  };
  /** @param {object} pass */
  const host = (pass) =>
    /** @type {any} */ ({ run: async () => pass, status: () => undefined });
  assert.equal(
    await chatRunnerLoop(
      host({ passed: "Denied", evidence: "revoked" }),
      seams,
    ),
    3,
  );
  assert.equal(
    await chatRunnerLoop(host({ passed: "Updated", version: "0.36.0" }), seams),
    75,
  );
  assert.deepEqual(said, [
    "ending, for the service to restart on chuggy-linux 0.36.0",
  ]);
  await chatRunnerLoop(host({ passed: "Updated", version: "0.36.0" }), {
    ...seams,
    underService: false,
  });
  assert.equal(
    said[1],
    "ending: start this run again to run chuggy-linux 0.36.0",
  );
});
