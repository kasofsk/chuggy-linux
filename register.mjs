/**
 * Registering this machine as a pool: a single-use token minted in chuggy's
 * console is redeemed for the pool file, which is written where `run` reads
 * it. What the operator could have asked wrongly is refused before the token
 * is spent, and the answer is checked whole before anything is written. The
 * pool's secret is never printed and never in an argv.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  workerPoolCapabilitiesSchema,
  workerPoolIdentityCharsMax,
  workerPoolRedemptionSchema,
} from "@chuggy/worker-contract/workerPool";
import { boundedResponseBytes } from "@chuggy/worker-core/boundedResponse.mjs";
import { z } from "zod";

import { poolIdentityDigest } from "./poolIdentity.mjs";
import { serviceUnitBaseCharsMax } from "./systemdUnit.mjs";

/**
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {z.infer<typeof registeredPoolSchema>} RegisteredPool
 *
 * @typedef {object} RegisterRequest
 * @property {URL} api chuggy's origin
 * @property {string} token
 * @property {string} pool the name the pool takes
 * @property {string} capability this machine's platform, the one capability the pool declares
 *
 * @typedef {object} RegisterAsked what the operator asked
 * @property {string | undefined} api
 * @property {string | undefined} token
 * @property {string | undefined} pool
 *
 * @typedef {object} RegisterMachine
 * @property {string} hostname
 * @property {string} arch as `process.arch` names it
 */

/** Where a token is redeemed, under chuggy's API. */
const registerPath = "/api/v1/worker-pool-registrations";

/** The media type chuggy's API takes a body in and answers with, its `nativeHttpMediaType`. */
const registerMediaType = "application/vnd.chuggy.v1+json";

/** chuggy's bound on a body it answers, its `nativeHttpBodyBytesMax`. */
const registerResponseBytesMax = 64 * 1024;
const registerResponseReadsMax = 64;
const registerTimeoutMs = 30_000;

/** The most of chuggy's own words an error line carries. */
const registerReasonCharsMax = 200;

/** The platform each machine `process.arch` names is. */
const registerPlatforms = /** @type {Record<string, string>} */ ({
  x64: "Platform:Linux:Amd64",
  arm64: "Platform:Linux:Arm64",
});

/** The longest DNS label. */
const registerPoolNameCharsMax = 63;

/**
 * A pool name register takes: a DNS label, lowercase. A pool file's name and
 * its unit's both carry it as itself.
 */
const registerPoolNamePattern = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,${String(registerPoolNameCharsMax - 2)}}[a-z0-9])?$`,
  "u",
);

/** The core's own rule for a registry host: a lowercase DNS name, and a port. */
const registerRegistryHostPattern =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/u;

/**
 * Why a URL is not one this machine sends a credential to, or nothing: it is
 * `https:`, or `http:` to this machine's own loopback.
 *
 * @param {URL} url
 * @returns {string | undefined}
 */
export function registerEndpointRefusal(url) {
  if (url.protocol === "https:") return undefined;
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(url.hostname);
  return url.protocol === "http:" && loopback
    ? undefined
    : "must be https, or http to this machine's loopback";
}

/** @param {string} text */
function registerUrlAllowed(text) {
  try {
    return registerEndpointRefusal(new URL(text)) === undefined;
  } catch {
    return false;
  }
}

const registerUrlSchema = z.string().refine(registerUrlAllowed, {
  error: "is not an https URL, or an http URL on this machine's loopback",
});
const registerNameSchema = z.string().min(1).max(workerPoolIdentityCharsMax);
const registerTextSchema = z.string().min(1);

/** The pool file, as chuggy answers a redemption with it and the worker core reads it. */
export const registeredPoolSchema = z.strictObject({
  tenant: registerNameSchema,
  project: registerNameSchema,
  pool: registerNameSchema,
  capabilities: workerPoolCapabilitiesSchema,
  tokenUrl: registerUrlSchema,
  audience: registerTextSchema,
  planeUrl: registerUrlSchema,
  registryHost: z.string().regex(registerRegistryHostPattern).optional(),
  clientId: registerTextSchema,
  clientSecret: registerTextSchema,
});

/**
 * The pool name this machine's hostname makes: its first label, lowercase,
 * each run of other characters a hyphen. Nothing where it makes none.
 *
 * @param {string} hostname
 */
export function registerPoolNameDefault(hostname) {
  const name = (hostname.toLowerCase().split(".")[0] ?? "")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, registerPoolNameCharsMax)
    .replace(/-+$/u, "");
  return registerPoolNamePattern.test(name) ? name : undefined;
}

/**
 * chuggy's origin as the operator named it, or why it is not one.
 *
 * @param {string} text
 * @returns {URL | string}
 */
function registerApi(text) {
  let api;
  try {
    api = new URL(text);
  } catch {
    return `--api ${text} is not a URL`;
  }
  if (
    api.username !== "" ||
    api.password !== "" ||
    api.pathname !== "/" ||
    api.search !== "" ||
    api.hash !== ""
  )
    return `--api ${api.href} is not an origin; name chuggy as https://<host>`;
  const refusal = registerEndpointRefusal(api);
  return refusal === undefined ? api : `--api ${api.origin} ${refusal}`;
}

