/**
 * `mcp` end to end: the CLI started as a coding agent starts it, spoken to by
 * the SDK's own client over stdio, against a site and an issuer on this
 * machine's loopback.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { localToolSignInFile } from "@chuggy/worker-core/localTools.mjs";

import { cliMain } from "./commands.mjs";
import { runnerPaths } from "./runnerConfig.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const ticketPath = "/api/v1/tenants/vteng/projects/chuggy/tickets/7";
const accessToken = `chgp_${"a".repeat(43)}`;

function bodyOf(request) {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
  });
}

/**
 * A site whose issuer is itself, issuing `access-N` and `renewal-N` for the
 * Nth grant once `answering` settles, or refusing it where that answers a
 * refusal.
 */
async function siteOf(t, answering = async () => undefined) {
  const grants = [];
  const bearers = [];
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${String(server.address().port)}`;
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url, origin).pathname;
    if (path === "/config.json")
      return json(200, {
        issuer: `${origin}/issuer`,
        audience: `${origin}/api`,
      });
    if (path === "/issuer/.well-known/openid-configuration")
      return json(200, {
        issuer: `${origin}/issuer`,
        authorization_endpoint: `${origin}/issuer/auth`,
        token_endpoint: `${origin}/issuer/token`,
      });
    if (path === "/issuer/token") {
      grants.push(
        Object.fromEntries(new URLSearchParams(await bodyOf(request))),
      );
      const n = String(grants.length);
      const refusal = await answering();
      if (refusal !== undefined) return json(400, refusal);
      return json(200, {
        access_token: `access-${n}`,
        refresh_token: `renewal-${n}`,
        expires_in: 3_600,
      });
    }
    if (path === ticketPath) bearers.push(request.headers.authorization);
    if (path === ticketPath)
      return request.headers.authorization?.startsWith("Bearer access-") ||
        request.headers.authorization === `Bearer ${accessToken}`
        ? json(200, { ticket: 7, phase: "Draft" })
        : json(401, { error: "Unauthenticated" });
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    site: `http://127.0.0.1:${String(server.address().port)}`,
    grants,
    bearers,
  };
}

/** `mcp` started for the suite's project as a coding agent starts it, with `environment` beside its home. */
function transportOf(home, site, environment = {}) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "mcp",
      "--site",
      site,
      "--workspace",
      "vteng",
      "--project",
      "chuggy",
    ],
    env: { ...environment, HOME: home, PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
}

/** A client that fails its test on any line on stdout that is not the protocol's. */
async function clientOf(t, home, site, environment) {
  const client = new Client({ name: "suite", version: "1" });
  const strays = [];
  client.onerror = (failure) => strays.push(failure);
  await client.connect(transportOf(home, site, environment));
  t.after(async () => {
    await client.close();
    assert.deepEqual(strays, []);
  });
  return client;
}

