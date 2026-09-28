#!/bin/sh
# The JavaScript gate. Lints every module, holds them to the formatter's
# output, and runs every suite against the contract release the lock names.
#
# ONE GATE PER TOOLCHAIN, NOT ONE PER TOOL. The rules the tools apply are
# stated where they are enforced — `eslint.config.js` and `.prettierrc.json`,
# whose emptiness is the rule that the formatter's defaults are never argued.
# This file runs them and reports.
#
# THE SUITES RUN ONLY AGAINST THE RELEASE. `check-contract.sh` is their
# precondition, and anything but clean from it is this gate's could-not-run:
# a suite green against a linked contract says nothing about the release the
# tarball bundles.
#
# A SUITE BUILDS ITS OWN REPOSITORIES, so it is run without the variables git
# hands a hook to select this one. Inherited, `GIT_INDEX_FILE` from
# `git commit -a` names this checkout's index by absolute path, and a suite's
# `git add` in a scratch repository would write into it.
#
# Local binaries win over anything on PATH: a verdict that depends on which
# version happens to be installed is not a verdict. Each missing one is a
# could-not-run, reported as itself.
#
# Usage:
#   .chug/tasks/check-source.sh
#
# Exits 0 clean, 1 on a finding, 2 when it could not run. Two is not a pass.
set -eu
export LC_ALL=C

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
	echo "check-source: LINTER ERROR — not a git checkout" >&2
	exit 2
fi
cd "$root" || exit 2

# The runner is handed its list rather than discovering one, and an empty
# list would send it back to whole-tree discovery; the glob is checked first
# and separately.
suites="$(git ls-files '*.test.mjs' 2>/dev/null || true)"
if [ -z "$suites" ]; then
	echo "check-source: LINTER ERROR — no tracked suite; the suite glob matched nothing"
	exit 2
fi

for tool in eslint prettier; do
	if [ ! -x "./node_modules/.bin/$tool" ]; then
		echo "check-source: LINTER ERROR — no local $tool. Install with \`npm ci\`."
		exit 2
	fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0
ran=0

stage() { # <label> <command>...
	label="$1"
	shift
	printf '%s: ' "$label"
	set +e
	"$@" >"$work/out" 2>&1
	rc=$?
	set -e
	ran=$((ran + 1))
	if [ "$rc" -eq 0 ]; then
		echo "clean"
	else
		echo "FAILED"
		sed 's/^/    /' "$work/out"
		failed=$((failed + 1))
	fi
}

stage "  lint  " ./node_modules/.bin/eslint .
stage "  format" ./node_modules/.bin/prettier --check --log-level warn .

set +e
./.chug/tasks/check-contract.sh >"$work/contract" 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
	sed 's/^/    /' "$work/contract"
	echo "check-source: LINTER ERROR — the suites would not run against the locked contract release"
	exit 2
fi

set -f
IFS='
'
# shellcheck disable=SC2086 # the suite list is newline-separated by construction
set -- $suites
unset IFS
set +f

stage "  unit  " env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
	node --test --test-reporter=dot "$@"
echo "check-source: unit ran $# suite(s) against $(sed 's/^check-contract: installed //; s/ from .*//' "$work/contract")"

echo "check-source: $failed stage(s) failed, $ran run"
[ "$failed" -eq 0 ]