/**
 * The redemption the operator asked for, or why it cannot be made. Nothing
 * here spends the token.
 *
 * @param {RegisterAsked} asked
 * @param {RegisterMachine} machine
 * @returns {{request: RegisterRequest} | {refused: string}}
 */
export function registerRequest(asked, machine) {
  if (asked.api === undefined || asked.token === undefined)
    return { refused: "register needs --api and --token" };
  const api = registerApi(asked.api);
  if (typeof api === "string") return { refused: api };
  const capability = Object.hasOwn(registerPlatforms, machine.arch)
    ? registerPlatforms[machine.arch]
    : undefined;
  if (capability === undefined)
    return {
      refused: `this machine is ${machine.arch}, and a Linux pool runs on x64 or arm64`,
    };
  const pool = asked.pool ?? registerPoolNameDefault(machine.hostname);
  if (pool === undefined)
    return {
      refused: `this machine's hostname makes no pool name; name the pool with --pool`,
    };
  if (!registerPoolNamePattern.test(pool))
    return {
      refused: `--pool ${pool} is not a pool name: at most ${String(registerPoolNameCharsMax)} lowercase letters, digits and hyphens, beginning and ending with a letter or digit`,
    };
  const redemption = workerPoolRedemptionSchema.safeParse({
    token: asked.token,
    pool,
    capabilities: [capability],
  });
  if (!redemption.success)
    return { refused: "--token is not a registration token" };
  return { request: { api, token: asked.token, pool, capability } };
}

/**
 * Text chuggy answered, as one printable line: every control or format
 * character a space, and at most `registerReasonCharsMax` of it.
 *
 * @param {string} text
 */
function registerPrintable(text) {
  return [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()]
    .slice(0, registerReasonCharsMax)
    .join("");
}

/**
 * The reason an error answer gives, where it carries one.
 *
 * @param {Uint8Array} body
 */
function registerErrorReason(body) {
  try {
    const message = JSON.parse(Buffer.from(body).toString("utf8"))?.error
      ?.message;
    return typeof message === "string" ? registerPrintable(message) : "";
  } catch {
    return "";
  }
}

/**
 * What an answer other than a pool file means, as one line.
 *
 * @param {number} status
 * @param {Uint8Array} body
 * @param {RegisterRequest} request
 */
function registerRefusal(status, body, request) {
  if (status === 404)
    return "the registration token is unknown, spent or expired; mint another in chuggy's console";
  if (status === 403)
    return `the registration token does not permit ${request.capability}; mint one that does`;
  if (status === 400) {
    const reason = registerErrorReason(body);
    return `chuggy refused the registration as malformed${reason === "" ? "" : `: ${reason}`}`;
  }
  if (status === 503)
    return "chuggy could not answer the registration; run register again";
  return status >= 500
    ? `chuggy failed the registration with HTTP ${String(status)}; run register again`
    : `chuggy answered the registration with HTTP ${String(status)}`;
}

