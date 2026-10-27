# chuggy-linux

Runs a chuggy worker pool's jobs on a Linux machine. Registered as a pool, the machine runs `chuggy-linux run` as a systemd user service: it polls chuggy for assignments and runs each one as a docker or podman container of the image the assignment pins.

It needs Linux with a systemd user session, Node 24 or later, and rootful docker or rootless podman 4.3 or later. Podman must be local: a remote client, set by `CONTAINER_HOST`, `CONTAINER_CONNECTION` or `remote = true` in `containers.conf`, is refused, since its service may be on another machine and would mount a job's files from there.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-linux/releases/download/v0.30.0/chuggy-linux-0.30.0.tgz
```

The tarball carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout. Install it as the user it will run as, under a prefix that user can write, such as nvm's, so that it can [update itself](#updates).

It refuses to run on a Node below 24. A pool's service runs the copy that wrote its unit, under that copy's Node; `chuggy-linux --version` names a copy, and `doctor` warns where the service runs another.

## Register

Mint a registration token for the pool in chuggy, then:

```sh
chuggy-linux register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

This spends the token, declaring the machine's platform, `Platform:Linux:Amd64` or `Platform:Linux:Arm64`, and writes the pool file chuggy answers with to `~/.config/chuggy/pools/`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, mode 600.

A project's task can require capabilities rather than pin an image, such as `Agent:Claude` or `Tool:Bazel`, and is offered only to a pool advertising every one. `register` declares the agents runner.json can run, so write [runner.json](#configure) first: `Agent:Claude` for its Claude credential and `Agent:Codex` for its `codexCredential`, each where an `images` entry declares it or the pool is registered with `--host`; where it cannot read runner.json, it says so and declares none. Declare anything else this machine meets with `--capability <token>`, as often as needed; a token is letters, digits, `_`, `:` and `-`, and the platform is never one, since `register` finds it. `--host` has jobs that pin no image run on this machine itself, which the pool file then says. How a job is then met is yours: see [The image a job runs in](#the-image-a-job-runs-in).

From 0.27.0 the pool's service advertises on every poll what it finds when it starts, in place of what the pool was registered with: this machine's platform, the agents runner.json can run, found as `register` finds them, and runner.json's `capabilities` or, where it is absent, the rest of what the pool was registered with, less any agent it has no image or host to run. So an edit to runner.json's `images`, credentials or `capabilities` takes effect when the service restarts; register again only for a new machine or pool, or to replace a registration. An earlier copy refuses a runner.json naming `capabilities`, so check `chuggy-linux --version` before writing it.

The pool takes the hostname's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. A pool is one per name in a project, so a second machine of the same name registering in the same project displaces the first: give one a `--pool`.

Once the file is written, `register` starts its service. Where every check `doctor` makes passes, it writes the file's unit as `install-service` does, runs `systemctl --user daemon-reload` and `systemctl --user enable --now` for it, and turns lingering on where that needs no password. The checks take as long as `doctor`'s do. Its first line on stdout says whether the service is running; where it stopped short, it prints why and the commands left. It exits 0 either way, since the token is spent.

Registering a pool again, from here or any machine, replaces its registration. chuggy denies the earlier one, so a service still running it stops, and stays stopped until it is restarted on the new file. Where the file's own unit here serves exactly that file and no 0.1 unit serves the pool, `register` writes it again as `install-service` does, then enables and restarts it and turns lingering on. Where a 0.1 unit serves the pool, from any file, such as `vteng-chuggy-shame.json`, it starts nothing and leaves that unit alone: retiring it and starting the pool's own is left to you, with the commands `install-service` prints. Registering another pool adds a file beside the first.

### A personal runner

A member's personal runner runs only that member's work, in the projects they allowlist for it in chuggy. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, then:

```sh
chuggy-linux register --api <chuggy's origin> --token=<token> --personal
```

