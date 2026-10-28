import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
  chatHostMemoryBytes,
  chatHostSessionsMaxDefault,
  chatSessionMemoryBytesDefault,
  chatSupervisorName,
} from "@chuggy/worker-core/chatHost.mjs";

import {
  chatCredentialDirectoryFinding,
  chatImageFinding,
  chatPodmanIdsRefusal,
  chatServiceAsked,
  chatSessionUsersFinding,
  chatSettingsFinding,
  chatSupervisorFinding,
  idMapContiguous,
} from "./chatDoctor.mjs";
import { doctorFindings, podmanMemoryCapFinding } from "./doctor.mjs";
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
    "podman's namespace for this user maps 20031 uids where its sessions need 20032; give this user a range in /etc/subuid and /etc/subgid at least that large, then run podman system migrate",
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

test("the settings say the supervisor's memory cap, and a docker user a session would be fails them", () => {
  const config = /** @type {any} */ ({
    engine: "docker",
    claudeTokenFile: "/home/m/claude/token",
    network: "chuggy-jobs",
    outputBytesMax: 65536,
  });
  const mib = (bytes) => String(bytes / 2 ** 20);
  const cap = chatHostMemoryBytes({
    sessionsMax: chatHostSessionsMaxDefault,
    sessionMemoryBytes: chatSessionMemoryBytesDefault,
  });
  assert.deepEqual(
    chatSettingsFinding(chatHostPool, config, { uid: 1000, gid: 1000 }),
    {
      check: "chat settings",
      passed: true,
      detail: `docker is asked to cap the supervisor at ${mib(cap)} MiB, ${mib(chatSessionMemoryBytesDefault)} MiB for each of its ${String(chatHostSessionsMaxDefault)} sessions at once, with no swap past it`,
    },
  );
  const inside = chatSettingsFinding(chatHostPool, config, {
    uid: 20_001,
    gid: 20_001,
  });
  assert.equal(inside.passed, false);
  assert.match(inside.detail, /so a session would be this user/u);
});

test("a supervisor's container no service here runs fails, naming its removal; the service's own, an exited one, or none passes", async () => {
  const { engine, state } = fakeEngine();
  const name = chatSupervisorName(chatHostPool);
  const none = /** @type {const} */ ({ none: true });
  /** @param {import("./chatDoctor.mjs").ChatDoctorService} service */
  const said = (service) => async () => service;
  assert.deepEqual(
    await chatSupervisorFinding(engine, "docker", chatHostPool, said(none)),
    {
      check: "chat supervisor",
      passed: true,
      detail: `no container ${name} is here`,
    },
  );
  state.containers.set(name, {
    id: "c1",
    name,
    labels: {},
    status: "running",
    image: sessionImage,
  });
  const status = {
    supervisor: /** @type {const} */ ("Ready"),
    starting: false,
  };
  assert.deepEqual(
    await chatSupervisorFinding(
      engine,
      "docker",
      chatHostPool,
      said({ status }),
    ),
    {
      check: "chat supervisor",
      passed: true,
      detail: `${name} is the service's supervisor, ready`,
    },
  );
  assert.deepEqual(
    await chatSupervisorFinding(
      engine,
      "docker",
      chatHostPool,
      said({ status: { supervisor: "Absent", starting: true } }),
    ),
    {
      check: "chat supervisor",
      passed: true,
      detail: `${name} is the service's supervisor, absent, starting`,
    },
  );
  for (const service of [
    none,
    { status: { ...status, supervisor: "Ended" } },
  ]) {
    const left = await chatSupervisorFinding(
      engine,
      "podman",
      chatHostPool,
      said(/** @type {any} */ (service)),
    );
    assert.equal(left.passed, false);
    assert.equal(
      left.detail,
      `${name} is running and no service here runs it, so every start of this host's supervisor is refused; remove it with podman rm -f ${name}, which ends every session it runs`,
    );
  }
});

