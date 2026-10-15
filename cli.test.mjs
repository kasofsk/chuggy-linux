/**
 * The entry as an install runs it: a Node of its own on a copy of `cli.mjs`,
 * in a directory of the copy's own whose `package.json` names a version of
 * its own. A Node is made to say it is older by a module loaded before the
 * entry, and the entry is then run from a copy holding only what its refusal
 * may load, so anything else it imported would fail it.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { nodeMajorMin } from "./nodeFloor.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));

/** What the entry loads before it knows whether the Node under it is refused, besides its `package.json`. */
const refusalFiles = ["cli.mjs", "nodeFloor.mjs"];

/** The version a copy's `package.json` names. */
const copyVersion = "0.0.1-copy";

/**
 * A copy of this tree's shipped set, or of what the refusal may load, with a
 * `package.json` naming `copyVersion`, and for the shipped set the installed
 * packages linked in.
 *
 * @param {import("node:test").TestContext} t
 * @param {"shipped" | "refusal"} files the shipped set, or what the refusal may load
 * @returns {Promise<string>} the copy's entry
 */
async function copied(t, files) {
  const copy = await mkdtemp(join(tmpdir(), "chuggy-linux-copy-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const file of files === "shipped" ? manifest.files : refusalFiles)
    await copyFile(join(root, file), join(copy, file));
  await writeFile(
    join(copy, "package.json"),
    JSON.stringify({ ...manifest, version: copyVersion }),
  );
  if (files === "shipped")
    await symlink(join(root, "node_modules"), join(copy, "node_modules"));
  return join(copy, "cli.mjs");
}

/**
 * Runs an entry under this Node, or under this Node saying it is
 * `nodeVersion`, in a home of its own.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} entry
 * @param {readonly string[]} argv
 * @param {string} [nodeVersion]
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
async function ran(t, entry, argv, nodeVersion) {
  const home = await mkdtemp(join(tmpdir(), "chuggy-linux-entry-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const saying =
    nodeVersion === undefined
      ? []
      : [
          "--import",
          `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(nodeVersion)} });`)}`,
        ];
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...saying, entry, ...argv],
      { env: environment, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          status: error === null ? 0 : Number(error.code),
          stdout,
          stderr,
        }),
    );
  });
}

test("--version names the version the copy's own package.json names", async (t) => {
  const entry = await copied(t, "shipped");
  assert.deepEqual(await ran(t, entry, ["--version"]), {
    status: 0,
    stdout: `chuggy-linux ${copyVersion}\n`,
    stderr: "",
  });
});

test("on a Node below the floor every command, --version too, is refused with one line and exit 2, having loaded nothing that Node may not parse", async (t) => {
  const entry = await copied(t, "refusal");
  const line = `chuggy-linux ${copyVersion} needs Node ${String(nodeMajorMin)} or later; ${process.execPath} is Node 22.11.0\n`;
  for (const argv of [
    ["--version"],
    ["doctor", "--pool", "/p.json"],
    ["register", "--api", "https://chuggy.example", "--token=t"],
    ["run", "--pool", "/p.json"],
    [],
  ])
    assert.deepEqual(
      await ran(t, entry, argv, "22.11.0"),
      { status: 2, stdout: "", stderr: line },
      argv.join(" "),
    );
});

test("on a Node at the floor the entry runs the command", async (t) => {
  const entry = await copied(t, "shipped");
  assert.deepEqual(
    await ran(t, entry, ["--version"], `${String(nodeMajorMin)}.0.0`),
    { status: 0, stdout: `chuggy-linux ${copyVersion}\n`, stderr: "" },
  );
});

test("doctor run by the entry says first which copy is speaking, at which path, under which Node", async (t) => {
  const entry = await copied(t, "shipped");
  const { status, stdout } = await ran(t, entry, [
    "doctor",
    "--pool",
    "/nonexistent/pool.json",
  ]);
  assert.equal(status, 1);
  assert.equal(
    stdout.split("\n")[0],
    `chuggy-linux ${copyVersion} at ${entry}, under Node ${process.versions.node} at ${process.execPath}`,
  );
});
