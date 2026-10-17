# chuggy-linux

Runs a chuggy worker pool's jobs on a Linux machine. Registered as a pool, the machine runs `chuggy-linux run` as a systemd user service: it polls chuggy for assignments and runs each one as a docker or podman container of the image the assignment pins.

It needs Linux with a systemd user session, Node 24 or later, and rootful docker or rootless podman 4.4 or later. Podman must be local: a remote client, set by `CONTAINER_HOST`, `CONTAINER_CONNECTION` or `remote = true` in `containers.conf`, is refused, since its service presents its own stored logins.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-linux/releases/download/v0.8.0/chuggy-linux-0.8.0.tgz
```

The tarball carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout.

It refuses to run on a Node below 24. A pool's service runs the copy that wrote its unit, under that copy's Node; `chuggy-linux --version` names a copy, and `doctor` warns where the service runs another.

## Register

Mint a registration token for the pool in chuggy, then:

```sh
chuggy-linux register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

This spends the token, declaring the machine's platform, `Platform:Linux:Amd64` or `Platform:Linux:Arm64`, and writes the pool file chuggy answers with to `~/.config/chuggy/pools/`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, mode 600.

A project's task can require capabilities rather than pin an image, such as `Agent:Claude` or `Tool:Bazel`, and is offered only to a pool declaring every one. Declare each this machine meets with `--capability <token>`, as often as needed; a token is letters, digits, `_`, `:` and `-`, and the platform is never one, since `register` finds it. The registration token must permit each, or chuggy refuses it and the token stays unspent. `--host` has jobs that pin no image run on this machine itself, which the pool file then says. How a job is then met is yours: see [The image a job runs in](#the-image-a-job-runs-in).

The pool takes the hostname's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. A pool is one per name in a project, so a second machine of the same name registering in the same project displaces the first: give one a `--pool`.

Once the file is written, `register` starts its service. Where every check `doctor` makes passes, it writes the file's unit as `install-service` does, runs `systemctl --user daemon-reload` and `systemctl --user enable --now` for it, and turns lingering on where that needs no password. The checks take as long as `doctor`'s do. Its first line on stdout says whether the service is running; where it stopped short, it prints why and the commands left. It exits 0 either way, since the token is spent.

Registering a pool again, from here or any machine, replaces its registration. chuggy denies the earlier one, so a service still running it stops, and stays stopped until it is restarted on the new file. Where the file's own unit here serves exactly that file and no 0.1 unit serves the pool, `register` writes it again as `install-service` does, then enables and restarts it and turns lingering on. Where a 0.1 unit serves the pool, from any file, such as `vteng-chuggy-shame.json`, it starts nothing and leaves that unit alone: retiring it and starting the pool's own is left to you, with the commands `install-service` prints. Registering another pool adds a file beside the first.

### A personal runner

A member's personal runner runs only that member's work, in the projects they allowlist for it in chuggy. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, then:

```sh
chuggy-linux register --api <chuggy's origin> --token=<token> --personal
```

It takes no `--pool`, and the file is named for the tenant and the member: `vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member.json`. A member has one personal runner in a tenant, so registering again, from here or any machine, replaces it as registering a pool again does. Every other command takes its file as it takes a pool's.

## Configure

**The pool file** is what registering the pool wrote, such as `~/.config/chuggy/pools/vteng.chuggy.shame.json`. Every command but `register` takes it as `--pool <file>`, or from `CHUGGY_LINUX_POOL`. It must be mode 600.

**The runner's file** is `~/.config/chuggy-linux/runner.json` (under `$XDG_CONFIG_HOME` when that is set). It must be mode 600, and a key it does not know is an error.

```json
{
  "engine": "docker",
  "concurrencyMax": 1,
  "sessionsMax": 2,
  "claudeTokenFile": "/home/you/.config/chuggy-linux/claude-token",
  "timeoutSecsMax": 7200,
  "outputBytesMax": 1048576,
  "environment": {},
  "network": "chuggy-jobs",
  "engineSocket": false,
  "images": []
}
```

| Key               | Required | Meaning                                                                                                    |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `engine`          | no       | `docker` (the default) or `podman`.                                                                        |
| `concurrencyMax`  | no       | Jobs each pool's service runs at once. Default 1.                                                          |
| `sessionsMax`     | no       | Sessions each pool's service runs at once besides its jobs; 0 runs none. Default 2.                        |
| `claudeTokenFile` | yes      | The file `claude setup-token`'s output was saved to, mode 600. It is mounted into each job, never read.     |
| `timeoutSecsMax`  | yes      | The longest a job may run; a job is killed at the sooner of this and its assignment's deadline.            |
| `outputBytesMax`  | yes      | The most output a job may report.                                                                          |
| `environment`     | no       | Variables handed to every job. `CHUG_WORKER_TASK`, `CHUG_WORKER_WORKSPACE`, `CHUGGY_HOST_JOB` and `CLAUDE_CODE_OAUTH_TOKEN` are the runner's, on a pool registered with `--host` so are `HOME` and `TMPDIR`, and with `engineSocket` so are those it sets. |
| `network`         | no       | The bridge network jobs join, made if missing. Default `chuggy-jobs`; never `host`.                        |
| `engineSocket`    | no       | `true` hands each job this machine's engine, below. Default `false`.                                       |
| `images`          | no       | The images a job that pins none runs in, below. Default none.                                              |

