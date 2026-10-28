import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chatCredentialDirectoryFinding,
  chatImageFinding,
  chatPodmanIdsRefusal,
  chatSessionUsersFinding,
  idMapContiguous,
} from "./chatDoctor.mjs";
import { doctorFindings } from "./doctor.mjs";
import { fakeDisk, fakeEngine } from "./engine.fixture.mjs";
import { runnerUpdates } from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";

/** A member's chat host's file, as chuggy answers its redemption. */
const chatHostPool = {
  kind: "ChatHost",
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/0f3c9a52-member",
  tokenUrl: "https://issuer.chuggy.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  registryHost: "registry.chuggy.example",
  clientId: "chat-client",
  clientSecret: "chat-client-secret",
};

const sessionImage = "registry.chuggy.example/chuggy/worker:1";

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * @param {string} file
 * @param {string} text
 */
async function ownerOnly(file, text) {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}

test("an id map is read for the ids it maps from 0 without a gap, in any order", () => {
  assert.equal(idMapContiguous("0 1000 1\n1 100000 65536\n"), 65_537);
  assert.equal(idMapContiguous("1 100000 65536\n0 1000 1\n"), 65_537);
  assert.equal(idMapContiguous("0 1000 1\n2 100000 65536\n"), 1);
  assert.equal(idMapContiguous("0 0 4294967295\n"), 4_294_967_295);
  assert.equal(idMapContiguous(""), 0);
  assert.equal(idMapContiguous("not a map\n"), 0);
});

test("podman's namespace must map every session's uid and every mirror's group", () => {
  assert.equal(chatPodmanIdsRefusal({ uids: 20_032, gids: 31_024 }), undefined);
  assert.equal(
    chatPodmanIdsRefusal({ uids: 20_031, gids: 31_024 }),
    "podman's namespace for this user maps 20031 uids where its sessions need 20032; give this user a larger range in /etc/subuid and /etc/subgid, such as 100000:65536, then run podman system migrate",
  );
  assert.match(
    chatPodmanIdsRefusal({ uids: 1, gids: 31_023 }) ?? "",
    /maps 1 uids where its sessions need 20032, and 31023 gids where its sessions and mirrors need 31024;/u,
  );
});

test("a session's users are checked as the engine runs them", async () => {
  const { engine, state } = fakeEngine();
  assert.deepEqual(await chatSessionUsersFinding(engine, "docker", 1000), {
    check: "chat session users",
    passed: true,
    detail:
      "docker runs each session as this machine's uids 20000 to 20031, none of them this user's uid 1000",
  });
  const inside = await chatSessionUsersFinding(engine, "docker", 20_031);
  assert.equal(inside.passed, false);
  assert.match(inside.detail, /this user is uid 20031/u);
  assert.deepEqual(await chatSessionUsersFinding(engine, "podman", 0), {
    check: "chat session users",
    passed: true,
    detail:
      "rootful podman runs each session as this machine's uids 20000 to 20031",
  });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await chatSessionUsersFinding(engine, "podman", 1000), {
    check: "chat session users",
    passed: true,
    detail:
      "podman maps 65537 uids and 65537 gids for this user, root among them being this user, so each session's uids 20000 to 20031 is one of this user's subordinate ids",
  });
  assert.deepEqual(
    state.calls.map((call) => call.argv),
    [
      ["unshare", "cat", "/proc/self/uid_map"],
      ["unshare", "cat", "/proc/self/gid_map"],
    ],
  );
  state.idMaps["/proc/self/gid_map"] = "0 1000 1\n1 100000 30000\n";
  const short = await chatSessionUsersFinding(engine, "podman", 1000);
  assert.equal(short.passed, false);
  assert.match(
    short.detail,
    /maps 30001 gids where its sessions and mirrors need 31024/u,
  );
  delete state.idMaps["/proc/self/uid_map"];
  const unread = await chatSessionUsersFinding(engine, "podman", 1000);
  assert.equal(unread.passed, false);
  assert.match(unread.detail, /^podman unshare cat \/proc\/self\/uid_map: /u);
});