async function homeOf(t) {
  const home = await mkdtemp(join(tmpdir(), "chuggy-linux-mcp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** A home whose sign-in to `site` holds the renewal token `renewal-0`, and that token's file. */
async function signedInOf(t, site) {
  const home = await homeOf(t);
  const file = localToolSignInFile(runnerPaths({}, home).signIns, site);
  await mkdir(runnerPaths({}, home).signIns, { recursive: true });
  await writeFile(file, "renewal-0\n", { mode: 0o600 });
  return { home, file };
}

function textOf(answer) {
  return answer.content.map(({ text }) => text).join("");
}

test("an agent is given the project tools, those of your own agent accounts and the merge of your ticket's pull request, and reads a ticket under a renewed sign-in", async (t) => {
  const { site, grants } = await siteOf(t);
  const { home, file } = await signedInOf(t, site);

  const client = await clientOf(t, home, site);
  const names = (await client.listTools()).tools.map(({ name }) => name);
  assert.ok(names.includes("create_draft"));
  assert.ok(names.includes("release_draft"));
  assert.ok(!names.includes("dispatch"));
  for (const name of [
    "read_usage",
    "update_usage_settings",
    "retry_paused_agent",
    "retire_credential",
    "merge_pull_request",
  ]) {
    assert.ok(names.includes(name), name);
  }

  const answer = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(answer.isError, undefined, textOf(answer));
  assert.match(textOf(answer), /^HTTP 200\n/);
  assert.equal(grants[0].refresh_token, "renewal-0");
  assert.equal((await readFile(file, "utf8")).trim(), "renewal-1");
});

test("an agent listing repositories is told what pipelinesRunnable says", async (t) => {
  const { site } = await siteOf(t);
  const client = await clientOf(t, await homeOf(t), site);
  const listing = (await client.listTools()).tools.find(
    ({ name }) => name === "list_repositories",
  );
  assert.match(
    listing.description,
    /`pipelinesRunnable` whether they may be issued `chuggy\.github-workflow-runs`/u,
  );
});

test("with no sign-in, a call answers a page whose answer signs the next call in", async (t) => {
  const { site } = await siteOf(t);
  const home = await homeOf(t);
  const client = await clientOf(t, home, site);

  const refused = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(refused.isError, true);
  const link = /(\S+\/auth\?\S+)/u.exec(textOf(refused))?.[1];
  assert.ok(link !== undefined, textOf(refused));
  const query = new URL(link).searchParams;
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);

  const read = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.match(textOf(read), /^HTTP 200\n/);
});

/**
 * `mcp` asked of a child with no input, so an ask whose refusal regressed
 * ends rather than serving on this suite's own stdin.
 */
function mcpAsked(args) {
  const asked = spawnSync(process.execPath, [cli, "mcp", ...args], {
    input: "",
    timeout: 10_000,
    env: { HOME: "/nowhere", PATH: "" },
    encoding: "utf8",
  });
  return { status: asked.status, err: asked.stderr };
}

test("mcp is asked with a site a credential may be sent to, a workspace and a project, and nothing else", async () => {
  const named = ["--workspace", "vteng", "--project", "chuggy"];
  const site = ["--site", "https://chuggy.test"];
  const unsited = mcpAsked(named);
  assert.equal(unsited.status, 2);
  assert.match(unsited.err, /need a site/);
  const plain = mcpAsked(["--site", "http://chuggy.test", ...named]);
  assert.equal(plain.status, 2);
  assert.match(plain.err, /https/);
  assert.equal(mcpAsked([...site, ...named, "--pool", "x"]).status, 2);
  assert.equal(mcpAsked(["extra", ...site, ...named]).status, 2);
});

test("every other command refuses mcp's options", async () => {
  const host = {
    environment: {},
    home: "/nowhere",
    err: () => {},
    out: () => {},
  };
  const site = ["--site", "https://chuggy.test"];
  assert.equal(
    await cliMain(
      ["register", "--api", "https://chuggy.test", "--token=x", ...site],
      host,
    ),
    2,
  );
  assert.equal(await cliMain(["run", ...site, "--pool", "x"], host), 2);
});

test("every mcp on a machine uses the one stored access token, renewing once for its life", async (t) => {
  const { site, grants } = await siteOf(t);
  const { home } = await signedInOf(t, site);

  for (const started of ["first", "second"]) {
    const client = await clientOf(t, home, site);
    const read = await client.callTool({
      name: "read_ticket",
      arguments: { ticket: 7 },
    });
    assert.match(textOf(read), /^HTTP 200\n/, started);
    await client.close();
  }
  assert.equal(grants.length, 1);
});

test("a renewal sent before mcp is sent SIGTERM is stored before it exits", async (t) => {
  let arrived;
  const arriving = new Promise((resolve) => (arrived = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const { site } = await siteOf(t, () => {
    arrived();
    return released;
  });
  const { home, file } = await signedInOf(t, site);
  const client = new Client({ name: "suite", version: "1" });
  const transport = transportOf(home, site);
  await client.connect(transport);
  const exited = new Promise((resolve) => (client.onclose = resolve));
  t.after(() => client.close());

  const calling = client
    .callTool({ name: "read_ticket", arguments: { ticket: 7 } })
    .catch(() => undefined);
  await arriving;
  process.kill(transport.pid, "SIGTERM");
  const exitWindowMs = 500;
  const early = await Promise.race([
    exited.then(() => "exited"),
    wait(exitWindowMs, "held"),
  ]);
  assert.equal(early, "held");
  release();
  await exited;
  await calling;
  assert.equal((await readFile(file, "utf8")).trim(), "renewal-1");
});

test("after the issuer refuses a renewal, a later mcp's call says when and why", async (t) => {
  const { site } = await siteOf(t, async () => ({
    error: "invalid_grant",
    error_description: "the renewal token was already spent",
  }));
  const { home } = await signedInOf(t, site);
  const refused = await clientOf(t, home, site);
  await refused.callTool({ name: "read_ticket", arguments: { ticket: 7 } });
  await refused.close();

  const later = await clientOf(t, home, site);
  const answer = await later.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(answer.isError, true);
  assert.match(
    textOf(answer),
    /The issuer ended this sign-in at \S+ and said why: "invalid_grant: the renewal token was already spent"/,
  );
});

test("where CHUGGY_TOKEN holds an access token, every call presents it and the sign-in store is never reached", async (t) => {
  const { site, grants, bearers } = await siteOf(t);
  const home = await homeOf(t);
  const client = await clientOf(t, home, site, { CHUGGY_TOKEN: accessToken });

  const read = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.match(textOf(read), /^HTTP 200\n/);
  assert.deepEqual(bearers, [`Bearer ${accessToken}`]);
  assert.equal(grants.length, 0);
  assert.deepEqual(await readdir(home), []);
});

test("where CHUGGY_TOKEN holds something other than an access token, nothing is sent and the call says so", async (t) => {
  const { site, bearers } = await siteOf(t);
  const { home } = await signedInOf(t, site);
  const client = await clientOf(t, home, site, { CHUGGY_TOKEN: "not-one" });

  const refused = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /CHUGGY_TOKEN does not hold/);
  assert.deepEqual(bearers, []);
});

test("an empty CHUGGY_TOKEN leaves the sign-in", async (t) => {
  const { site, grants, bearers } = await siteOf(t);
  const { home } = await signedInOf(t, site);
  const client = await clientOf(t, home, site, { CHUGGY_TOKEN: "" });

  const read = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.match(textOf(read), /^HTTP 200\n/);
  assert.equal(grants.length, 1);
  assert.deepEqual(bearers, ["Bearer access-1"]);
});
