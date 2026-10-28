import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  chatHostVolumes,
  chatSupervisorCapabilities,
  chatSupervisorCommand,
  chatSupervisorContainer,
} from "@chuggy/worker-core/chatHost.mjs";
import { poolIdentityDigest } from "@chuggy/worker-core/poolIdentity.mjs";
import { savedLogBytesMax } from "@chuggy/worker-core/savedLog.mjs";

import {
  chatCredentialDirectoryRefusal,
  chatCredentialOwner,
  chatDockerUidRefusal,
  chatHostControl,
  chatHostPlaces,
  chatRunnerLoop,
  chatSessionIdsNeeded,
  chatSessionLogs,
  chatSupervisorName,
  chatSupervisorNaming,
  chatSupervisorRunArgv,
  chatSupervisorStarted,
  chatSupervisorTmpfs,
} from "./chatRunner.mjs";
import { fakeEngine } from "./engine.fixture.mjs";

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

const naming = {
  name: "chuggy-chat-x",
  label: "vteng/member",
  network: "chuggy-jobs",
};

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a session takes uids 20000 to 20031 and a mirror groups to 31023, which a namespace must map", () => {
  assert.deepEqual(chatSessionIdsNeeded, { uids: 20_032, gids: 31_024 });
});

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

test("a host's places are its volumes and the Claude credential in Claude's slot, and docker beside a session's user is refused", () => {
  const user = { uid: 1000, gid: 1000 };
  assert.deepEqual(chatHostPlaces(identity, config, user), {
    volumes: chatHostVolumes(identity),
    credentialFiles: { "claude-code": tokenFile },
    credentialOwner: user,
    claudeCredential: { kind: "Subscription" },
  });
  assert.deepEqual(
    chatHostPlaces(identity, { ...config, engine: "podman" }, user)
      .credentialOwner,
    { uid: 0, gid: 0 },
  );
  assert.throws(
    () => chatHostPlaces(identity, config, { uid: 20_005, gid: 20_005 }),
    /a session would be this user/u,
  );
  assert.equal(
    chatHostPlaces(
      identity,
      { ...config, engine: "podman" },
      {
        uid: 20_005,
        gid: 20_005,
      },
    ).credentialOwner.uid,
    0,
  );
});

test("a credential's directory holding anything else is refused, naming it", async (t) => {
  const directory = await scratch(t);
  const own = join(directory, "claude");
  await mkdir(own);
  const file = join(own, "token");
  await writeFile(file, "x");
  assert.equal(await chatCredentialDirectoryRefusal(file), undefined);
  await writeFile(join(own, "pool.json"), "{}");
  assert.equal(
    await chatCredentialDirectoryRefusal(file),
    `${own} holds pool.json beside the credential ${file}, and the chat supervisor is given the directory whole; move the credential into a directory of its own`,
  );
  assert.match(
    (await chatCredentialDirectoryRefusal(join(directory, "gone", "token"))) ??
      "",
    /gone, which holds the credential .* cannot be read$/u,
  );
});

test("a tmpfs is owned as docker is told, and podman's is root's or refused, copying nothing up", () => {
  const tmpfs = {
    target: "/var/run/chuggy/credentials",
    mode: 0o700,
    uid: 1000,
    gid: 1001,
    sizeBytes: 1_048_576,
    flags: ["nosuid", "nodev", "noexec"],
  };
  assert.equal(
    chatSupervisorTmpfs("docker", tmpfs),
    "/var/run/chuggy/credentials:rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1001",
  );
  assert.equal(
    chatSupervisorTmpfs("podman", { ...tmpfs, uid: 0, gid: 0, mode: 0o711 }),
    "/var/run/chuggy/credentials:rw,nosuid,nodev,noexec,size=1048576,mode=0711,notmpcopyup",
  );
  for (const owner of [
    { uid: 1000, gid: 0 },
    { uid: 0, gid: 1000 },
  ])
    assert.throws(
      () => chatSupervisorTmpfs("podman", { ...tmpfs, ...owner }),
      /podman leaves a tmpfs root's, and \/var\/run\/chuggy\/credentials is to be/u,
    );
});

