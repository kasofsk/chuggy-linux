/**
 * Every stderr below is what docker 28.1 or podman 5.8 printed for the failure
 * it is filed under, copied from a run of each against a daemon, and a local
 * registry that challenged for credentials.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { engineFailure, engineFailureLine } from "./engineErrors.mjs";

const digest = `sha256:${"0".repeat(64)}`;

const printed = {
  Unreachable: [
    "Cannot connect to the Docker daemon at unix:///nonexistent/docker.sock. Is the docker daemon running?",
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.49/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
    'Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`, or try `podman machine init` and `podman machine start` to manage a new Linux VM\nError: unable to connect to Podman socket: Get "http://d/v5.8.7/libpod/_ping": dial unix /nonexistent/podman.sock: connect: no such file or directory: unix:///nonexistent/podman.sock',
  ],
  NoSuchContainer: [
    "Error response from daemon: No such container: chuggy-linux-probe-absent",
    "Error response from daemon: cannot kill container: chuggy-linux-probe-absent: No such container: chuggy-linux-probe-absent",
    'Error: no such container "chuggy-linux-probe-absent"',
    'Error: no container with ID or name "chuggy-linux-probe-absent" found: no such container',
    'Error: no container with name or ID "chuggy-linux-probe-absent" found: no such container',
  ],
  NameConflict: [
    'docker: Error response from daemon: Conflict. The container name "/chuggy-linux-probe-conflict" is already in use by container "fe97585ba1aa2ae3c309f0851f48ff35ac3ca7f3e3d17bcb7c504e2ae5691c31". You have to remove (or rename) that container to be able to reuse that name.\n\nRun \'docker run --help\' for more information',
    'Error: creating container storage: the container name "chuggy-linux-probe-conflict" is already in use by ab5a3a462f4584914e637e786a3d38444bb903d3a94af0c392460ecfa3a8f330. You have to remove that container to be able to reuse that name: that name is already in use, or use --replace to instruct Podman to do so.',
  ],
  Unauthorized: [
    "Error response from daemon: unauthorized: unauthorized",
    `Error response from daemon: Get "http://localhost:5999/v2/chuggy/worker/manifests/${digest}": no basic auth credentials`,
    `Trying to pull localhost:5999/chuggy/worker@${digest}...\nError: unable to copy from source docker://localhost:5999/chuggy/worker@${digest}: initializing source docker://localhost:5999/chuggy/worker@${digest}: reading manifest ${digest} in localhost:5999/chuggy/worker: authentication required`,
  ],
  NotFound: [
    "Error response from daemon: No such image: chuggy-linux-probe-absent:1",
    "Error: chuggy-linux-probe-absent:1: image not known",
    "Error response from daemon: manifest for busybox:chuggy-linux-probe-absent not found: manifest unknown: manifest unknown",
    "Trying to pull docker.io/library/busybox:chuggy-linux-probe-absent...\nError: unable to copy from source docker://busybox:chuggy-linux-probe-absent: initializing source docker://busybox:chuggy-linux-probe-absent: reading manifest chuggy-linux-probe-absent in docker.io/library/busybox: manifest unknown",
    "Error response from daemon: network chuggy-linux-probe-absent not found",
    "Error: network chuggy-linux-probe-absent: unable to find network with name or ID chuggy-linux-probe-absent: network not found",
    `docker: Error response from daemon: No such image: chuggy.invalid/absent@${digest}\n\nRun 'docker run --help' for more information`,
  ],
  Other: [
    `Error response from daemon: Get "https://ghcr.io/v2/kasofsk/chuggy-linux-probe-absent/manifests/${digest}": denied: denied`,
  ],
};

for (const [failure, stderrs] of Object.entries(printed))
  test(`what the engines print for ${failure} is read as ${failure}`, () => {
    for (const stderr of stderrs)
      assert.equal(
        engineFailure({ code: 1, stdout: "", stderr: `${stderr}\n` }),
        failure,
        stderr,
      );
  });

test("an engine that did not start or did not answer is unreachable whatever it printed", () => {
  for (const failed of /** @type {const} */ (["Unstarted", "Interrupted"]))
    assert.equal(
      engineFailure({
        code: -1,
        stdout: "",
        stderr: "No such container: x",
        failed,
      }),
      "Unreachable",
    );
});

test("the line logged is the first naming an error, bounded", () => {
  const podman = printed.Unauthorized[2];
  assert.match(
    engineFailureLine({ code: 125, stdout: "", stderr: podman }),
    /^Error: unable to copy from source /u,
  );
  const long = engineFailureLine({ code: 125, stdout: "", stderr: podman });
  assert.ok(long.length <= 301 && long.endsWith("…"), long);
  assert.equal(
    engineFailureLine({ code: 1, stdout: "", stderr: "\n  quiet failure  \n" }),
    "quiet failure",
  );
  assert.equal(
    engineFailureLine({ code: 7, stdout: "", stderr: "" }),
    "exit 7",
  );
});
