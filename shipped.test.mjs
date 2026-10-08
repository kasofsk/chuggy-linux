/**
 * The shipped set, `package.json`'s `files`, against the modules the CLI runs.
 * The tarball carries that set and nothing else of this tree, so a module the
 * entry reaches and the set omits is an install that fails at its first
 * import. Every module is reached by a literal specifier, so the graph is read
 * off the text.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const root = new URL("./", import.meta.url);
const entry = "cli.mjs";

/** A static import or re-export, or a bare import. */
const specifierPattern = /\b(?:from|import)\s*["']([^"']+)["']/gu;

async function manifest() {
  return JSON.parse(await readFile(new URL("package.json", root), "utf8"));
}

/** Every module reachable from `start` by relative imports, named from the root. */
async function reachedFrom(start) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const name = pending.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const module = new URL(name, root);
    for (const [, specifier] of (await readFile(module, "utf8")).matchAll(
      specifierPattern,
    ))
      if (/^\.\.?\//u.test(specifier))
        pending.push(new URL(specifier, module).href.slice(root.href.length));
  }
  return [...reached].sort();
}

test("the shipped set is every module the entry reaches, and every module here but the suites and fixtures", async () => {
  const { files, bin } = await manifest();
  const reached = await reachedFrom(entry);
  const modules = (await readdir(root)).filter(
    (name) =>
      name.endsWith(".mjs") &&
      !name.endsWith(".test.mjs") &&
      !name.includes(".fixture."),
  );

  assert.equal(bin["chuggy-linux"], entry);
  assert.ok(reached.includes("runner.mjs"), reached.join(" "));
  assert.deepEqual(reached, [...modules].sort());
  assert.deepEqual([...files].sort(), [...modules].sort());
});

test("every dependency is bundled, so an install needs neither git nor the contract's release", async () => {
  const { dependencies, bundleDependencies } = await manifest();
  assert.deepEqual(
    [...bundleDependencies].sort(),
    Object.keys(dependencies).sort(),
  );
});
