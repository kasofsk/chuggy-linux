# chuggy-linux

Runs a chuggy worker pool's jobs on a Linux machine. Registered as a pool, the machine runs `chuggy-linux run` as a systemd user service: it polls chuggy for assignments and runs each one as a docker or podman container of the image the assignment pins.

It needs Linux with a systemd user session, Node 24 or later, and rootful docker or rootless podman 4.4 or later.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-linux/releases/download/v0.1.0/chuggy-linux-0.1.0.tgz
```

The tarball carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout.

## Configure

**The pool file** is what registering the pool wrote, such as `~/.config/chuggy/pools/vteng-chuggy-shame.json`. Every command takes it as `--pool <file>`, or from `CHUGGY_LINUX_POOL`. It must be mode 600.

**The runner's file** is `~/.config/chuggy-linux/runner.json` (under `$XDG_CONFIG_HOME` when that is set). It must be mode 600, and a key it does not know is an error.

```json
{
  "engine": "docker",
  "concurrencyMax": 1,
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
| `concurrencyMax`  | no       | Jobs run at once. Default 1.                                                                               |
| `claudeTokenFile` | yes      | The file `claude setup-token`'s output was saved to, mode 600. It is mounted into each job, never read.     |
| `timeoutSecsMax`  | yes      | The longest a job may run; a job is killed at the sooner of this and its assignment's deadline.            |
| `outputBytesMax`  | yes      | The most output a job may report.                                                                          |
| `environment`     | no       | Variables handed to every job. `CHUG_WORKER_TASK` and `CLAUDE_CODE_OAUTH_TOKEN` are the runner's to set.   |
| `network`         | no       | The bridge network jobs join, made if missing. Default `chuggy-jobs`; never `host`.                        |

A job runs as uid 1000, the image's user, and reads the token file as that uid, so the file must be yours. Rootless podman maps that uid onto you. Docker runs it as this machine's uid 1000, so docker serves only a runner that is uid 1000, and refuses any other user: use rootless podman there. Rootless docker and docker with userns-remap are refused too, for the same reason: use rootful docker without userns-remap, or rootless podman. Docker must be local, reached through a unix socket by your current docker context.

## Check

```sh
chuggy-linux doctor --pool ~/.config/chuggy/pools/vteng-chuggy-shame.json
```

It checks both files, the token file, podman's credential helpers, the engine, the job network, a token from the pool's issuer and one poll of the plane, and changes nothing. The poll is a long one, so the last check can take a while.

## Run as a service

```sh
chuggy-linux install-service --pool ~/.config/chuggy/pools/vteng-chuggy-shame.json
```

This writes `~/.config/systemd/user/chuggy-linux.service`, which runs this install's `chuggy-linux run` under the Node that installed it, and prints the `systemctl --user` commands that start it. It runs none of them. The service restarts after any failure except the plane denying the pool (exit 3), which no restart would change. Run `install-service` again after upgrading Node or moving the install.

## Commands

| Command             | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| `run`               | The service: polls until the plane denies the pool.                                  |
| `once`              | One poll, then waits for what it placed to start. Refused while the service runs.    |
| `status`            | This pool's containers, and what the service is still pulling or starting.          |
| `stop <assignment>` | Stops one assignment's container, through the service when it is running.          |
| `doctor`            | The checks above.                                                                    |
| `install-service`   | Writes the systemd user unit.                                                        |

`once` renews nothing after it exits, so with no service running, the lease on what it placed lapses while the container keeps going.

## What it does

- Places an assignment only if this machine has the CPU and memory it asks for, it pins an image, and the token file is usable; otherwise it refuses it, and chuggy sees the reason.
- Pulls a missing image from the registry the pool was registered for under the pool's own token, written for that one pull to a directory only you can read and removed after it. A refused token is replaced with a fresh one until the assignment's deadline. An image from any other registry is pulled once with no credential.
- Runs each job as uid 1000 with every capability dropped, no privilege escalation, a process limit, the assignment's CPU and memory, the token file mounted read-only, and a workspace volume of its own. The job's credentials reach it through an env file that is deleted once the container starts.
- Keeps renewing an assignment while its image is still pulling, and finds the containers a previous run started.
- Saves an ended job's logs to `~/.local/state/chuggy-linux/logs/<container>.log` and removes the container with its workspace. A job past its deadline is killed first.

## What it does not do

- Run an assignment that names capabilities rather than an image: this runner has no image of its own.
- Restrict a job's network: the bridge reaches whatever the machine reaches.
- Report a job's result: the job reports to chuggy itself.
- Install docker or podman, start the service, or upgrade itself.
- Pull with your own registry logins: an image not from the pool's registry is pulled with none. The exception is a credential helper you set in podman's `registries.conf`, which podman still asks; `doctor` warns of one.
- Limit a job's workspace: its volume has no size limit.
