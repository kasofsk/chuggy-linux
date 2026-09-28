/**
 * The credential a pull is made under. The pool's token goes only to the one
 * registry its registration names, written for that registry into a directory
 * made for that one pull and removed after it, whatever its outcome. Every
 * other pull is made from such a directory too, holding no credential, so no
 * login stored on this machine is presented anywhere either. The engine reads
 * it from there, so the token is never in an argv.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { registryAuthFile } from "./engineArgv.mjs";
import { runtimeScratch } from "./runnerConfig.mjs";

/**
 * @typedef {{host: string, token: string}} RegistryCredential
 */

/** The user a registry is told; the registry authorizes on the token alone. */
const registryUser = "chuggy-pool";

/** Where an image whose reference names no registry is pulled from. */
const defaultRegistryHost = "docker.io";

/**
 * The registry an image reference names, by the rule both engines share: a
 * first component with a dot or a colon, or `localhost`, is a host, and a
 * reference without one is Docker Hub's.
 *
 * @param {string} reference
 * @returns {string}
 */
export function imageRegistryHost(reference) {
  const slash = reference.indexOf("/");
  const first = slash < 0 ? "" : reference.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? first
    : defaultRegistryHost;
}

/** @param {RegistryCredential | undefined} credential */
export function registryAuthDocument(credential) {
  if (credential === undefined) return JSON.stringify({ auths: {} });
  const auth = Buffer.from(
    `${registryUser}:${credential.token}`,
    "utf8",
  ).toString("base64");
  return JSON.stringify({ auths: { [credential.host]: { auth } } });
}

/**
 * Runs `pull` with a directory holding its credential, or none, made
 * owner-only under `runtimeDir` and removed however `pull` ends.
 *
 * @template T
 * @param {string} runtimeDir
 * @param {RegistryCredential | undefined} credential
 * @param {(directory: string) => Promise<T>} pull
 * @returns {Promise<T>}
 */
export async function withRegistryAuth(runtimeDir, credential, pull) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtimeDir, runtimeScratch("pull")));
  try {
    await writeFile(
      join(directory, registryAuthFile),
      registryAuthDocument(credential),
      { mode: 0o600, flag: "wx" },
    );
    return await pull(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