/** @param {unknown} failure */
function registerFailureReason(failure) {
  const cause = failure instanceof Error ? failure.cause : undefined;
  const error = cause instanceof Error ? cause : failure;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pool file a 201 carries, checked whole: it must be one the worker core
 * reads, for the pool asked for, declaring the capability asked for.
 *
 * @param {Uint8Array} body
 * @param {RegisterRequest} request
 * @returns {RegisteredPool}
 */
function registeredPool(body, request) {
  const spent = "the token is spent, so mint another";
  let document;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    throw new Error(`chuggy answered the registration with no JSON; ${spent}`);
  }
  const parsed = registeredPoolSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `chuggy answered the registration with no pool file this runner reads (${registerPrintable(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; "),
      )}); ${spent}`,
    );
  if (
    parsed.data.pool !== request.pool ||
    parsed.data.capabilities.length !== 1 ||
    parsed.data.capabilities[0] !== request.capability
  )
    throw new Error(
      `chuggy answered the registration for another pool or capability than the one asked for; ${spent}`,
    );
  return parsed.data;
}

/**
 * Redeems the token, answering the pool file or throwing why not, as one line.
 *
 * @param {RegisterRequest} request
 * @param {typeof globalThis.fetch} fetch
 * @returns {Promise<RegisteredPool>}
 */
export async function registerRedeemed(request, fetch) {
  let status;
  let body;
  try {
    const response = await fetch(new URL(registerPath, request.api), {
      method: "POST",
      headers: {
        "content-type": registerMediaType,
        accept: registerMediaType,
      },
      body: JSON.stringify({
        token: request.token,
        pool: request.pool,
        capabilities: [request.capability],
      }),
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(registerTimeoutMs),
    });
    status = response.status;
    body = await boundedResponseBytes(
      response,
      registerResponseBytesMax,
      registerResponseReadsMax,
    );
  } catch (failure) {
    throw new Error(
      `chuggy at ${request.api.origin} did not answer the registration${status === 201 ? " whole, and the token is spent" : ""}: ${registerFailureReason(failure)}`,
      { cause: failure },
    );
  }
  if (status === 201) return registeredPool(body, request);
  throw new Error(registerRefusal(status, body, request));
}

/**
 * One name of the pool's, as a part of its file's name: a letter, digit or
 * hyphen as itself, and any other byte as `_` and its hex.
 *
 * @param {string} name
 */
function registerPoolFileNamePart(name) {
  let part = "";
  for (const byte of Buffer.from(name, "utf8")) {
    const char = String.fromCharCode(byte);
    part += /^[A-Za-z0-9-]$/u.test(char)
      ? char
      : `_${byte.toString(16).padStart(2, "0")}`;
  }
  return part;
}

/**
 * The pool file's name: tenant, project and pool, joined by a `.` no part
 * carries, so no two pools share one. Names too long for the file's unit to
 * be named for it make a digest of the identity instead, which has no `.`.
 *
 * @param {PoolIdentity} identity
 */
export function registerPoolFileName(identity) {
  const name = [identity.tenant, identity.project, identity.pool]
    .map(registerPoolFileNamePart)
    .join(".");
  return name.length <= serviceUnitBaseCharsMax
    ? `${name}.json`
    : `pool-${poolIdentityDigest(identity)}.json`;
}

/**
 * The directory pool files are written to, made owner-only and checked
 * writable before a token is spent, so a directory that cannot be written
 * costs none.
 *
 * @param {string} directory
 */
export async function registerPoolDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (((await stat(directory)).mode & 0o777) !== 0o700)
      await chmod(directory, 0o700);
    await access(directory, constants.W_OK | constants.X_OK);
  } catch (failure) {
    throw new Error(
      `${directory} cannot be made a directory only you can write, so no token was spent: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    );
  }
}

/**
 * Writes the pool file whole under a temporary name, owner-only from its
 * creation, and renames it over any earlier file of the same pool.
 *
 * @param {string} directory
 * @param {RegisteredPool} pool
 * @returns {Promise<{file: string, replaced: boolean}>}
 */
export async function registerPoolFileWritten(directory, pool) {
  const file = join(directory, registerPoolFileName(pool));
  const temporary = join(
    directory,
    `.register-${randomBytes(8).toString("hex")}.tmp`,
  );
  const replaced = await stat(file).then(
    () => true,
    () => false,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(pool, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return { file, replaced };
}