It takes no `--pool`, and the file is named for the tenant and the member: `vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member.json`. A member may register a personal runner on each of their machines, and every one serves the same projects. Registering again here writes this machine's file over and restarts its service on it; the registration it held before stays in chuggy, offline, until its member removes it in chuggy's console. Every other command takes its file as it takes a pool's.

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
  "images": [],
  "volumes": [],
  "pools": {},
  "autoUpdate": true,
  "imageUnusedSecsMax": 604800,
  "diskFreeGibMin": 20,
  "memoryFreeGibMin": 0,
  "memoryReservedGib": 0
}
```

| Key                | Required | Meaning                                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `engine`           | no       | `docker` (the default) or `podman`.                                                                        |
| `concurrencyMax`   | no       | Jobs each pool's service runs at once; 0 (0.18.0 or later) runs none, for a runner kept for sessions. Default 1. |
| `sessionsMax`      | no       | Sessions each pool's service runs at once besides its jobs; 0 runs none. Default 2.                        |
| `claudeTokenFile`  | one of   | The file `claude setup-token`'s output was saved to, mode 600: a Claude subscription's token.              |
| `claudeCredential` | one of   | The credential Claude Code runs on, of any kind, below, in place of `claudeTokenFile`.                     |
| `codexCredential`  | no       | `{ "authFile": … }`, the `auth.json` Codex runs on, below; 0.25.0 or later. Default none.                 |
| `capabilities`     | no       | What this machine meets beside its platform and agents, which each pool's service advertises in place of what `--capability` declared; never a platform, each once; 0.27.0 or later. Where it is absent, each advertises the rest of what its pool was registered with. |
| `timeoutSecsMax`   | yes      | The longest a job may run; a job is killed at the sooner of this and its assignment's deadline.            |
| `outputBytesMax`   | yes      | The most output a job may report.                                                                          |
| `environment`      | no       | Variables handed to every job. `CHUG_WORKER_TASK`, `CHUG_WORKER_WORKSPACE`, `CHUGGY_HOST_JOB`, `CLAUDE_CODE_OAUTH_TOKEN`, `CHUG_WORKER_CLAUDE_CREDENTIAL`, and the job's `CHUG_TENANT`, `CHUG_PROJECT`, `CHUG_REPOSITORY`, `CHUG_TICKET`, `CHUG_ATTEMPT` and `CHUG_STAGE` are the runner's, on a pool registered with `--host` so are `HOME` and `TMPDIR`, and with `engineSocket` so are those it sets. |
| `network`          | no       | The bridge network jobs join, made if missing. Default `chuggy-jobs`; never `host`.                        |
| `engineSocket`     | no       | `true` hands each job this machine's engine, below. Default `false`.                                       |
| `images`           | no       | The images a job that pins none runs in, below. Default none.                                              |
| `volumes`          | no       | Named volumes and directories of this machine mounted into every job, below. Default none.                 |
| `pools`            | no       | A pool's own `concurrencyMax` and `sessionsMax`, by its pool file's name, below; 0.18.0 or later. Default none. |
| `autoUpdate`       | no       | `false` stops the service updating itself; see [Updates](#updates). Default `true`.                        |
| `imageUnusedSecsMax` | no     | How long a job's image this runner pulled may go unused before it is removed; 0 keeps them until the disk is under `diskFreeGibMin`. Default a week, 604800. |
| `diskFreeGibMin`   | no       | The GiB the engine's storage keeps free, below; 0 keeps no floor; 0.23.0 or later. Default 20.             |
| `memoryFreeGibMin` | no       | The GiB of the engine's memory its containers leave free for the engine and its machine, below; 0.29.0 or later. Default 0, which makes all of it the budget. |
| `memoryReservedGib` | no      | The GiB of the memory budget no job may ask, kept for what always runs beside the jobs, below; 0.31.0 or later. Default 0, which lets a job ask the whole budget. |

Each assignment's CPU and memory are checked against the whole machine, not what already runs on it, so a pool's service may run `concurrencyMax` jobs and `sessionsMax` sessions at once; a job also starts only into the room the memory budget below leaves. Set `sessionsMax` to 0 to run no sessions, or `concurrencyMax` to 0 to run sessions alone, as a runner kept for a project's lead does; a file setting both to 0 is refused, since that runner would take no work. A job no runner has room for waits until one has.

`pools` sets one pool's service apart from the rest. It is keyed by the pool file's name without `.json`, as `register` wrote it, and each limit it names replaces the file's for that service alone; one leaving that service 0 jobs and 0 sessions is refused. A personal runner that takes jobs beside a project's pool kept for its lead:

```json
"concurrencyMax": 2,
"pools": { "vteng.chuggy.lead": { "concurrencyMax": 0, "sessionsMax": 1 } }
```

The pool `vteng.chuggy.lead.json` runs one session and no job, and every other pool's service, the personal runner's among them, runs two jobs and two sessions. A pool's service reads this file when it starts, so restart the service after an edit: `status` and `doctor` print the limits the file now gives the pool they are given, not those its running service holds. `doctor` warns of an entry naming no file in `~/.config/chuggy/pools`, where `register` writes each pool file.

A `concurrencyMax` of 0 and `pools` need chuggy-linux 0.18.0 or later: an earlier copy refuses the file, and its service fails before it reaches the update that would read it, so check `chuggy-linux --version` before writing either.

A session is a project's chat or lead, run on this machine's Claude credential, and comes only from a project whose administrator routes Chat or Lead to Runners. It is run as a job is, with the same credential, environment and network, but is not held to `timeoutSecsMax`: it ends once idle, and is killed at its assignment's own deadline.

**The Claude credential** is one file, mode 600 and yours, and the settings its kind needs. `claudeTokenFile` names a subscription's token; `claudeCredential` names a credential of any kind instead, and a file names one or the other:

```json
"claudeCredential": { "kind": "Subscription", "tokenFile": "/home/you/.config/chuggy-linux/claude-token" }
"claudeCredential": { "kind": "ApiKey", "apiKeyFile": "/home/you/.config/chuggy-linux/anthropic-api-key" }
"claudeCredential": { "kind": "Bedrock", "region": "us-west-2", "apiKeyFile": "/home/you/.config/chuggy-linux/bedrock-api-key" }
"claudeCredential": { "kind": "Bedrock", "region": "us-west-2", "credentialsFile": "/home/you/.config/chuggy-linux/aws-credentials", "profile": "chuggy" }
"claudeCredential": { "kind": "Vertex", "region": "us-east5", "project": "your-project", "credentialsFile": "/home/you/.config/chuggy-linux/vertex-key.json" }
"claudeCredential": { "kind": "Foundry", "resource": "your-resource", "apiKeyFile": "/home/you/.config/chuggy-linux/foundry-api-key" }
```

- **Subscription**: `claude setup-token`'s output, alone. Jobs share your Claude plan's limits.
- **ApiKey**: a key from the Claude Console, alone. It must be scoped to a workspace: the API refuses an unscoped key unless the request names a workspace in an `anthropic-workspace-id` header, and a job's Claude Code is never handed `ANTHROPIC_CUSTOM_HEADERS`, the variable that could add one.
- **Bedrock**: the AWS region, and a Bedrock API key alone, or an AWS credentials file whose `profile`, `default` where none is named, holds an access key's `aws_access_key_id` and `aws_secret_access_key`. SSO, role and `credential_process` profiles are not read.
- **Vertex**: the region, the Google Cloud project, and the JSON key Google Cloud made for a service account.
- **Foundry**: the Foundry resource and one of its keys, alone. Name its deployments in `environment`, as `ANTHROPIC_DEFAULT_SONNET_MODEL` and its like.

Every job and session handed this file is told the kind; it is mounted read-only into a container, or read where it is by a job on this machine itself. The service never reads it, `doctor` alone does, and every secret in it is scrubbed from what a job or session reports. Claude Code is told its credential is the runner's, so a checkout's own settings choose no other provider and send the credential nowhere else. It is handed only the credential `claudeCredential` or `claudeTokenFile` names: a variable in `environment` that would choose another or where it is sent, such as `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or, beside Bedrock, `AWS_PROFILE`, reaches the commands a job runs for the project, its checks among them, but never Claude Code or a command it runs. Every kind but Subscription is billed by its provider.