test("the credential's directory must hold nothing else", async (t) => {
  const directory = await scratch(t);
  await mkdir(join(directory, "claude"));
  const tokenFile = join(directory, "claude", "token");
  await ownerOnly(tokenFile, "t");
  const config = /** @type {any} */ ({ claudeTokenFile: tokenFile });
  assert.deepEqual(await chatCredentialDirectoryFinding(config), {
    check: "chat credential directory",
    passed: true,
    detail: `${tokenFile} is alone in its directory, which the chat supervisor is given read-only`,
  });
  await writeFile(join(directory, "claude", "other"), "");
  const shared = await chatCredentialDirectoryFinding(config);
  assert.equal(shared.passed, false);
  assert.match(shared.detail, /holds other beside the credential/u);
});

/**
 * What the image check reaches: a fake engine, the pool's token, and where
 * a pull's credential is written.
 *
 * @param {import("node:test").TestContext} t
 * @param {"docker" | "podman"} name
 */
async function imageReach(t, name = "podman") {
  const { engine, state } = fakeEngine();
  /** @type {string[]} */
  const acquired = [];
  return {
    state,
    acquired,
    reach: {
      engine,
      site: {
        engine: name,
        runtimeDir: await scratch(t),
        dockerHost: undefined,
      },
      credentials: /** @type {any} */ (chatHostPool),
      tokens: {
        acquire: async () => {
          acquired.push("pool-token");
          return /** @type {const} */ ({
            acquired: "Token",
            token: "pool-token",
          });
        },
        invalidate: () => undefined,
      },
    },
  };
}

test("the plane's image here passes, and one not here is pulled under the pool's token from the pool's registry", async (t) => {
  const { reach, state, acquired } = await imageReach(t);
  assert.deepEqual(await chatImageFinding(reach, undefined, sessionImage), {
    check: "chat image",
    passed: true,
    detail: `the plane's ${sessionImage} was pulled`,
  });
  assert.deepEqual(acquired, ["pool-token"]);
  const pull = state.calls.find((call) => call.argv[0] === "pull");
  assert.ok(pull?.authFile?.includes("registry.chuggy.example"));
  assert.ok(!pull?.argv.some((word) => word.includes("pool-token")));
  assert.deepEqual(await chatImageFinding(reach, undefined, sessionImage), {
    check: "chat image",
    passed: true,
    detail: `the plane's ${sessionImage} is here`,
  });
});

test("the host's own image is pulled as the engine's login pulls it, and pull never only looks", async (t) => {
  const { reach, state, acquired } = await imageReach(t);
  const own = "registry.chuggy.example/me/chat:2";
  const never = await chatImageFinding(
    reach,
    { image: { image: own, pull: "never" } },
    sessionImage,
  );
  assert.deepEqual(never, {
    check: "chat image",
    passed: false,
    detail: `the host's own ${own} is not here, and chat.image.pull is never`,
  });
  assert.ok(!state.calls.some((call) => call.argv[0] === "pull"));
  const pulled = await chatImageFinding(
    reach,
    { image: { image: own, pull: "missing" } },
    undefined,
  );
  assert.equal(pulled.detail, `the host's own ${own} was pulled`);
  assert.deepEqual(acquired, []);
  assert.equal(
    state.calls.find((call) => call.argv[0] === "pull")?.authFile,
    undefined,
  );
  assert.equal(
    (
      await chatImageFinding(
        reach,
        { image: { image: own, pull: "always" } },
        undefined,
      )
    ).detail,
    `the host's own ${own} is here, and is pulled again before each start`,
  );
});

test("an image that cannot be pulled, or none named, fails", async (t) => {
  const { reach, state } = await imageReach(t);
  state.pull = () => ({
    code: 1,
    stdout: "",
    stderr: "Error: manifest unknown\n",
  });
  const failed = await chatImageFinding(reach, undefined, "docker.io/x/y:1");
  assert.equal(failed.passed, false);
  assert.match(
    failed.detail,
    /^the plane's docker\.io\/x\/y:1 could not be pulled: /u,
  );
  assert.deepEqual(await chatImageFinding(reach, undefined, undefined), {
    check: "chat image",
    passed: false,
    detail:
      "the plane named no session image and the runner's file sets no chat.image, so no supervisor can start",
  });
});

/**
 * doctor's findings for a chat host's file, under a home of its own whose
 * Claude token is alone in its directory.
 *
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown>, uid?: number, chatImage?: string, tokenBeside?: boolean}} options
 */
