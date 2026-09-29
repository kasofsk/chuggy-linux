#!/bin/sh
# Shell test for check-contract.sh.
#
# Every case is an install written by hand into a throwaway repo: the gate
# reads the lock, npm's record of the install and the installed manifest, and
# a fixture that ran npm would test npm. The clean install comes first, so
# each refusal after it differs from a passing tree by the one thing it names.
#
# Run:  .chug/tasks/check-contract.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_suite.sh"
SUT="$HERE/check-contract.sh"

R="$WORK/repo"
ASSET="https://example.invalid/chuggy-worker-contract-1.0.0.tgz"
DIGEST="sha512-fixture"

run_in() { # <dir>
	OUT="$WORK/.out"
	set +e
	(cd "$1" && "$SUT") >"$OUT" 2>&1
	RC=$?
	set -e
}

lock_entry() { # <version> <resolved> <integrity>
	printf '{ "packages": { "node_modules/@chuggy/worker-contract": { "version": "%s", "resolved": "%s", "integrity": "%s" } } }\n' "$1" "$2" "$3"
}

manifest() { # <dir> <name> <version>
	mkdir -p "$1"
	printf '{ "name": "%s", "version": "%s" }\n' "$2" "$3" > "$1/package.json"
}

# The install `npm ci` leaves: the lock, npm's record agreeing with it, and
# the package where npm puts it.
installed() {
	fresh_repo "$R"
	lock_entry 1.0.0 "$ASSET" "$DIGEST" > "$R/package-lock.json"
	mkdir -p "$R/node_modules"
	lock_entry 1.0.0 "$ASSET" "$DIGEST" > "$R/node_modules/.package-lock.json"
	manifest "$R/node_modules/@chuggy/worker-contract" @chuggy/worker-contract 1.0.0
	git -C "$R" add package-lock.json
}

run_in "$WORK"
check "outside a git checkout exits 2, not 0" 2 "$RC" "not a git checkout"

installed
run_in "$R"
check "the locked release, installed, is clean" 0 "$RC" "installed @chuggy/worker-contract 1.0.0 from $ASSET, $DIGEST"

# --- Links --------------------------------------------------------------------
#
# What `npm link` leaves is a link at the package; a link higher up resolves
# the same imports to the same elsewhere, and is refused the same way.

installed
manifest "$WORK/elsewhere/contract" @chuggy/worker-contract 1.0.0
rm -r "$R/node_modules/@chuggy/worker-contract"
ln -s "$WORK/elsewhere/contract" "$R/node_modules/@chuggy/worker-contract"
run_in "$R"
check "a linked contract exits 2, not 0" 2 "$RC" "/elsewhere/contract, not the release the lock names"

installed
mkdir -p "$WORK/elsewhere/scope"
mv "$R/node_modules/@chuggy/worker-contract" "$WORK/elsewhere/scope/worker-contract"
rmdir "$R/node_modules/@chuggy"
ln -s "$WORK/elsewhere/scope" "$R/node_modules/@chuggy"
run_in "$R"
check "a linked scope exits 2 as well" 2 "$RC" "is a link to"
rm -r "$WORK/elsewhere"

# --- What npm installed against what the lock names ---------------------------

installed
manifest "$R/node_modules/@chuggy/worker-contract" @chuggy/worker-contract 1.1.0
run_in "$R"
check "another version installed exits 2" 2 "$RC" "is 1.1.0; the lock names 1.0.0"

installed
manifest "$R/node_modules/@chuggy/worker-contract" @chuggy/something-else 1.0.0
run_in "$R"
check "another package in the contract's place exits 2" 2 "$RC" "holds @chuggy/something-else"

# The shape `npm install ../chuggy-contract.tgz --no-save` leaves: the lock
# untouched, the record naming the tarball it was handed.
installed
lock_entry 1.0.0 "file:../chuggy-contract.tgz" "$DIGEST" > "$R/node_modules/.package-lock.json"
run_in "$R"
check "a release installed from elsewhere exits 2" 2 "$RC" "from file:../chuggy-contract.tgz; the lock names $ASSET"

installed
lock_entry 1.0.0 "$ASSET" "sha512-other" > "$R/node_modules/.package-lock.json"
run_in "$R"
check "another asset under the same URL exits 2" 2 "$RC" "as sha512-other; the lock names $DIGEST"

# --- Nothing to compare -------------------------------------------------------

installed
rm -r "$R/node_modules/@chuggy"
run_in "$R"
check "no install exits 2" 2 "$RC" "is not installed. Install with"

installed
rm "$R/node_modules/.package-lock.json"
run_in "$R"
check "no record of the install exits 2" 2 "$RC" "what npm installed is unknown"

installed
printf '{ "packages": {} }\n' > "$R/node_modules/.package-lock.json"
run_in "$R"
check "a record without the contract exits 2" 2 "$RC" "npm recorded no install"

installed
rm "$R/package-lock.json"
run_in "$R"
check "no lock exits 2" 2 "$RC" "no package-lock.json"

installed
printf '{ "packages": { "node_modules/@chuggy/worker-contract": { "version": "1.0.0", "link": true } } }\n' > "$R/package-lock.json"
run_in "$R"
check "a lock naming no released asset exits 2" 2 "$RC" "names no released @chuggy/worker-contract"

done_ "check-contract.test.sh"