**The Codex credential** is `codexCredential`, the `auth.json` `codex login` writes, mode 600 and yours, whether you log in with ChatGPT or an API key:

```json
"codexCredential": { "authFile": "/home/you/.codex/auth.json" }
```

A job whose task requires `Agent:Codex` is handed this file in place of the Claude credential's, as that one is handed; every other job and every session is handed the Claude one. So a task Codex runs states its capabilities rather than pinning an image, since a job that pins one is handed the Claude file. On a runner that names no `codexCredential`, a job requiring `Agent:Codex` is handed the Claude one; a job requiring two agents is refused. A job copies `auth.json` into a Codex home of its own that is thrown away, so keep the file here fresh yourself. `codexCredential` needs chuggy-linux 0.25.0 or later: an earlier copy refuses the file, and its service fails before it reaches the update that would read it, so check `chuggy-linux --version` before writing it.

A job runs as uid 1000, the image's user, and reads the credential's file as that uid, so the file must be yours. Rootless podman maps that uid onto you. Docker runs it as this machine's uid 1000, so docker serves only a runner that is uid 1000, and refuses any other user: use rootless podman there. Rootless docker and docker with userns-remap are refused too, for the same reason: use rootful docker without userns-remap, or rootless podman. Docker must be local, reached through a unix socket by your current docker context.