async function doctoredChat(t, options = {}) {
  const home = await scratch(t);
  const environment = {
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
  };
  const paths = runnerPaths(environment, home);
  await mkdir(join(home, "claude"));
  const tokenFile = join(home, "claude", "token");
  await ownerOnly(tokenFile, "sk-ant-oat01-fixture");
  if (options.tokenBeside === true)
    await ownerOnly(join(home, "claude", "notes"), "");
  await mkdir(join(environment.XDG_CONFIG_HOME, "chuggy-linux"), {
    recursive: true,
  });
  await ownerOnly(
    paths.config,
    JSON.stringify({
      engine: "podman",
      claudeTokenFile: tokenFile,
      timeoutSecsMax: 3600,
      outputBytesMax: 65536,
      ...options.runner,
    }),
  );
  const poolFile = join(home, "chat.json");
  await ownerOnly(poolFile, JSON.stringify(chatHostPool));
  const { engine, state } = fakeEngine();
  const runner = {
    package: "chuggy-linux",
    version: "9.8.7",
    cli: join(home, "npm", "lib", "node_modules", "chuggy-linux", "cli.mjs"),
  };
  const findings = await doctorFindings({
    poolFile,
    paths,
    node: "/opt/node/bin/node",
    cli: runner.cli,
    arch: "x64",
    registriesConf: [],
    uid: options.uid ?? process.getuid?.() ?? -1,
    path: undefined,
    servicePath: async () => undefined,
    agentVersion: async () => undefined,
    disk: fakeDisk(100),
    parts: {
      engine: () => engine,
      updates: (config) => runnerUpdates({ config, paths }, runner),
      tokens: () => ({
        acquire: async () => ({ acquired: "Token", token: "pool-token" }),
        invalidate: () => undefined,
      }),
      plane: () => ({
        poll: async () => ({
          polled: "Reconciled",
          assignments: [],
          stop: [],
          ...(options.chatImage === undefined
            ? {}
            : { chatImage: options.chatImage }),
        }),
        settle: async () => "Settled",
      }),
    },
  });
  return { findings, state, poolFile, paths, tokenFile };
}

test("doctor checks a chat host's file for what its run needs, and nothing a pool's jobs do", async (t) => {
  const { findings, poolFile, paths, tokenFile } = await doctoredChat(t, {
    chatImage: sessionImage,
  });
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.passed]),
    [
      ["pool file", true],
      ["runner configuration", true],
      ["runtime directory", true],
      ["Claude credential", true],
      ["chat credential directory", true],
      ["podman credential helpers", true],
      ["service unit", true],
      ["updates", true],
      ["container engine", true],
      ["job network", true],
      ["chat session users", true],
      ["pool token", true],
      ["plane", true],
      ["chat image", true],
    ],
  );
  assert.equal(
    findings[0].detail,
    `${poolFile} names chat host vteng/28:https:%2F%2Fauth.chuggy.example%2F0f3c9a52-member/chat/host`,
  );
  assert.equal(
    findings[1].detail,
    `${paths.config}: sessionsMax 32, idleSecs 600, outputBytesMax 65536, running the image chuggy names`,
  );
  assert.match(
    findings[3].detail,
    new RegExp(`from the .* ${tokenFile}, this runner's own$`, "u"),
  );
  assert.equal(
    findings[8].detail,
    "podman lists 0 of this chat host's containers",
  );
  assert.equal(findings[13].detail, `the plane's ${sessionImage} was pulled`);
});

test("a chat host on docker is held to no session's uid rather than a job's, its credential's directory to hold it alone, and a plane naming no image fails it", async (t) => {
  const { findings } = await doctoredChat(t, {
    runner: { engine: "docker" },
    uid: process.getuid?.() ?? 1234,
    tokenBeside: true,
  });
  const found = Object.fromEntries(
    findings.map((finding) => [finding.check, finding]),
  );
  assert.equal(found["Claude credential"]?.passed, true);
  assert.equal(found["chat credential directory"]?.passed, false);
  assert.equal(found["chat session users"]?.passed, true);
  assert.equal(found["plane"]?.passed, true);
  assert.equal(found["chat image"]?.passed, false);
  assert.match(
    found["chat image"]?.detail ?? "",
    /^the plane named no session image/u,
  );
});

test("a chat host's own image is checked whatever the plane names", async (t) => {
  const { findings } = await doctoredChat(t, {
    runner: { chat: { image: { image: "localhost/mine:1", pull: "never" } } },
  });
  assert.deepEqual(findings.at(-1), {
    check: "chat image",
    passed: false,
    detail:
      "the host's own localhost/mine:1 is not here, and chat.image.pull is never",
  });
});
