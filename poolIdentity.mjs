/**
 * A pool's identity, its tenant, project and name, in the forms this machine
 * keys what it keeps per pool by: the label its containers carry, and a digest
 * naming its runtime directory and its containers. Each form is injective, so
 * two pools never share one whatever their names hold, and two pools of one
 * name in different projects keep apart.
 */

import { createHash } from "node:crypto";

/**
 * @typedef {object} PoolIdentity
 * @property {string} tenant
 * @property {string} project
 * @property {string} pool
 */

/** How much of a digest a name carries. */
const poolIdentityDigestChars = 20;

/**
 * @param {PoolIdentity} one
 * @param {PoolIdentity} other
 */
export function poolIdentitySame(one, other) {
  return (
    one.tenant === other.tenant &&
    one.project === other.project &&
    one.pool === other.pool
  );
}

/**
 * The pool label's value: the three names joined by `/`, a `%` or `/` inside
 * a name percent-encoded. A name holding neither is written as itself.
 *
 * @param {PoolIdentity} identity
 */
export function poolLabelValue(identity) {
  return [identity.tenant, identity.project, identity.pool]
    .map((name) => name.replaceAll("%", "%25").replaceAll("/", "%2F"))
    .join("/");
}

/**
 * A digest of the identity and of whatever else is named with it, as hex.
 *
 * @param {PoolIdentity} identity
 * @param {...string} more
 */
export function poolIdentityDigest(identity, ...more) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.tenant,
        identity.project,
        identity.pool,
        ...more,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, poolIdentityDigestChars);
}