With `engineSocket` on, each job, and never a session, is handed this machine's engine, so that its checks can start containers of their own, as testcontainers does. The engine's socket is mounted at `/var/run/docker.sock`, read-only, which limits nothing the engine will do; a docker job is added to the socket's group unless that is root's, and the job is told where the socket is by `DOCKER_HOST`, `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` and, on podman, `TESTCONTAINERS_HOST_OVERRIDE`, which `environment` may then not name. Podman's socket must be running: `systemctl --user enable --now podman.socket`. `doctor` names the socket and fails one a job cannot reach; where its owners and mode cannot settle it, as with a socket of root's group that only an ACL could open to a job, it warns.

Every job on this machine, and its agent, can then run anything the engine can; with rootful docker, that is root on this machine. That includes stopping or inspecting this machine's other jobs and sessions, and reading what every container here holds, its own included. Turn it on only on a machine whose every project you trust that far. The containers a job starts are left to testcontainers' own clean-up (Ryuk), so a killed job can leave them running. testcontainers for Rust needs docker: it does not work on rootless podman.

With `volumes`, every job, and never a session, mounts each one listed at its `target`, read-only where `readonly` is `true`. Each is named as `docker run --mount` names it: a `source` that is an absolute path is a directory here, which must exist; any other is a named volume. A named volume that is missing is made by the first job started through chuggy's runtime, which opens it to uid 1000; one you made is mounted as it is. Nothing removes one. A `target` at, in or above `/opt/chuggy`, `/workspace`, `/var/run/chuggy` or `/var/run/docker.sock` is refused, and so is one at, in or above `/run/chuggy` or `/run/docker.sock`, since images commonly link `/var/run` to `/run`. `doctor` checks each source and its labels, and says whether a job can write each directory. A cache npm keeps between jobs:

```json
"volumes": [{ "source": "npm-cache", "target": "/cache/npm" }]
```

and in the image, `ENV npm_config_cache=/cache/npm`.