Each assignment's CPU and memory are checked against the whole machine, not what already runs on it, so a pool's service may run `concurrencyMax` jobs and `sessionsMax` sessions at once; set `sessionsMax` to 0 to run no sessions.

A session is a project's chat or lead, run on this machine's Claude login, and comes only from a project whose administrator routes Chat or Lead to Runners. It is run as a job is, with the same token file, environment and network, but is not held to `timeoutSecsMax`: it ends once idle, and is killed at its assignment's own deadline.

A job runs as uid 1000, the image's user, and reads the token file as that uid, so the file must be yours. Rootless podman maps that uid onto you. Docker runs it as this machine's uid 1000, so docker serves only a runner that is uid 1000, and refuses any other user: use rootless podman there. Rootless docker and docker with userns-remap are refused too, for the same reason: use rootful docker without userns-remap, or rootless podman. Docker must be local, reached through a unix socket by your current docker context.

With `engineSocket` on, each job, and never a session, is handed this machine's engine, so that its checks can start containers of their own, as testcontainers does. The engine's socket is mounted at `/var/run/docker.sock`, read-only, which limits nothing the engine will do; a docker job is added to the socket's group unless that is root's, and the job is told where the socket is by `DOCKER_HOST`, `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` and, on podman, `TESTCONTAINERS_HOST_OVERRIDE`, which `environment` may then not name. Podman's socket must be running: `systemctl --user enable --now podman.socket`. `doctor` names the socket and fails one a job cannot reach; where its owners and mode cannot settle it, as with a socket of root's group that only an ACL could open to a job, it warns.

Every job on this machine, and its agent, can then run anything the engine can; with rootful docker, that is root on this machine. That includes stopping or inspecting this machine's other jobs and sessions, and reading what every container here holds, its own included. Turn it on only on a machine whose every project you trust that far. The containers a job starts are left to testcontainers' own clean-up (Ryuk), so a killed job can leave them running. testcontainers for Rust needs docker: it does not work on rootless podman.

## The image a job runs in

A project's configuration names the image its jobs run in, by digest or by tag. An image already in this machine's engine is used as it is, so one built here with `docker build -t myproject:dev .` serves under that tag and is never pulled; a missing one is pulled. chuggy's runtime is got the same way, copied into a volume of the job's own and mounted read-only at `/opt/chuggy`, and the job starts through it in place of the image's `ENTRYPOINT` and `CMD`. So the image needs:

- `/bin/sh`, and `git` on `PATH`;
- glibc 2.28 or later with libstdc++, as a current Debian or Ubuntu has: an Alpine or other musl image cannot load the runtime;
- a `$HOME` and a temporary directory uid 1000 can write. The workspace is a volume this runner provides.

A task that pins no image names capabilities instead, and this runner meets them with what you give it in `runner.json`. With `images`, such a job runs in the first image listed declaring every capability it names, its platform aside, and is otherwise refused:

```json
"images": [{ "image": "ghcr.io/you/bazel:7", "capabilities": ["Agent:Claude", "Tool:Bazel"] }]
```

On a pool registered with `--host`, such a job of this machine's platform runs on this machine instead: as you, in a directory of its own under `~/.local/state/chuggy-linux/jobs/`, with its own `HOME` and temporary directory, the service's environment and `environment`, and `git` and its agent's command, such as `claude`, found on the service's `PATH`. That is systemd's for your user and not your shell's, so where `claude` is in `~/.local/bin`, name it in a drop-in: `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` under `[Service]`. Nothing isolates it. It can read and change whatever you can, the other jobs here among it, and reach whatever this machine reaches; register with `--host` only a machine whose every project you trust that far. A session, and a job that pins an image, still runs in a container. A host job is killed, with every process it started, at the sooner of `timeoutSecsMax` and its deadline, its log is saved beside a container's, and its directory is removed when it ends.

An image that lacks one is refused before any agent starts, and the ticket stops with a reason naming what is missing. An image the registry refuses is refused at once, and one that fails to pull any other way, such as from a host that does not resolve, after two minutes of trying.

A service the project's checks need, such as a database, is yours and never chuggy's: start it from a check inside the image, or run it here on the jobs' network and hand every job its address through `environment`. For PostgreSQL, once the runner has made its network (`podman run` on podman):

```sh
docker run -d --name jobs-postgres --network chuggy-jobs --restart unless-stopped \
  -e POSTGRES_HOST_AUTH_METHOD=trust docker.io/library/postgres:18
```

