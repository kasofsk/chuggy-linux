/**
 * Docker's own CLI pointed at a daemon that only records what a pull sends
 * it, on a PATH whose credential helpers record being asked and answer with
 * a login of the machine's. A pull there shows which credential docker would
 * present, and nothing is pulled.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { containerEngine } from "./engine.mjs";

/** The login the machine's credential helpers hand docker. */
export const machineLogin = { Username: "operator", Secret: "operator-secret" };

/** The same login as `DOCKER_AUTH_CONFIG` would hand it, for any registry. */
export const machineAuthConfig = JSON.stringify({
  auths: Object.fromEntries(
    ["registry.chuggy.example", "ghcr.io", "https://index.docker.io/v1/"].map(
      (host) => [
        host,
        {
          auth: Buffer.from(
            `${machineLogin.Username}:${machineLogin.Secret}`,
          ).toString("base64"),
        },
      ],
    ),
  ),
});

/** Docker's CLI, or nothing where it is not installed. */
export async function dockerCli() {
  const docker = containerEngine("docker", 30_000);
  const version = await docker.exec(["--version"]);
  return version.code === 0 && version.stdout.startsWith("Docker version")
    ? docker
    : undefined;
}

/**
 * @param {string} directory
 * @param {string} asked
 */
async function credentialHelpers(directory, asked) {
  const helpers = join(directory, "helpers");
  const pass = join(directory, "pass");
  await mkdir(helpers);
  await mkdir(pass);
  const login = JSON.stringify({ ServerURL: "", ...machineLogin });
  for (const store of ["secretservice", "pass"])
    await writeFile(
      join(helpers, `docker-credential-${store}`),
      `#!/bin/sh\necho ${store} >> '${asked}'\ncat > /dev/null\nprintf '%s' '${login}'\n`,
      { mode: 0o755 },
    );
  await writeFile(join(pass, "pass"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { helpers, pass };
}

/** @param {import("node:test").TestContext} t */
export async function dockerDaemon(t) {
  // Under /tmp, since a long TMPDIR could put the socket's path past the
  // length one may have.
  const directory = await mkdtemp("/tmp/chuggy-linux-docker-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const asked = join(directory, "asked");
  const { helpers, pass } = await credentialHelpers(directory, asked);
  /** @type {unknown[]} */
  const registryAuths = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/_ping") === true) {
      response.writeHead(200, { "Api-Version": "1.47", Ostype: "linux" });
      response.end();
      return;
    }
    const header = request.headers["x-registry-auth"];
    registryAuths.push(
      typeof header === "string"
        ? JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
        : undefined,
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"pulled"}\n');
  });
  const socket = join(directory, "docker.sock");
  await new Promise((resolve) => {
    server.listen(socket, () => resolve(undefined));
  });
  t.after(() => server.close());
  return {
    host: `unix://${socket}`,
    /**
     * A PATH holding both helpers, and with `pass` too when docker should
     * pick the helper that uses it.
     *
     * @param {boolean} withPass
     */
    path: (withPass) =>
      [helpers, ...(withPass ? [pass] : []), process.env.PATH].join(":"),
    /** Which helpers docker asked, in order. */
    asked: async () =>
      (await readFile(asked, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== ""),
    /** What each pull's `X-Registry-Auth` carried, decoded. */
    registryAuths,
  };
}