A named volume listed with `"scope": "project"` is one per project instead. Each project gets its own, named for the source and the project, such as `sccache-3f9c…`, and labelled `io.chuggy.owner-volume.project=<tenant>/<project>`. A job mounts it only where that label names the job's project: one labelled as another project's, or as none, fails the job, and so does an unscoped volume that carries the label. That keeps chuggy from handing one project's volume to another project's job; it hides nothing from whatever reaches the engine, such as a job given it by `engineSocket`. A directory cannot be scoped. `scope` needs chuggy-linux 0.18.0 or later: an earlier copy refuses the file, and its service fails before it reaches the update that would read it, so check `chuggy-linux --version` before writing it.

```json
"volumes": [{ "source": "sccache", "target": "/cache/sccache", "scope": "project" }]
```

A personal runner mounts a scoped volume from chuggy-linux 0.19.0: chuggy tells it each job's project, and the job mounts that project's volume, the same one a project's pool on this machine mounts, so the two share it. `doctor` names each as its job's project's without looking for it, since a personal runner serves its member across projects. Before 0.19.0 a personal runner's jobs run without it.

An unscoped volume is shared by every project and every job this machine serves. Jobs running at once use it at once, with nothing between them but the tool's own care for a shared cache, which npm's and cargo's take; and what one project's job writes there, another's can read and change. Jobs of one project share its scoped volume the same way.

**The disk floor** is `diskFreeGibMin`, held each pass against the space free where the engine stores what it holds: the least of the filesystems under docker's root directory, and under `/var/lib/containerd` where docker stores images through containerd, or under podman's graph root and volume path. Under it, the service removes the images it may, at most once a minute and under half of it every pass, as the hourly removal below does but keeping only the newest of chuggy's runtime and session images, and removing a job's image this runner pulled whatever `imageUnusedSecsMax` says, and takes no job until the disk is over it; sessions and jobs already running go on, and an hourly removal under way stops for it. Under half of it once that removal has begun, and is done or has run out its 30 s, it kills one job a pass, never a session: on docker with several running, the one whose container and workspace hold the most, and otherwise the newest. chuggy shows that job's ticket as Disk low, waiting for you to free space on this machine and resume it. The service's log says when the disk goes under the floor and when it is over again. `doctor` and `status` say what is free against the floor. From chuggy-linux 0.23.0 the floor is held at its default unless the file sets it; an earlier copy refuses a file that names `diskFreeGibMin`, so check `chuggy-linux --version` before writing it.

**The memory budget** is the engine's memory, as the engine's own `info` says, so a VM's where the engine runs in one, less `memoryFreeGibMin`. That reserve is for the memory the engine and its machine use outside every container; none is kept unless the file sets one. Every running container on the engine counts against the budget, whichever service started it: a job or session a runner ran at its memory cap, and anything else, such as a database or what a job starts through `engineSocket`, at what `docker stats` or `podman stats` says it uses. A job is held from when the service takes it, before its image is pulled, still this service's and shown in chuggy as starting, and starts once its image is here and the room left takes its cap; if its assignment's deadline comes too near for it to start, or its start has not ended shortly before that deadline, it fails as a job lost on its runner, which chuggy resumes by itself up to its retry limit and after that leaves to you. A held job counts at its cap on every service using the engine, as a volume named for its container with `-held`, until its container runs; the volume goes once the job starts, is stopped or fails, and one a service that has since ended left, or one past its job's deadline, is removed by the next service to count. A held job starts only once every job held for room before it has, so held jobs start in the order they were held. `memoryReservedGib` is kept from jobs for what always runs beside them, such as a database: the rest of the budget is the ceiling, and a job asking more than it is refused, and chuggy shows its ticket as Nowhere to run this work. Each poll tells chuggy the room and the ceiling, and a chuggy that reads them offers the service only jobs that fit both; the services sharing an engine take those one at a time, so no two are given the same room. Against a chuggy that does not, no service takes a job while any job on the engine is held for room, or while the room is under the least memory a job may ask. Sessions are counted but never held, and may ask the whole budget. Where the engine refuses to say what its containers use, as rootless podman on cgroup v1 does, what no runner capped is counted as using none, and the service's log and `status` say so. The count is approximate: a container counted by its use is counted at what it used when the service last counted, use outside every container is covered only by `memoryFreeGibMin`, jobs a pool registered with `--host` runs on this machine itself are not counted, and a service of another user on the same engine shares no lock with this user's, so the two can start into the same room. A job's deadline counts from when its container starts. `status` says the room, the budget, the ceiling, the sessions' caps and whether the service takes jobs, and why a held job waits. From chuggy-linux 0.29.0 the budget is kept, with no reserve unless the file sets one, and from 0.31.0 the ceiling; an earlier copy refuses a file that names `memoryFreeGibMin` or `memoryReservedGib`, so check `chuggy-linux --version` before writing either.