```json
"environment": { "DATABASE_URL": "postgres://postgres@jobs-postgres:5432/postgres" }
```

Every job this machine runs, of every pool, then reaches that one server.

## Check

```sh
chuggy-linux doctor --pool ~/.config/chuggy/pools/vteng.chuggy.shame.json
```

Its first line names the copy speaking and the Node it runs under. It checks both files, the token file, podman's credential helpers, whether the pool file's unit runs this copy, the engine, whether jobs are handed its socket, the job network, a token from the pool's issuer and one poll of the plane, and changes nothing. The poll is a long one, so the last check can take a while.

## Run as a service

`register` writes the unit and starts it itself where it can. Otherwise:

```sh
chuggy-linux install-service --pool ~/.config/chuggy/pools/vteng.chuggy.shame.json
```

This writes the pool file's own unit, `~/.config/systemd/user/chuggy-linux-vteng.chuggy.shame.service`, named for the file less `.json`, which runs this install's `chuggy-linux run` under the Node that installed it, and prints the `systemctl --user` commands that start it. It runs none of them. Each pool file has a unit of its own, so several pools run side by side; a unit of the name that serves another pool file is refused. The service restarts after any failure except the plane denying the pool (exit 3), which no restart would change. Run `install-service` again from the new copy after upgrading Node or moving the install; until then `doctor` warns that the service runs another.

chuggy-linux 0.1 wrote one unit for the machine, `~/.config/systemd/user/chuggy-linux.service`, and it keeps working after an upgrade. Where it serves the pool being installed, `install-service` prints the commands that stop and remove it before starting the pool's own. A pool's service refuses to start while another service of the pool runs, or while the old unit's service runs a pool file this runner cannot read, which may be the same pool. It cannot see a 0.1 runner started by hand rather than by that unit. Where the old unit serves another pool, it runs on beside the new unit. The containers it started are found by their labels, so `status` and `stop` still see them.

## Commands

| Command             | What it does                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `register`          | Redeems a registration token for a pool file, and starts its service where it can.                                                      |
| `run`               | The service: polls until the plane denies the pool.                                                                                     |
| `once`              | One poll, then waits for what it placed to start, and for a job on this machine itself to end. Refused while the pool's own service, or a 0.1 service known to serve the pool, runs. |
| `status`            | The runner's limits, this pool's containers, the service's jobs on this machine itself and what it is still pulling or starting, each named a job or a session. |
| `stop <assignment>` | Stops one assignment's container, through the service when it is running; a job on this machine itself only through the service. |
| `doctor`            | The checks above.                                                                                                                       |
| `install-service`   | Writes the pool's systemd user unit.                                                                                                    |

`once` renews nothing after it exits, so with no service running, the lease on what it placed lapses while the container keeps going. Nor does it while it waits for a job on this machine itself, whose lease lapses as it runs.

## What it does

- Places an assignment only if this machine has the CPU and memory it asks for, counted for that assignment alone, it pins an image, or one `images` lists or `--host` meets it, and the token file is usable; otherwise it refuses it, and chuggy sees the reason.
- Pulls a missing image from the registry the pool was registered for under the pool's own token, written for that one pull to a directory only you can read and removed after it. A refused token is replaced with a fresh one until the assignment's deadline. An image from any other registry is pulled once with no credential.
- Runs each job as uid 1000 through chuggy's runtime, mounted read-only, with every capability dropped, no privilege escalation, a process limit, the assignment's CPU and memory, the token file mounted read-only, and a workspace volume of its own. The job's credentials reach it through an env file that is deleted once the container starts.
- Keeps renewing an assignment while its image is still pulling, and finds the containers a previous run started.
- Saves an ended job's logs to `~/.local/state/chuggy-linux/logs/<container>.log` and removes the container with its workspace. A job that is stopped, or past its deadline, is killed first.
- Tells chuggy at once when a job ends without being stopped: its container exited, was killed at its deadline, or never started. chuggy is given the runner's own reason, such as `its container exited with status 1`, never the job's log, and a job that already reported keeps its report. Nothing is sent for a job stopped by chuggy or by `stop`.
- Labels a session's container a session, and tells chuggy when one ends without being stopped: `Succeeded` where its container exited 0, `Failed` however else it ended. A container with no such label, as every container before sessions has, is a job's.

## What it does not do

- Run an assignment that pins no image unless `images` or `--host` meets it: this runner has no image of its own.
- Check that a capability it declares is met: that is yours.
- Restrict a job's network: the bridge reaches whatever the machine reaches.
- Report a job's result: the job reports to chuggy itself.
- Install docker or podman, or upgrade itself.
- Pull with your own registry logins: an image not from the pool's registry is pulled with none. The exception is a credential helper you set in podman's `registries.conf`, which podman still asks; `doctor` warns of one. It reads the `registries.conf` your shell's environment names, while the service runs with systemd's (`systemctl --user show-environment`).
- Limit a job's workspace: its volume has no size limit.
