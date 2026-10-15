/**
 * The oldest Node this runner runs on, and what it says to an older one. The
 * entry reads it before it knows the Node under it can run anything else, so
 * it imports nothing and keeps to syntax an older Node parses: no optional
 * chaining, no `??` and no top-level `await`.
 */

/** The oldest major version of Node this runner runs on, which `package.json`'s `engines` names too. */
export const nodeMajorMin = 24;

/**
 * Why this copy will not run on a Node, or nothing where it will. A version
 * that is not one is refused.
 *
 * @param {string} version this copy's
 * @param {string} nodeVersion the Node's, as `process.versions.node` says it
 * @param {string} node the Node binary
 * @returns {string | undefined}
 */
export function nodeRefusal(version, nodeVersion, node) {
  const major = Number(nodeVersion.split(".")[0]);
  if (major >= nodeMajorMin) return undefined;
  return `chuggy-linux ${version} needs Node ${String(nodeMajorMin)} or later; ${node} is Node ${nodeVersion}`;
}
