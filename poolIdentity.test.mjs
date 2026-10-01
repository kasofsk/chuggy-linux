import assert from "node:assert/strict";
import test from "node:test";

import {
  poolIdentityDigest,
  poolIdentitySame,
  poolLabelValue,
} from "./poolIdentity.mjs";

const shame = { tenant: "vteng", project: "chuggy", pool: "shame" };

test("a pool whose names hold no '%' or '/' is labelled as it always was", () => {
  assert.equal(poolLabelValue(shame), "vteng/chuggy/shame");
  assert.equal(
    poolLabelValue({
      tenant: "new-tenant",
      project: "arb-bot",
      pool: "sh.a_me",
    }),
    "new-tenant/arb-bot/sh.a_me",
  );
});

test("a '/' or '%' inside a name is encoded, so no two pools share a label", () => {
  const labels = [
    { tenant: "a/b", project: "c", pool: "p" },
    { tenant: "a", project: "b/c", pool: "p" },
    { tenant: "a%2Fb", project: "c", pool: "p" },
  ].map(poolLabelValue);
  assert.deepEqual(labels, ["a%2Fb/c/p", "a/b%2Fc/p", "a%252Fb/c/p"]);
});

test("a digest is fixed in length and tells apart names a separator would join alike", () => {
  const one = poolIdentityDigest({ tenant: "a-b", project: "c", pool: "p" });
  const other = poolIdentityDigest({ tenant: "a", project: "b-c", pool: "p" });
  assert.match(one, /^[0-9a-f]{20}$/u);
  assert.notEqual(one, other);
  assert.notEqual(
    poolIdentityDigest(shame),
    poolIdentityDigest(shame, "asg-1"),
  );
  assert.equal(
    poolIdentityDigest(shame, "asg-1"),
    poolIdentityDigest({ ...shame }, "asg-1"),
  );
});

test("a pool is the same pool only in all three names", () => {
  assert.ok(poolIdentitySame(shame, { ...shame }));
  for (const differs of [
    { ...shame, tenant: "newtenant" },
    { ...shame, project: "arbbot" },
    { ...shame, pool: "other" },
  ])
    assert.ok(!poolIdentitySame(shame, differs), JSON.stringify(differs));
});
