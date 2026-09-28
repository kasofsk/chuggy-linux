import assert from "node:assert/strict";
import test from "node:test";

import { doctorFindings } from "./doctor.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { runnerFixture } from "./runner.fixture.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, token?: unknown}} options
 */
async function doctored(t, options = {}) {
  const { home, environment, poolFile } = await runnerFixture(
    t,
    "runner" in options ? { runner: options.runner } : {},
  );
  const { engine, state } = fakeEngine();
  /** @type {unknown[][]} */
  const polls = [];
  const findings = await doctorFindings({
    poolFile,
    paths: runnerPaths(environment, home),
    uid: process.getuid?.() ?? -1,
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
  return { findings, state, polls, poolFile, home };
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
      ["container engine", true],
      ["job network", true],
      ["pool token", true],
      ["plane", true],
    ],
  );
  assert.equal(findings[0].detail, `${poolFile} names pool vteng/chuggy/shame`);
  assert.equal(
    findings[5].detail,
    "chuggy-jobs is missing, and a run makes it",
  );
  assert.deepEqual(polls, [["pool-token", [], 0]]);
  assert.deepEqual(
    state.calls.map((call) => call.argv[0]),
    ["ps", "network"],
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
