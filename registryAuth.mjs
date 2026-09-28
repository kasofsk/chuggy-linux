/**
 * The credential a pull is made under: the pool's own token, written for the
 * registry the image names into a directory made for that one pull and
 * removed after it, whatever its outcome. The engine reads it from there, so
 * the token is never in an argv and never among the engine's stored logins.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { registryAuthFile } from "./engineArgv.mjs";

/** The user a registry is told; the registry authorizes on the token alone. */
const registryUser = "chuggy-pool";

/**
 * The registry an image reference names, by the rule both engines share: a
 * first component with a dot or a colon, or `localhost`, is a host. A
 * reference naming none is Docker Hub's, which is handed no credential.
 *
 * @param {string} reference
 * @returns {string | undefined}
 */
export function imageRegistryHost(reference) {
  const slash = reference.indexOf("/");
  if (slash < 0) return undefined;
  const first = reference.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? first
    : undefined;
}

/**
 * @param {string | undefined} host
 * @param {string} token
 */
export function registryAuthDocument(host, token) {
  const auth = Buffer.from(`${registryUser}:${token}`, "utf8").toString(
    "base64",
  );
  return JSON.stringify({
    auths: host === undefined ? {} : { [host]: { auth } },
  });
}

/**
 * Runs `pull` with a directory holding its credential, made owner-only under
 * `runtimeDir` and removed however `pull` ends.
 *
 * @template T
 * @param {string} runtimeDir
 * @param {string | undefined} host
 * @param {string} token
 * @param {(directory: string) => Promise<T>} pull
 * @returns {Promise<T>}
 */
export async function withRegistryAuth(runtimeDir, host, token, pull) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtimeDir, "pull-"));
  try {
    await writeFile(
      join(directory, registryAuthFile),
      registryAuthDocument(host, token),
      { mode: 0o600, flag: "wx" },
    );
    return await pull(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
