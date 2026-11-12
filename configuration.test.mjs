/**
 * The configuration's credential lists. A workload without a `credentials`
 * key is granted everything the deployment allows, so every workload names
 * its list, empty or not. A listed name the deployment does not grant fails
 * the attempt, and `chuggy-github-worker` is one: git credentials for GitHub
 * are minted by the worker plane on request, not delivered by name.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const configurationPath = new URL(
  ".chug/configurations/chuggy-linux.json",
  import.meta.url,
);

async function workloads() {
  const document = JSON.parse(await readFile(configurationPath, "utf8"));
  return Object.entries(document.configuration.workloads);
}

test("every workload names its credentials as a list", async () => {
  const entries = await workloads();
  assert.ok(entries.length > 0);
  for (const [name, workload] of entries)
    assert.ok(Array.isArray(workload.authority.credentials), name);
});

test("no workload lists a credential the deployment does not grant", async () => {
  for (const [name, workload] of await workloads())
    assert.ok(
      !workload.authority.credentials.includes("chuggy-github-worker"),
      name,
    );
});