No floor is held where the space cannot be measured, as where docker names a machine other than this one, which Docker Desktop's VM is; the service's log says so. Nor does the floor see a filesystem mounted below those directories, or a directory `volumes` mounts into a job.

## The image a job runs in

A project's configuration names the image its jobs run in, by digest or by tag. An image already in this machine's engine is used as it is, so one built here with `docker build -t myproject:dev .` serves under that tag and is never pulled; a missing one is pulled. chuggy's runtime is got the same way, copied into a volume of the job's own and mounted read-only at `/opt/chuggy`, and the job starts through it in place of the image's `ENTRYPOINT` and `CMD`. So the image needs:

- `/bin/sh`, and `git` on `PATH`;
- glibc 2.28 or later with libstdc++, as a current Debian or Ubuntu has: an Alpine or other musl image cannot load the runtime;
- a `$HOME` and a temporary directory uid 1000 can write. The workspace is a volume this runner provides.

A task that pins no image names capabilities instead, and this runner meets them with what you give it in `runner.json`. With `images`, such a job runs in the first image listed declaring every capability it names, its platform aside, and is otherwise refused:

```json
"images": [{ "image": "ghcr.io/you/bazel:7", "capabilities": ["Agent:Claude", "Tool:Bazel"] }]
```

On a pool registered with `--host`, such a job of this machine's platform runs on this machine instead: as you, in a directory of its own under `~/.local/state/chuggy-linux/jobs/`, with its own `HOME` and temporary directory, the service's environment and `environment`, and `git` and its agent's command, such as `claude`, found on the service's `PATH`. That is systemd's for your user and not your shell's, so where `claude` is in `~/.local/bin`, name it in a drop-in: `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin` under `[Service]`. `doctor` names the `claude` such a job runs, and the `codex` where the file names a Codex credential, with their versions. Nothing isolates it. It can read and change whatever you can, the other jobs here among it, and reach whatever this machine reaches; register with `--host` only a machine whose every project you trust that far. A session, and a job that pins an image, still runs in a container. A host job is killed, with every process it started, at the sooner of `timeoutSecsMax` and its deadline, or when the runner is stopped; its log is saved beside a container's, and its directory is removed when it ends. A runner killed outright, by `SIGKILL` or the kernel, leaves its host jobs running until they end.

An image that lacks one is refused before any agent starts, and the ticket stops with a reason naming what is missing. An image the registry refuses is refused at once, and one that fails to pull any other way, such as from a host that does not resolve, after two minutes of trying.

A private image is pulled with this machine's own login for its registry. Log in once on each machine, as the user the service runs as and not under `sudo`: `docker login ghcr.io`, or for podman `podman login --authfile ~/.config/containers/auth.json ghcr.io`, since podman's own default file is under `XDG_RUNTIME_DIR`, which a reboot empties. The service reads that user's files, and runs with systemd's environment rather than your shell's (`systemctl --user show-environment`), so a `DOCKER_CONFIG` or `REGISTRY_AUTH_FILE` set only in your shell does not reach it. The registry the pool was registered for is the exception: a pull from it presents the pool's own token, unless podman's `registries.conf` names a credential helper ahead of `containers-auth.json`, or names no `containers-auth.json`, which podman then asks first. `doctor` warns of one, reading the `registries.conf` your shell's environment names while the service runs with systemd's.

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