test("the supervisor's container is inspected before the service is asked, and the service is not asked of one that is not running", async () => {
  const { engine, state } = fakeEngine();
  const name = chatSupervisorName(chatHostPool);
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof engine} */
  const seen = {
    ...engine,
    exec: async (argv, engineCall) => {
      calls.push(argv.slice(0, 2).join(" "));
      return engine.exec(argv, engineCall);
    },
  };
  const asked = async () => {
    calls.push("service");
    return /** @type {const} */ ({
      status: { supervisor: "Starting", starting: true },
    });
  };
  await chatSupervisorFinding(seen, "docker", chatHostPool, asked);
  assert.deepEqual(calls, ["container inspect"]);
  /** @param {string} status */
  const contained = (status) => {
    state.containers.set(name, {
      id: "c1",
      name,
      labels: {},
      status,
      image: sessionImage,
    });
    calls.length = 0;
    return chatSupervisorFinding(seen, "docker", chatHostPool, asked);
  };
  assert.equal(
    (await contained("exited")).detail,
    `${name} has exited, and the next start removes it`,
  );
  assert.deepEqual(calls, ["container inspect"]);
  assert.equal((await contained("running")).passed, true);
  assert.deepEqual(calls, ["container inspect", "service"]);
});

test("a service that answers what this copy cannot read is there: its running supervisor is warned of as its own, and never named for removal", async (t) => {
  const directory = await scratch(t);
  const socket = join(directory, "control.sock");
  const server = createServer((connection) => {
    connection.once("data", () => {
      connection.end('{"refused":"not a request this service answers"}\n');
    });
  });
  await new Promise((resolve) => {
    server.listen(socket, () => resolve(undefined));
  });
  t.after(() => server.close());
  const service = await chatServiceAsked(socket);
  assert.ok("unreadable" in service, JSON.stringify(service));
  assert.deepEqual(await chatServiceAsked(join(directory, "gone.sock")), {
    none: true,
  });
  const { engine, state } = fakeEngine();
  const name = chatSupervisorName(chatHostPool);
  state.containers.set(name, {
    id: "c1",
    name,
    labels: {},
    status: "running",
    image: sessionImage,
  });
  const found = await chatSupervisorFinding(
    engine,
    "docker",
    chatHostPool,
    async () => service,
  );
  assert.equal(found.passed, true);
  assert.equal(found.warning, true);
  assert.match(
    found.detail,
    new RegExp(
      `^${name} is running, and the service answers what this copy could not read, so it is taken as that service's: `,
      "u",
    ),
  );
  assert.ok(!found.detail.includes("rm -f"), found.detail);
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
 * A fake engine whose info says of its cgroups what `cgroups` does, over the
 * fixture's own.
 *
 * @param {Record<string, unknown>} [cgroups]
 */
function cgroupedEngine(cgroups) {
  const faked = fakeEngine();
  if (cgroups !== undefined)
    faked.state.info = {
      ...faked.state.info,
      host: { .../** @type {any} */ (faked.state.info).host, ...cgroups },
    };
  return faked;
}

/**
 * doctor's findings for a chat host's file, under a home of its own whose
 * Claude token is alone in its directory.
 *
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown>, uid?: number, chatImage?: string, tokenBeside?: boolean, cgroups?: Record<string, unknown>}} options
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
  const { engine, state } = cgroupedEngine(options.cgroups);
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
    gid: process.getgid?.() ?? -1,
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
      ["chat settings", true],
      ["podman credential helpers", true],
      ["service unit", true],
      ["updates", true],
      ["container engine", true],
      ["job network", true],
      ["chat session users", true],
      ["chat supervisor", true],
      ["memory caps", true],
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
    `${paths.config}: sessionsMax 4, sessionMemoryMib 2048, the supervisor's cap asked of the engine 8192 MiB, idleSecs 600, outputBytesMax 65536, running the image chuggy names`,
  );
  assert.match(
    findings[3].detail,
    new RegExp(`from the .* ${tokenFile}, this runner's own$`, "u"),
  );
  assert.equal(
    findings[9].detail,
    "podman lists 0 of this chat host's containers",
  );
  assert.equal(findings[16].detail, `the plane's ${sessionImage} was pulled`);
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

test("podman that would run a supervisor or a job past its memory cap is warned of, never refused, naming the drop-in that delegates the memory controller", async (t) => {
  const passed = await doctoredChat(t, { chatImage: sessionImage });
  assert.deepEqual(
    passed.findings.find((finding) => finding.check === "memory caps"),
    {
      check: "memory caps",
      passed: true,
      detail:
        "podman holds a job and a chat supervisor to the memory each is run with: cgroups v2, rootless through systemd, the memory controller delegated",
    },
  );
  const { findings } = await doctoredChat(t, {
    chatImage: sessionImage,
    uid: 1000,
    cgroups: {
      cgroupManager: "cgroupfs",
      cgroupVersion: "v2",
      cgroupControllers: ["cpu", "pids"],
    },
  });
  assert.deepEqual(
    findings.find((finding) => finding.check === "memory caps"),
    {
      check: "memory caps",
      passed: true,
      warning: true,
      detail:
        'podman does not hold a job or a chat supervisor to the memory it is run with, and runs each uncapped, warning only on its stderr: rootless podman sets no limit where its cgroup manager is cgroupfs and the memory controller is not delegated to this user; set cgroup_manager = "systemd" under [engine] in containers.conf, and write /etc/systemd/system/user@.service.d/delegate.conf holding "[Service]" and "Delegate=cpu cpuset io memory pids", then run systemctl daemon-reload and systemctl restart user@1000.service, or reboot, since register keeps this user\'s session running and logging in again does not restart it',
    },
  );
  const docker = await doctoredChat(t, {
    chatImage: sessionImage,
    runner: { engine: "docker" },
    uid: 1000,
  });
  assert.ok(
    !docker.findings.some((finding) => finding.check === "memory caps"),
  );
});

test("rootful podman needs only the memory controller, which a kernel booted without it is told to enable; rootless podman on cgroups v1 is told to boot the unified hierarchy", async () => {
  /** @param {Record<string, unknown>} cgroups */
  const found = (cgroups) =>
    podmanMemoryCapFinding(cgroupedEngine(cgroups).engine, 1000);
  assert.deepEqual(
    await found({
      cgroupManager: "cgroupfs",
      cgroupVersion: "v1",
      cgroupControllers: ["cpu", "memory", "pids"],
      security: { rootless: false },
    }),
    {
      check: "memory caps",
      passed: true,
      detail:
        "podman holds a job and a chat supervisor to the memory each is run with: cgroups v1, the memory controller enabled",
    },
  );
  const v1 = await found({
    cgroupManager: "cgroupfs",
    cgroupVersion: "v1",
    cgroupControllers: ["cpu", "memory", "pids"],
  });
  assert.deepEqual(v1, {
    check: "memory caps",
    passed: true,
    warning: true,
    detail:
      "podman does not hold a job or a chat supervisor to the memory it is run with, and runs each uncapped, warning only on its stderr: rootless podman sets no limit on cgroups v1; boot the unified hierarchy, with systemd.unified_cgroup_hierarchy=1 on the kernel command line",
  });
  const kernel = await found({
    cgroupManager: "systemd",
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "pids"],
    security: { rootless: false },
  });
  assert.deepEqual(kernel, {
    check: "memory caps",
    passed: true,
    warning: true,
    detail:
      "podman does not hold a job or a chat supervisor to the memory it is run with, and runs each uncapped, warning only on its stderr: the kernel runs without the memory controller; enable it, with cgroup_enable=memory on the kernel command line, and reboot",
  });
  for (const finding of [v1, kernel])
    assert.ok(!finding.detail.includes("delegate.conf"), finding.detail);
});

test("podman whose info fails or cannot be read is warned of as unchecked, never refused", async () => {
  const failing = fakeEngine();
  failing.state.info = undefined;
  const failed = await podmanMemoryCapFinding(failing.engine, 1000);
  assert.equal(failed.passed, true);
  assert.equal(failed.warning, true);
  assert.match(
    failed.detail,
    /^whether podman holds a job and a chat supervisor to the memory each is run with could not be checked: podman info failed: .*Cannot connect/u,
  );
  const { engine } = fakeEngine();
  for (const stdout of ["not json\n", '{"host":{}}\n']) {
    /** @type {typeof engine} */
    const garbled = {
      ...engine,
      exec: async (argv, engineCall) => ({
        ...(await engine.exec(argv, engineCall)),
        stdout,
      }),
    };
    assert.deepEqual(await podmanMemoryCapFinding(garbled, 1000), {
      check: "memory caps",
      passed: true,
      warning: true,
      detail:
        "whether podman holds a job and a chat supervisor to the memory each is run with could not be checked: podman's info says nothing this runner reads of its cgroups",
    });
  }
});
