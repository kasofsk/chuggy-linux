import assert from "node:assert/strict";
import test from "node:test";

import {
  dockerContextArgv,
  dockerInfoArgv,
  imageInspectArgv,
  podmanRemoteArgv,
  podmanVersionArgv,
  inspectArgv,
  killArgv,
  listArgv,
  logsArgv,
  networkCreateArgv,
  networkInspectArgv,
  pullArgv,
  removeArgv,
  runArgv,
} from "./engineArgv.mjs";

const image = `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`;

const job = {
  name: "chuggy-shame-0123456789abcdef0123",
  pool: "vteng/chuggy/shame",
  assignment: "asg-1",
  deadlineEpochSecs: 1_800_003_600,
  envFile: "/run/user/1000/chuggy-linux/job-x/env",
  cpuMillis: 1500,
  memoryMib: 4096,
  tokenFile: "/home/op/.config/chuggy-linux/claude-token",
  network: "chuggy-jobs",
  image,
};

/** Everything before the user mapping, the same for both engines. */
const runHead = [
  "run",
  "-d",
  "--pull=never",
  "--name",
  "chuggy-shame-0123456789abcdef0123",
  "--label",
  "io.chuggy.pool=vteng/chuggy/shame",
  "--label",
  "io.chuggy.assignment=asg-1",
  "--label",
  "io.chuggy.deadline=1800003600",
  "--env-file",
  "/run/user/1000/chuggy-linux/job-x/env",
  "--user",
  "1000:1000",
];

/** Everything after it, up to the minted tmpfs. */
const runLimits = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "4096",
  "--cpus",
  "1.5",
  "--memory",
  "4096m",
  "--mount",
  "type=bind,source=/home/op/.config/chuggy-linux/claude-token,target=/var/run/chuggy/credentials/claude-code,readonly",
  "--tmpfs",
];

/** Everything after the minted tmpfs. */
const runTail = ["--volume", "/workspace", "--network", "chuggy-jobs", image];

test("docker runs a job as the image's user, with nothing mapped", () => {
  assert.deepEqual(runArgv("docker", job), [
    ...runHead,
    ...runLimits,
    "/var/run/chuggy/minted:rw,nosuid,nodev,noexec,size=1m,uid=1000,gid=1000,mode=0700",
    ...runTail,
  ]);
});

test("podman runs a job as the image's user, mapped onto the one running podman", () => {
  assert.deepEqual(runArgv("podman", job), [
    ...runHead,
    "--userns=keep-id:uid=1000,gid=1000",
    ...runLimits,
    "/var/run/chuggy/minted:rw,nosuid,nodev,noexec,size=1m,mode=0700,U",
    ...runTail,
  ]);
});

test("each engine is told the minted tmpfs's owner in the words it accepts, and never the other's", () => {
  /** @param {"docker" | "podman"} engine */
  const options = (engine) => {
    const argv = runArgv(engine, job);
    return argv[argv.indexOf("--tmpfs") + 1].split(":")[1].split(",");
  };
  assert.ok(options("docker").includes("uid=1000"));
  assert.ok(options("docker").includes("gid=1000"));
  assert.ok(!options("docker").includes("U"));
  assert.ok(options("podman").includes("U"));
  assert.ok(!options("podman").some((option) => /^[ug]id=/u.test(option)));
});

test("docker reads a pull's credential from DOCKER_CONFIG and its endpoint from DOCKER_HOST, podman from --authfile", () => {
  assert.deepEqual(
    pullArgv(
      "docker",
      image,
      "/run/user/1000/chuggy-linux/pull-x",
      "unix:///run/user/1000/docker.sock",
    ),
    {
      argv: ["pull", "--quiet", image],
      environment: {
        DOCKER_CONFIG: "/run/user/1000/chuggy-linux/pull-x",
        DOCKER_HOST: "unix:///run/user/1000/docker.sock",
        DOCKER_AUTH_CONFIG: "",
      },
    },
  );
  assert.throws(
    () => pullArgv("docker", image, "/run/user/1000/chuggy-linux/pull-x"),
    /a docker pull needs the endpoint its context names/u,
  );
  assert.deepEqual(
    pullArgv("podman", image, "/run/user/1000/chuggy-linux/pull-x"),
    {
      argv: [
        "pull",
        "--quiet",
        "--authfile",
        "/run/user/1000/chuggy-linux/pull-x/config.json",
        image,
      ],
      environment: {},
    },
  );
});

test("every other call is handed to either engine as this argv", () => {
  assert.deepEqual(
    [
      imageInspectArgv(image),
      listArgv("vteng/chuggy/shame"),
      inspectArgv(["c1", "c2"]),
      killArgv("c1"),
      logsArgv("c1"),
      removeArgv("c1", { force: false }),
      removeArgv("chuggy-shame-0123456789abcdef0123", { force: true }),
      networkInspectArgv("chuggy-jobs"),
      networkCreateArgv("chuggy-jobs"),
      dockerInfoArgv(),
      dockerContextArgv(),
      podmanVersionArgv(),
      podmanRemoteArgv(),
    ],
    [
      ["image", "inspect", "--format", "{{.Id}}", image],
      [
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        "label=io.chuggy.pool=vteng/chuggy/shame",
      ],
      ["container", "inspect", "c1", "c2"],
      ["kill", "c1"],
      ["logs", "c1"],
      ["rm", "-v", "c1"],
      ["rm", "-f", "-v", "chuggy-shame-0123456789abcdef0123"],
      ["network", "inspect", "chuggy-jobs"],
      ["network", "create", "chuggy-jobs"],
      ["info", "--format", "{{json .SecurityOptions}}"],
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      ["version", "--format", "{{.Client.Version}}"],
      ["info", "--format", "{{.Host.ServiceIsRemote}}"],
    ],
  );
});
