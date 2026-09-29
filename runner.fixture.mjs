/**
 * A machine's worth of files for a suite: a pool registration, the runner's
 * file and a Claude token file, each owner-only, under a home of their own.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixturePool = {
  tenant: "vteng",
  project: "chuggy",
  pool: "shame",
  capabilities: ["container"],
  tokenUrl: "https://issuer.chuggy.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  clientId: "pool-client",
  clientSecret: "pool-client-secret",
};

/**
 * @param {string} file
 * @param {string} text
 */
async function ownerOnly(file, text) {
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, pool?: Record<string, unknown>}} documents
 */
export async function runnerFixture(t, documents = {}) {
  const home = await mkdtemp(join(tmpdir(), "chuggy-linux-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = {
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
  };
  const poolFile = join(home, "pool.json");
  await ownerOnly(poolFile, JSON.stringify(documents.pool ?? fixturePool));
  const tokenFile = join(home, "claude-token");
  await ownerOnly(tokenFile, "claude-token-fixture");
  if (!("runner" in documents) || documents.runner !== undefined) {
    await mkdir(join(environment.XDG_CONFIG_HOME, "chuggy-linux"), {
      recursive: true,
    });
    await ownerOnly(
      join(environment.XDG_CONFIG_HOME, "chuggy-linux", "runner.json"),
      JSON.stringify({
        engine: "podman",
        claudeTokenFile: tokenFile,
        timeoutSecsMax: 3600,
        outputBytesMax: 65536,
        ...documents.runner,
      }),
    );
  }
  return { home, environment, poolFile, tokenFile };
}
