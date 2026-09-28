#!/bin/sh
# The contract every suite here runs against is the release the lock names,
# installed by npm, and not a link to somebody's tree.
#
# THE FAILURE IS A GREEN RUN AGAINST THE WRONG CONTRACT. `npm link` to a local
# chuggy, or a hand-copied directory, resolves `@chuggy/worker-contract` for
# every import here, and every suite then passes against a contract no tarball
# will ever bundle. So this is a precondition, not a finding: what it
# detects is the install, and every answer but clean is exit 2.
# `check-source.sh` runs it before the suites and refuses to run them unless
# it is clean.
#
# THREE THINGS MUST AGREE. The package's directory is this checkout's own
# `node_modules` entry and not a link, at any depth. Its manifest carries the
# version `package-lock.json` names. And npm's record of what it installed
# there, `node_modules/.package-lock.json`, carries the lock's `resolved` URL
# and `integrity`, which `npm ci` checked against the downloaded asset.
#
# WHAT IT CANNOT SEE. A file edited inside the installed package after npm
# wrote it: the integrity is the tarball's, and nothing on disk keeps it.
#
# Usage:
#   .chug/tasks/check-contract.sh
#
# Exits 0 clean, 2 when the installed contract is not the locked release.
# There is no finding state. Two is not a pass.
set -eu
export LC_ALL=C

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
	echo "check-contract: LINTER ERROR — not a git checkout" >&2
	exit 2
fi
cd "$root" || exit 2

contract="@chuggy/worker-contract"
installed="node_modules/$contract"

if ! command -v node >/dev/null 2>&1; then
	echo "check-contract: LINTER ERROR — no node on PATH"
	exit 2
fi

if [ ! -f package-lock.json ]; then
	echo "check-contract: LINTER ERROR — no package-lock.json; there is no release to compare with"
	exit 2
fi

if [ ! -d "$installed" ]; then
	echo "check-contract: LINTER ERROR — $installed is not installed. Install with \`npm ci\`."
	exit 2
fi

# Resolved physically, so a link at the package, at its scope or at
# `node_modules` itself lands somewhere other than where npm installs.
here="$(pwd -P)/$installed"
real="$(cd "$installed" && pwd -P)"
if [ "$real" != "$here" ]; then
	echo "check-contract: LINTER ERROR — $installed is a link to $real, not the release the lock names. Install with \`npm ci\`."
	exit 2
fi

set +e
verdict="$(node -e '
const { readFileSync } = require("node:fs");
const [contract, installed] = process.argv.slice(1);
const key = `node_modules/${contract}`;
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const refuse = (why) => {
  console.log(why);
  process.exit(2);
};
const locked = read("package-lock.json").packages?.[key];
if (!locked?.resolved || !locked.integrity)
  refuse(`package-lock.json names no released ${contract}`);
let record;
try {
  record = read("node_modules/.package-lock.json").packages?.[key];
} catch {
  refuse("node_modules/.package-lock.json is unreadable, so what npm installed is unknown");
}
if (!record) refuse(`npm recorded no install of ${contract}`);
const manifest = read(`${installed}/package.json`);
if (manifest.name !== contract)
  refuse(`${installed} holds ${manifest.name}, not ${contract}`);
if (manifest.version !== locked.version)
  refuse(`${installed} is ${manifest.version}; the lock names ${locked.version}`);
if (record.resolved !== locked.resolved)
  refuse(`npm installed ${contract} from ${record.resolved}; the lock names ${locked.resolved}`);
if (record.integrity !== locked.integrity)
  refuse(`npm installed ${contract} as ${record.integrity}; the lock names ${locked.integrity}`);
console.log(`${contract} ${locked.version} from ${locked.resolved}, ${locked.integrity}`);
' "$contract" "$installed" 2>&1)"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
	echo "check-contract: LINTER ERROR — $verdict. Install with \`npm ci\`."
	exit 2
fi
echo "check-contract: installed $verdict"
