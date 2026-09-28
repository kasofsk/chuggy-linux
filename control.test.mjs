import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { controlAsked, controlServer, controlSocketPath } from "./control.mjs";

/** @param {import("node:test").TestContext} t */
async function served(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  /** @type {string[]} */
  const stopped = [];
  const backend =
    /** @type {import("./containerBackend.mjs").ContainerBackend} */ (
      /** @type {unknown} */ ({
        inFlight: () => [
          {
            assignment: "asg-1",
            name: "chuggy-shame-x",
            image: "i",
            phase: "Pulling",
            deadlineEpochSecs: 1,
          },
        ],
        stop: async (/** @type {string} */ assignment) => {
          stopped.push(assignment);
          return { stopped: "Stopped" };
        },
      })
    );
  const path = controlSocketPath(directory);
  const server = await controlServer(path, backend);
  t.after(() => server.close());
  return { path, stopped, backend };
}

test("the service answers what it is placing", async (t) => {
  const { path } = await served(t);
  assert.deepEqual(await controlAsked(path, { op: "status" }), {
    inFlight: [
      {
        assignment: "asg-1",
        name: "chuggy-shame-x",
        image: "i",
        phase: "Pulling",
        deadlineEpochSecs: 1,
      },
    ],
  });
});

test("a stop asked of the service is its backend's stop", async (t) => {
  const { path, stopped } = await served(t);
  assert.deepEqual(
    await controlAsked(path, { op: "stop", assignment: "asg-1" }),
    { stopped: "Stopped" },
  );
  assert.deepEqual(stopped, ["asg-1"]);
});

test("a line that is no request is refused", async (t) => {
  const { path, stopped } = await served(t);
  const answer = await new Promise((resolve) => {
    const socket = createConnection(path, () =>
      socket.write('{"op":"stop"}\n'),
    );
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve(JSON.parse(text)));
  });
  assert.deepEqual(answer, { refused: "not a request this service answers" });
  assert.deepEqual(stopped, []);
});

test("nothing answers where no service is", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(
    await controlAsked(controlSocketPath(directory), { op: "status" }),
    undefined,
  );
});

test("a second service is refused where one answers, and a dead one's socket is replaced", async (t) => {
  const { path, backend } = await served(t);
  await assert.rejects(
    controlServer(path, backend),
    /a chuggy-linux service already answers at/u,
  );

  const directory = await mkdtemp(join(tmpdir(), "chuggy-linux-control-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stale = controlSocketPath(directory);
  await writeFile(stale, "");
  const server = await controlServer(stale, backend);
  t.after(() => server.close());
  assert.deepEqual(
    await controlAsked(stale, { op: "stop", assignment: "asg-2" }),
    { stopped: "Stopped" },
  );
});
