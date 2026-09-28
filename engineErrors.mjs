/**
 * What an engine's failure was, read off its stderr in this one place. Docker
 * and podman word the same failures differently, and the suite holds each
 * class to the words both engines were seen to print.
 */

/**
 * @typedef {import("./engine.mjs").EngineAnswer} EngineAnswer
 *
 * @typedef {"Unreachable" | "NoSuchContainer" | "NameConflict" | "Unauthorized" | "NotFound" | "Other"} EngineFailure
 */

const engineFailures = /** @type {const} */ ([
  [
    "Unreachable",
    /cannot connect to the docker daemon|permission denied while trying to connect to the docker daemon|cannot connect to podman/iu,
  ],
  ["NoSuchContainer", /no such container/iu],
  ["NameConflict", /is already in use/iu],
  [
    "Unauthorized",
    /unauthorized|authentication required|no basic auth credentials/iu,
  ],
  ["NotFound", /no such image|image not known|manifest unknown|not found/iu],
]);

/**
 * An engine that could not be started or did not answer is unreachable
 * whatever it printed.
 *
 * @param {EngineAnswer} answer
 * @returns {EngineFailure}
 */
export function engineFailure(answer) {
  if (answer.failed !== undefined) return "Unreachable";
  for (const [failure, words] of engineFailures)
    if (words.test(answer.stderr)) return failure;
  return "Other";
}

/** A daemon's error can quote a whole request, which a log line does not need. */
const failureLineCharsMax = 300;

/**
 * The line of a failure worth logging: the first naming an error, since podman
 * says what it is trying before it says what failed, else the first at all.
 *
 * @param {EngineAnswer} answer
 */
export function engineFailureLine(answer) {
  const lines = answer.stderr
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  const line =
    lines.find((text) => /error/iu.test(text)) ??
    lines[0] ??
    `exit ${String(answer.code)}`;
  return line.length > failureLineCharsMax
    ? `${line.slice(0, failureLineCharsMax)}…`
    : line;
}