Its first line names the copy speaking and the Node it runs under. It checks both files, the Claude credential, printing only its kind and settings, the Codex credential where the file names one or the pool advertises `Agent:Codex`, printing none of it, and whether a pool here advertises `Agent:Codex` for it, podman's credential helpers, whether the pool file's unit runs this copy, whether updates are on and this install can take one, the engine, whether jobs are handed its socket, the job network, each volume's source, the engine's free disk against the floor, the capabilities a run advertises, a token from the pool's issuer and one poll of the plane, which advertises none, and changes nothing. The poll is a long one, so the last check can take a while.

## Run as a service

`register` writes the unit and starts it itself where it can. Otherwise:

```sh
chuggy-linux install-service --pool ~/.config/chuggy/pools/vteng.chuggy.shame.json
```

This writes the pool file's own unit, `~/.config/systemd/user/chuggy-linux-vteng.chuggy.shame.service`, named for the file less `.json`, which runs this install's `chuggy-linux run` under the Node that installed it, and prints the `systemctl --user` commands that start it. It runs none of them. Each pool file has a unit of its own, so several pools run side by side; a unit of the name that serves another pool file is refused. The service restarts after any failure except the plane denying the pool (exit 3), which no restart would change. Run `install-service` again from the new copy after upgrading Node or moving the install; until then `doctor` warns that the service runs another.

chuggy-linux 0.1 wrote one unit for the machine, `~/.config/systemd/user/chuggy-linux.service`, and it keeps working after an upgrade. Where it serves the pool being installed, `install-service` prints the commands that stop and remove it before starting the pool's own. A pool's service refuses to start while another service of the pool runs, or while the old unit's service runs a pool file this runner cannot read, which may be the same pool. It cannot see a 0.1 runner started by hand rather than by that unit. Where the old unit serves another pool, it runs on beside the new unit. The containers it started are found by their labels, so `status` and `stop` still see them.

## Updates

The service keeps itself on the release chuggy names for it. Once chuggy names a newer one, the service downloads and checks it, installs it over itself and exits 75, and systemd starts it again on the new copy. A docker container runs on through the restart. Work that would end with the service holds the update back: a job on this machine itself, from a pool registered with `--host`, and on podman every job and session, since podman's containers stop with the service. Where the pool holds any, it checks the release first, then takes no new work until that work ends.

Before installing a release, it checks that the release is this package, newer than the copy running, downloaded from chuggy-linux's own GitHub releases, byte for byte the one chuggy named, and that it runs under the service's Node and names its own version. Only then does npm install it where this copy is installed. A release that fails a check, or an install that fails, leaves the running copy serving, and the log says why and when it tries again.

It cannot update an install this user cannot write, such as one `sudo npm i -g` put under `/usr`. Install it under a prefix of your own instead, with nvm or after `npm config set prefix ~/.local`, and run `install-service` again from that copy. `doctor` says whether updates are on, and warns where this install cannot take one.

To turn updates off, set `"autoUpdate": false` in the runner's file and restart the service; the log then says only that a release is out. `chuggy-linux --version` names the copy installed, and the service's log names each release it updates to.

## Tools for your coding agent

```sh
claude mcp add chuggy -- chuggy-linux mcp --site <origin> --workspace <workspace> --project <project>
```

`mcp` serves a coding agent on this machine the `chuggy` tools a session pod has, for one project: it reads, drafts and releases tickets under your own sign-in, and decides nothing. It takes no pool file. The first call with no sign-in answers with the site's sign-in address for the agent to hand you; the sign-in returns to a page `mcp` holds on `127.0.0.1`, so it is opened in a browser on this machine. Once you sign in, calls go through, and the token is renewed ahead of its expiry. The renewal token is kept in `$XDG_CONFIG_HOME/chuggy/sign-ins` (`~/.config/chuggy/sign-ins` by default), in a file only you can read, one per site, shared by every chat on the machine.

