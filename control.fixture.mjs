/**
 * A service answering on a control socket for a suite that asks it: its
 * backend is placing one assignment, and stops whatever it is asked to.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { controlServer } from "./control.mjs";

/** @type {import("./containerBackend.mjs").InFlightPlacement} */
export const inFlightFixture = {
  assignment: "asg-1",
  kind: "Session",
  name: "chuggy-shame-x",
  image: "i",
  phase: "Pulling",
  deadlineEpochSecs: 1,
};

/**
 * @param {import("node:test").TestContext} t
 * @param {string} socket
 */
export async function controlServed(t, socket) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  /** @type {string[]} */
  const stopped = [];
  const backend =
    /** @type {import("./containerBackend.mjs").ContainerBackend} */ (
      /** @type {unknown} */ ({
        inFlight: () => [inFlightFixture],
        stop: async (/** @type {string} */ assignment) => {
          stopped.push(assignment);
          return { stopped: "Stopped" };
        },
      })
    );
  const server = await controlServer(socket, backend);
  t.after(() => server.close());
  return { stopped, backend };
}
