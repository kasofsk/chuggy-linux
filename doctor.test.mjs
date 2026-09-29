import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { doctorFindings, findingLine } from "./doctor.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { runnerFixture } from "./runner.fixture.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, token?: unknown, uid?: number, securityOptions?: string[], podmanVersion?: string, podmanServiceRemote?: string, registries?: Record<string, string>}} options podman's registries.conf and its drop-ins, by path under a directory of their own
 */
async function doctored(t, options = {}) {
  const { home, environment, poolFile } = await runnerFixture(
    t,
    "runner" in options ? { runner: options.runner } : {},
  );
  const { engine, state } = fakeEngine();
  state.securityOptions = options.securityOptions ?? state.securityOptions;
  state.podmanVersion = options.podmanVersion ?? state.podmanVersion;
  state.podmanServiceRemote =
    options.podmanServiceRemote ?? state.podmanServiceRemote;
  const registries = join(home, "registries");
  for (const [file, text] of Object.entries(options.registries ?? {})) {
    await mkdir(dirname(join(registries, file)), { recursive: true });
    await writeFile(join(registries, file), text);
  }
  /** @type {unknown[][]} */
  const polls = [];
  const findings = await doctorFindings({
    poolFile,
    paths: runnerPaths(environment, home),
    registriesConf: [
      join(registries, "registries.conf"),
      join(registries, "registries.conf.d"),
    ],
    uid: options.uid ?? process.getuid?.() ?? -1,
    parts: {
      engine: () => engine,
      tokens: () => ({
        acquire: async () =>
          options.token ?? { acquired: "Token", token: "pool-token" },
        invalidate: () => undefined,
      }),
      plane: () => ({
        poll: async (token, held, wanted) => {
          polls.push([token, held, wanted]);
          return { polled: "Reconciled", assignments: [], stop: [] };
        },
        settle: async () => "Settled",
      }),
    },
  });
  return { findings, state, polls, poolFile, registries };
}

test("a machine ready to run passes every check, and doctor changes nothing", async (t) => {
  const { findings, state, polls, poolFile } = await doctored(t);
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.passed]),
    [
      ["pool file", true],
      ["runner configuration", true],
      ["runtime directory", true],
      ["Claude token file", true],
      ["podman credential helpers", true],
      ["container engine", true],
      ["job network", true],
      ["pool token", true],
      ["plane", true],
    ],
  );
  assert.equal(findings[0].detail, `${poolFile} names pool vteng/chuggy/shame`);
  assert.deepEqual(findings[4], {
    check: "podman credential helpers",
    passed: true,
    detail: "none named in the 0 registries.conf files read",
  });
  assert.equal(
    findings[6].detail,
    "chuggy-jobs is missing, and a run makes it",
  );
  assert.deepEqual(polls, [["pool-token", [], 0]]);
  assert.deepEqual(
    state.calls.map((call) => call.argv[0]),
    ["version", "info", "ps", "network"],
  );
});

test("a check that failed says why, and what depends on it is not checked", async (t) => {
  const { findings } = await doctored(t, {
    runner: undefined,
    token: {
      acquired: "Denied",
      evidence: "the issuer refused the pool's client credential",
    },
  });
  assert.deepEqual(
    findings.map((finding) => [finding.check, finding.passed]),
    [
      ["pool file", true],
      ["runner configuration", false],
      ["runtime directory", true],
      ["pool token", false],
    ],
  );
  assert.match(findings[1].detail, /ENOENT/u);
  assert.equal(
    findings[3].detail,
    "the issuer refused the pool's client credential",
  );
});

test("under docker, doctor names the endpoint its context names, and fails rootless docker", async (t) => {
  /** @param {string[]} securityOptions */
  const engineFinding = async (securityOptions) => {
    const { findings, state } = await doctored(t, {
      runner: { engine: "docker" },
      uid: 1000,
      securityOptions,
    });
    return {
      finding: findings.find((found) => found.check === "container engine"),
      verbs: state.calls.map((call) => call.argv[0]),
    };
  };
  assert.deepEqual(await engineFinding(["name=seccomp,profile=builtin"]), {
    finding: {
      check: "container engine",
      passed: true,
      detail:
        "docker at unix:///var/run/docker.sock lists 0 of this pool's containers",
    },
    verbs: ["info", "context", "ps", "network"],
  });
  const rootless = await engineFinding(["name=rootless", "name=cgroupns"]);
  assert.equal(rootless.finding?.passed, false);
  assert.match(
    rootless.finding?.detail ?? "",
    /^docker is running rootless, .*; use rootful docker without userns-remap, or rootless podman/u,
  );
  assert.deepEqual(rootless.verbs, ["info"]);
});