test("docker runs the supervisor as the core states it, every field in the argv and no variable's value", () => {
  const places = chatHostPlaces(identity, config, { uid: 1000, gid: 1001 });
  const container = chatSupervisorContainer("img:1", places);
  const { argv, environment } = chatSupervisorRunArgv(
    "docker",
    container,
    naming,
  );
  const volumes = chatHostVolumes(identity);
  assert.deepEqual(argv, [
    "run",
    "-i",
    "--rm",
    "--pull=never",
    "--name",
    "chuggy-chat-x",
    "--label",
    "io.chuggy.pool=vteng/member",
    "--log-driver",
    "none",
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    ...chatSupervisorCapabilities.flatMap((capability) => [
      "--cap-add",
      capability,
    ]),
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${volumes.sessions}:/sessions`,
    "--volume",
    `${volumes.mirrors}:/var/lib/chuggy/mirrors`,
    "--tmpfs",
    "/var/run/chuggy:rw,nosuid,nodev,noexec,size=67108864,mode=0711,uid=0,gid=0",
    "--tmpfs",
    "/var/run/chuggy/credentials:rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1001",
    "--mount",
    "type=bind,source=/home/m/.config/chuggy-linux/claude,target=/var/run/chuggy/credentials/claude-code,readonly",
    "--env",
    "CHUG_WORKER_CREDENTIAL_FILES",
    "--env",
    "CHUG_WORKER_CLAUDE_CREDENTIAL",
    "--network",
    "chuggy-jobs",
    "--entrypoint",
    chatSupervisorCommand[0],
    "img:1",
    ...chatSupervisorCommand.slice(1),
  ]);
  assert.deepEqual(chatSupervisorCapabilities, [
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "FSETID",
    "SETUID",
    "SETGID",
    "SETPCAP",
  ]);
  assert.deepEqual(environment, container.environment);
  for (const value of Object.values(environment))
    assert.ok(!argv.some((word) => word.includes(value)), value);
});

test("podman runs the supervisor in this user's own namespace, its tmpfs root's", () => {
  const podman = { ...config, engine: /** @type {const} */ ("podman") };
  const container = chatSupervisorContainer(
    "img:1",
    chatHostPlaces(identity, podman, { uid: 1000, gid: 1000 }),
  );
  const { argv } = chatSupervisorRunArgv("podman", container, naming);
  assert.deepEqual(
    argv.slice(argv.indexOf("--user"), argv.indexOf("--user") + 3),
    ["--user", "0:0", "--userns=host"],
  );
  assert.deepEqual(
    argv.flatMap((word, index) =>
      argv[index - 1] === "--tmpfs" ? [word] : [],
    ),
    [
      "/var/run/chuggy:rw,nosuid,nodev,noexec,size=67108864,mode=0711,notmpcopyup",
      "/var/run/chuggy/credentials:rw,nosuid,nodev,noexec,size=1048576,mode=0700,notmpcopyup",
    ],
  );
  assert.throws(
    () =>
      chatSupervisorRunArgv(
        "podman",
        chatSupervisorContainer(
          "img:1",
          chatHostPlaces(identity, config, { uid: 1000, gid: 1000 }),
        ),
        naming,
      ),
    /podman leaves a tmpfs root's/u,
  );
});

test("a supervisor's input is held open, or it is refused", () => {
  const container = chatSupervisorContainer(
    "img:1",
    chatHostPlaces(identity, config, { uid: 1000, gid: 1000 }),
  );
  assert.throws(
    () =>
      chatSupervisorRunArgv(
        "docker",
        /** @type {any} */ ({ ...container, interactive: false }),
        naming,
      ),
    /input is held open/u,
  );
});

test("a supervisor is named for its host as its volumes are, joining the runner's network", () => {
  assert.equal(
    chatSupervisorName(identity),
    `chuggy-chat-${poolIdentityDigest(identity)}`,
  );
  assert.ok(
    chatHostVolumes(identity).sessions.startsWith(chatSupervisorName(identity)),
  );
  assert.deepEqual(chatSupervisorNaming(identity, config), {
    name: chatSupervisorName(identity),
    label:
      "vteng/28:https:%2F%2Fauth.chuggy.example%2F0f3c9a52-member/chat/host",
    network: "chuggy-jobs",
  });
});

/**
 * A spawn that starts nothing: each child's streams are the suite's, and it
 * exits when told.
 */
function fakeSpawn() {
  /** @type {{command: string, argv: string[], env: Record<string, string>, child: any}[]} */
  const spawned = [];
  const spawn = /** @type {any} */ (
    (/** @type {string} */ command, /** @type {string[]} */ argv, options) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        /** @type {string[]} */
        signals: [],
        kill: (/** @type {string} */ signal) => {
          child.signals.push(signal);
          return true;
        },
      });
      spawned.push({ command, argv, env: options.env, child });
      return child;
    }
  );
  return { spawn, spawned };
}

test("a started supervisor is the engine's run, its exited one removed first, its variables in the run's environment", async () => {
  const { engine, state } = fakeEngine();
  const { spawn, spawned } = fakeSpawn();
  const container = chatSupervisorContainer(
    "img:1",
    chatHostPlaces(identity, config, { uid: 1000, gid: 1000 }),
  );
  const handle = await chatSupervisorStarted(
    "docker",
    engine,
    spawn,
    naming,
  )(container);
  assert.deepEqual(
    state.calls.map((call) => call.argv),
    [["rm", "-v", "chuggy-chat-x"]],
  );
  const [started] = spawned;
  assert.equal(started.command, "docker");
  assert.deepEqual(
    started.argv,
    chatSupervisorRunArgv("docker", container, naming).argv,
  );
  for (const [name, value] of Object.entries(container.environment))
    assert.equal(started.env[name], value);
  assert.equal(handle.input, started.child.stdin);
  assert.equal(handle.output, started.child.stdout);
  assert.equal(handle.errors, started.child.stderr);
  let exited = false;
  void handle.exited.then(() => {
    exited = true;
  });
  await Promise.resolve();
  assert.equal(exited, false);
  started.child.emit("exit", 0, null);
  await handle.exited;
  handle.kill();
  assert.deepEqual(started.child.signals, ["SIGKILL"]);
  assert.deepEqual(state.calls.at(-1)?.argv, ["kill", "chuggy-chat-x"]);
});

test("a supervisor whose run could not start has exited", async () => {
  const { engine } = fakeEngine();
  const { spawn, spawned } = fakeSpawn();
  const handle = await chatSupervisorStarted(
    "podman",
    engine,
    spawn,
    naming,
  )(
    chatSupervisorContainer(
      "img:1",
      chatHostPlaces(
        identity,
        { ...config, engine: "podman" },
        {
          uid: 1000,
          gid: 1000,
        },
      ),
    ),
  );
  assert.equal(spawned[0].command, "podman");
  spawned[0].child.emit("error", new Error("spawn podman ENOENT"));
  await handle.exited;
});

test("each session's log is its own owner-only file beside a job's, opened naming its assignment, every line stamped", async (t) => {
  const directory = join(await scratch(t), "logs");
  /** @type {string[]} */
  const said = [];
  const logFor = chatSessionLogs(directory, identity, {
    log: (line) => said.push(line),
    nowMs: () => Date.UTC(2026, 9, 28, 12),
  });
  logFor("asg-1")("the session started");
  logFor("asg-2")("another");
  logFor("asg-1")("it ended");
  const file = join(
    directory,
    `chuggy-chat-${poolIdentityDigest(identity, "asg-1")}.log`,
  );
  assert.equal(
    await readFile(file, "utf8"),
    [
      "session asg-1",
      "2026-10-28T12:00:00.000Z the session started",
      "2026-10-28T12:00:00.000Z it ended",
      "",
    ].join("\n"),
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(said, []);
  const again = chatSessionLogs(directory, identity, {
    log: (line) => said.push(line),
    nowMs: () => 0,
  });
  again("asg-1")("after a restart");
  assert.match(
    await readFile(file, "utf8"),
    /it ended\n1970-01-01T00:00:00\.000Z after a restart\n$/u,
  );
});

test("a session's log keeps nothing past its bound, and says so once", async (t) => {
  const directory = await scratch(t);
  const file = join(
    directory,
    `chuggy-chat-${poolIdentityDigest(identity, "asg-1")}.log`,
  );
  await writeFile(file, "x".repeat(savedLogBytesMax - 40));
  await chmod(file, 0o600);
  const logFor = chatSessionLogs(directory, identity, {
    log: () => undefined,
    nowMs: () => 0,
  });
  logFor("asg-1")("one line that does not fit");
  logFor("asg-1")("nor this");
  const text = await readFile(file, "utf8");
  assert.ok(
    text.endsWith(
      `[chuggy keeps no more of this log, past ${String(savedLogBytesMax)} bytes]\n`,
    ),
  );
  assert.ok(!text.includes("nor this"));
});

test("a session's log that cannot be written is said so of on the host's log, once", async (t) => {
  const blocked = join(await scratch(t), "file");
  await writeFile(blocked, "");
  /** @type {string[]} */
  const said = [];
  const logFor = chatSessionLogs(join(blocked, "logs"), identity, {
    log: (line) => said.push(line),
    nowMs: () => 0,
  });
  logFor("asg-1")("one");
  logFor("asg-1")("two");
  assert.equal(said.length, 1);
  assert.match(said[0], /could not be written, and keeps nothing more: /u);
});

test("the door answers a chat host's status and refuses every stop", async () => {
  const status = {
    named: "img:1",
    used: "img:1",
    own: undefined,
    supervisor: /** @type {const} */ ("Ready"),
    starting: false,
  };
  const control = chatHostControl(
    /** @type {any} */ ({ status: () => status }),
  );
  assert.deepEqual(control.inFlight(), [status]);
  assert.deepEqual(await control.stop("asg-1"), {
    refused: "a chat host's sessions are stopped in chuggy",
  });
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
