# chuggy-linux

Runs a chuggy worker pool's jobs on a Linux machine. Registered as a pool, the machine runs `chuggy-linux run` as a systemd user service: it polls chuggy for assignments and runs each one as a docker or podman container of the image the assignment pins.

It needs Linux with a systemd user session, Node 24 or later, and rootful docker or rootless podman 4.4 or later. Podman must be local: a remote client, set by `CONTAINER_HOST`, `CONTAINER_CONNECTION` or `remote = true` in `containers.conf`, is refused, since its service presents its own stored logins.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-linux/releases/download/v0.3.0/chuggy-linux-0.3.0.tgz
```

The tarball carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout.

## Register

Mint a registration token for the pool in chuggy, then:

```sh
chuggy-linux register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

This spends the token, declaring the machine's platform, `Platform:Linux:Amd64` or `Platform:Linux:Arm64`, and writes the pool file chuggy answers with to `~/.config/chuggy/pools/`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, mode 600.

The pool takes the hostname's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. A pool is one per name in a project, so a second machine of the same name registering in the same project displaces the first: give one a `--pool`.

Registering a pool again, from here or any machine, replaces its registration. chuggy denies the earlier one, so a service still running it stops, and stays stopped until it is restarted on the new file. `register` prints the restart for a unit here that serves exactly the file it wrote; a 0.1 unit serving the pool from a file of another name, such as `vteng-chuggy-shame.json`, is handed over by `install-service` instead. Registering another pool adds a file beside the first.

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
  "network": "chuggy-jobs"
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
| `environment`     | no       | Variables handed to every job. `CHUG_WORKER_TASK` and `CLAUDE_CODE_OAUTH_TOKEN` are the runner's to set.   |
| `network`         | no       | The bridge network jobs join, made if missing. Default `chuggy-jobs`; never `host`.                        |

Each assignment's CPU and memory are checked against the whole machine, not what already runs on it, so a pool's service may run `concurrencyMax` jobs and `sessionsMax` sessions at once; set `sessionsMax` to 0 to run no sessions.

A session is a project's chat or lead, run on this machine's Claude login, and comes only from a project whose administrator routes Chat or Lead to Runners. It is run as a job is, with the same token file, environment and network, but is not held to `timeoutSecsMax`: it ends once idle, and is killed at its assignment's own deadline.

A job runs as uid 1000, the image's user, and reads the token file as that uid, so the file must be yours. Rootless podman maps that uid onto you. Docker runs it as this machine's uid 1000, so docker serves only a runner that is uid 1000, and refuses any other user: use rootless podman there. Rootless docker and docker with userns-remap are refused too, for the same reason: use rootful docker without userns-remap, or rootless podman. Docker must be local, reached through a unix socket by your current docker context.

## Check

```sh
chuggy-linux doctor --pool ~/.config/chuggy/pools/vteng.chuggy.shame.json
```

It checks both files, the token file, podman's credential helpers, the engine, the job network, a token from the pool's issuer and one poll of the plane, and changes nothing. The poll is a long one, so the last check can take a while.

## Run as a service

```sh
chuggy-linux install-service --pool ~/.config/chuggy/pools/vteng.chuggy.shame.json
```

This writes the pool file's own unit, `~/.config/systemd/user/chuggy-linux-vteng.chuggy.shame.service`, named for the file less `.json`, which runs this install's `chuggy-linux run` under the Node that installed it, and prints the `systemctl --user` commands that start it. It runs none of them. Each pool file has a unit of its own, so several pools run side by side; a unit of the name that serves another pool file is refused. The service restarts after any failure except the plane denying the pool (exit 3), which no restart would change. Run `install-service` again after upgrading Node or moving the install.

chuggy-linux 0.1 wrote one unit for the machine, `~/.config/systemd/user/chuggy-linux.service`, and it keeps working after an upgrade. Where it serves the pool being installed, `install-service` prints the commands that stop and remove it before starting the pool's own. A pool's service refuses to start while another service of the pool runs, or while the old unit's service runs a pool file this runner cannot read, which may be the same pool. It cannot see a 0.1 runner started by hand rather than by that unit. Where the old unit serves another pool, it runs on beside the new unit. The containers it started are found by their labels, so `status` and `stop` still see them.

## Commands

| Command             | What it does                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `register`          | Redeems a registration token for a pool file.                                                                                           |
| `run`               | The service: polls until the plane denies the pool.                                                                                     |
| `once`              | One poll, then waits for what it placed to start. Refused while the pool's own service, or a 0.1 service known to serve the pool, runs. |
| `status`            | The runner's limits, this pool's containers and what the service is still pulling or starting, each named a job or a session.           |
| `stop <assignment>` | Stops one assignment's container, through the service when it is running.                                                               |
| `doctor`            | The checks above.                                                                                                                       |
| `install-service`   | Writes the pool's systemd user unit.                                                                                                    |

`once` renews nothing after it exits, so with no service running, the lease on what it placed lapses while the container keeps going.

## What it does

- Places an assignment only if this machine has the CPU and memory it asks for, counted for that assignment alone, it pins an image, and the token file is usable; otherwise it refuses it, and chuggy sees the reason.
- Pulls a missing image from the registry the pool was registered for under the pool's own token, written for that one pull to a directory only you can read and removed after it. A refused token is replaced with a fresh one until the assignment's deadline. An image from any other registry is pulled once with no credential.
- Runs each job as uid 1000 with every capability dropped, no privilege escalation, a process limit, the assignment's CPU and memory, the token file mounted read-only, and a workspace volume of its own. The job's credentials reach it through an env file that is deleted once the container starts.
- Keeps renewing an assignment while its image is still pulling, and finds the containers a previous run started.
- Saves an ended job's logs to `~/.local/state/chuggy-linux/logs/<container>.log` and removes the container with its workspace. A job that is stopped, or past its deadline, is killed first.
- Tells chuggy at once when a job ends without being stopped: its container exited, was killed at its deadline, or never started. chuggy is given the runner's own reason, such as `its container exited with status 1`, never the job's log, and a job that already reported keeps its report. Nothing is sent for a job stopped by chuggy or by `stop`.
- Labels a session's container a session, and tells chuggy when one ends without being stopped: `Succeeded` where its container exited 0, `Failed` however else it ended. A container with no such label, as every container before sessions has, is a job's.

## What it does not do

- Run an assignment that names capabilities rather than an image: this runner has no image of its own.
- Restrict a job's network: the bridge reaches whatever the machine reaches.
- Report a job's result: the job reports to chuggy itself.
- Install docker or podman, start the service, or upgrade itself.
- Pull with your own registry logins: an image not from the pool's registry is pulled with none. The exception is a credential helper you set in podman's `registries.conf`, which podman still asks; `doctor` warns of one. It reads the `registries.conf` your shell's environment names, while the service runs with systemd's (`systemctl --user show-environment`).
- Limit a job's workspace: its volume has no size limit.