test("under docker, a runner that is not uid 1000 fails the Claude token file check", async (t) => {
  const { findings } = await doctored(t, {
    runner: { engine: "docker" },
    uid: 1234,
  });
  const finding = findings.find((found) => found.check === "Claude token file");
  assert.equal(finding?.passed, false);
  assert.match(
    finding?.detail ?? "",
    /docker runs a job as uid 1000, and this runner is uid 1234.*use rootless podman/u,
  );
});

test("a credential helper podman's registries.conf sets is warned of, and passes", async (t) => {
  const { findings, registries } = await doctored(t, {
    registries: {
      "registries.conf":
        '# credential-helpers = ["pass"]\nother-credential-helpers = ["pass"]\ncredential-helpers = []\n',
      "registries.conf.d/10-helper.conf":
        'credential-helpers = [\n  "secretservice",\n]\n',
      "registries.conf.d/20-search.conf":
        'unqualified-search-registries = ["docker.io"]\n',
      "registries.conf.d/30-default.conf":
        'credential-helpers = ["containers-auth.json"]\n',
      "registries.conf.d/40-quoted.conf":
        "\"credential-helpers\" = ['containers-auth.json', 'pass']\n",
      "registries.conf.d/50-literal.conf":
        "'credential-helpers' = [\"pass\"]\n",
      "registries.conf.d/60-commented.conf":
        'credential-helpers = [\n  # see [the manual]\n  "pass",\n]\n',
      "registries.conf.d/70-comment-quoted.conf":
        'credential-helpers = [\n  "containers-auth.json", # not "pass"\n]\n',
      "registries.conf.d/80-hash.conf":
        "credential-helpers = [\"pass#work\", 'pass#home']\n",
      "registries.conf.d/helper.txt": 'credential-helpers = ["pass"]\n',
    },
  });
  const finding = findings.find(
    (found) => found.check === "podman credential helpers",
  );
  const warned = [
    "10-helper",
    "40-quoted",
    "50-literal",
    "60-commented",
    "80-hash",
  ].map((name) => join(registries, "registries.conf.d", `${name}.conf`));
  assert.deepEqual(finding, {
    check: "podman credential helpers",
    passed: true,
    warning: true,
    detail: `${warned.join(", ")} name a credential helper, whose logins podman presents on every pull, the pool's token notwithstanding`,
  });
  assert.ok(findings.every((found) => found.passed));
  assert.match(
    findingLine(finding ?? findings[0]),
    /^warn {2}podman credential helpers: /u,
  );
  assert.equal(
    findingLine({ check: "plane", passed: false, detail: "down" }),
    "FAIL  plane: down",
  );
  assert.equal(
    findingLine({ check: "plane", passed: true, detail: "up" }),
    "ok    plane: up",
  );
});

test("docker has no podman credential helpers to check", async (t) => {
  const { findings } = await doctored(t, {
    runner: { engine: "docker" },
    uid: 1000,
    registries: { "registries.conf": 'credential-helpers = ["pass"]\n' },
  });
  assert.ok(
    !findings.some((found) => found.check === "podman credential helpers"),
  );
});

test("a podman that reads this machine's stored logins fails the engine check", async (t) => {
  const { findings, state } = await doctored(t, { podmanVersion: "4.3.1" });
  assert.deepEqual(
    findings.find((found) => found.check === "container engine"),
    {
      check: "container engine",
      passed: false,
      detail:
        "podman 4.3.1 reads this machine's stored logins even when told not to; podman 4.4 or later is required",
    },
  );
  assert.ok(!findings.some((found) => found.check === "job network"));
  assert.ok(state.calls.every((call) => call.argv[0] === "version"));
});

test("the registries.conf files read are counted, and podman's own default helper is none", async (t) => {
  for (const [registries, detail] of [
    [
      { "registries.conf": 'credential-helpers = ["containers-auth.json"]\n' },
      "none named in the 1 registries.conf file read",
    ],
    [
      {
        "registries.conf": 'credential-helpers = ["containers-auth.json"]\n',
        "registries.conf.d/10-search.conf":
          'unqualified-search-registries = ["docker.io"]\n',
      },
      "none named in the 2 registries.conf files read",
    ],
  ]) {
    const { findings } = await doctored(t, { registries });
    assert.deepEqual(
      findings.find((found) => found.check === "podman credential helpers"),
      { check: "podman credential helpers", passed: true, detail },
    );
  }
});

test("a remote podman client fails the engine check", async (t) => {
  const { findings } = await doctored(t, { podmanServiceRemote: "true" });
  const finding = findings.find((found) => found.check === "container engine");
  assert.equal(finding?.passed, false);
  assert.match(finding?.detail ?? "", /^podman is a remote client here /u);
});
