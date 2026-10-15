import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import { nodeMajorMin, nodeRefusal } from "./nodeFloor.mjs";

test("the floor is the one package.json's engines names", async () => {
  const { engines } = JSON.parse(
    await readFile(new URL("package.json", import.meta.url), "utf8"),
  );
  assert.equal(engines.node, `>=${String(nodeMajorMin)}`);
});

test("a Node below the floor is refused, naming this copy, the floor and that Node", () => {
  assert.equal(
    nodeRefusal("0.7.0", "22.11.0", "/usr/bin/node"),
    `chuggy-linux 0.7.0 needs Node ${String(nodeMajorMin)} or later; /usr/bin/node is Node 22.11.0`,
  );
  for (const version of [`${String(nodeMajorMin - 1)}.99.99`, "", "next"])
    assert.equal(
      nodeRefusal("0.7.0", version, "/n/node"),
      `chuggy-linux 0.7.0 needs Node ${String(nodeMajorMin)} or later; /n/node is Node ${version}`,
      version,
    );
});

test("a Node at the floor or above is not refused", () => {
  for (const version of [
    `${String(nodeMajorMin)}.0.0`,
    `${String(nodeMajorMin)}.8.0`,
    `${String(nodeMajorMin + 2)}.1.0`,
  ])
    assert.equal(nodeRefusal("0.7.0", version, "/n/node"), undefined, version);
});