## Commands

| Command             | What it does                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `register`          | Redeems a registration token for a pool file, and starts its service where it can.                                                      |
| `run`               | The service: polls until the plane denies the pool.                                                                                     |
| `once`              | One poll, then waits for what it placed to start, and for a job on this machine itself to end. Refused while the pool's own service, or a 0.1 service known to serve the pool, runs. |
| `status`            | This pool's limits, the engine's free disk against the floor, the room, ceiling and sessions in its memory budget, its containers, the service's jobs on this machine itself and what it is still pulling, starting or holding for room, each named a job or a session. |
| `stop <assignment>` | Stops one assignment's container, through the service when it is running; a job on this machine itself only through the service. |
| `doctor`            | The checks above.                                                                                                                       |
| `install-service`   | Writes the pool's systemd user unit.                                                                                                    |
| `mcp`               | Serves the `chuggy` tools for one project to your own coding agent on stdio. |

`once` renews nothing after it exits, so with no service running, the lease on what it placed lapses while the container keeps going. Nor does it while it waits for a job on this machine itself, whose lease lapses as it runs.

## What it does

- Places an assignment only if this machine has the CPU and memory it asks for, counted for that assignment alone, it pins an image, or one `images` lists or `--host` meets it, and the credential file of the agent it requires, Claude's where it requires none or one runner.json names no file for, is usable; otherwise it refuses it, and chuggy sees the reason.
- Pulls a missing image from the registry the pool was registered for under the pool's own token, written for that one pull to a directory only you can read and removed after it. A refused token is replaced with a fresh one until the assignment's deadline. An image from any other registry is pulled once, as docker or podman pulls it with your own logins.
- Runs each job as uid 1000 through chuggy's runtime, mounted read-only, with every capability dropped, no privilege escalation, a process limit, the assignment's CPU and memory, its agent's credential file mounted read-only, and a workspace volume of its own. The job's credentials reach it through an env file that is deleted once the container starts.
- Keeps renewing an assignment while its image is still pulling, and finds the containers a previous run started.
- Saves an ended job's logs to `~/.local/state/chuggy-linux/logs/<container>.log` and removes the container with its workspace. A job that is stopped, or past its deadline, is killed first. A log longer than 10 MiB, the kubelet's own default bound, or than 200 000 lines is saved as its end, opening with a line saying so. A container whose logs cannot be saved is kept and tried again, and after ten minutes removed without them, which the service's log says.
- Removes images this machine no longer needs, hourly: of each repository chuggy's runtime or sessions came from, every untagged image but the two most recently used, and a job's image this runner pulled itself once it has gone unused for `imageUnusedSecsMax`; under the [disk floor](#configure), more. No removal is forced, so an image a container uses stays. Nor is an image removed while a placement is about to use it, within ten minutes of its last use, or while it has a tag but the one a job pulled it by; to keep an image, tag it. Every runner here using the same engine keeps one record of what it used, in `~/.local/state/chuggy-linux/images/<engine>.json`. A job's image pulled before the runner kept that record was never recorded as its own, and stays until you remove it.
- Tells chuggy at once when a job ends without being stopped: its container exited, was killed at its deadline or under half the disk floor, or never started. chuggy is given the runner's own reason, such as `its container exited with status 1`, never the job's log, and a job that already reported keeps its report. Nothing is sent for a job stopped by chuggy or by `stop`.
- Labels a session's container a session, and tells chuggy when one ends without being stopped: `Succeeded` where its container exited 0, `Failed` however else it ended. A container with no such label, as every container before sessions has, is a job's.

## What it does not do

- Run an assignment that pins no image unless `images` or `--host` meets it: this runner has no image of its own.
- Check that a capability it declares is met: that is yours.
- Restrict a job's network: the bridge reaches whatever the machine reaches.
- Report a job's result: the job reports to chuggy itself.
- Install docker or podman.
- Limit a job's workspace: its volume has no size limit.
