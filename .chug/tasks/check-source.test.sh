#!/bin/sh
# Shell test for check-source.sh.
#
# THIS SUITE IS WHERE THE LINT AND THE FORMAT ARE PROVED TO BITE. The rules
# live in `eslint.config.js` and `.prettierrc.json`, and a configuration cannot
# demonstrate anything about itself — a rule misspelled, scoped to a path that
# does not exist, or dropped by a preset reads exactly like a rule that works.
# So each gets a fixture carrying the violation it names, and the violations
# share one tree so the linter runs once for all of them.
#
# node_modules is symlinked rather than installed: the toolchain under test
# must be the one this tree pins. The contract precondition is a stub, since
# what it decides is `check-contract.test.sh`'s; what is under test here is
# what this gate does with its answer.
#
# Run:  .chug/tasks/check-source.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_suite.sh"
SUT="$HERE/check-source.sh"
ROOT="$(cd "$HERE/../.." && pwd)"

R="$WORK/repo"

run_in() { # <dir> [env=value...]
	OUT="$WORK/.out"
	dir="$1"
	shift
	set +e
	(cd "$dir" && env "$@" "$SUT") >"$OUT" 2>&1
	RC=$?
	set -e
}

# The precondition's answer, as the gate reads it.
precondition() { # <exit>
	mkdir -p "$R/.chug/tasks"
	printf '#!/bin/sh\necho "check-contract: installed @chuggy/worker-contract 9.9.9 from https://example.invalid/c.tgz, sha512-fixture"\nexit %s\n' "$1" \
		> "$R/.chug/tasks/check-contract.sh"
	chmod +x "$R/.chug/tasks/check-contract.sh"
}

# A tree carrying this repo's real configs, a module, and a suite that passes.
# Every file is written in the formatter's own output shape, or the format
# stage would fail in every case and each would become a test of the fixture.
fixture() { # [--no-modules]
	rm -rf "$R"
	mkdir -p "$R"
	for f in eslint.config.js .prettierrc.json .prettierignore; do
		cp "$ROOT/$f" "$R/$f"
	done
	{
		printf '%s\n' '{'
		printf '%s\n' '  "name": "fixture",'
		printf '%s\n' '  "private": true,'
		printf '%s\n' '  "type": "module"'
		printf '%s\n' '}'
	} > "$R/package.json"
	[ "${1:-}" = "--no-modules" ] || ln -s "$ROOT/node_modules" "$R/node_modules"
	printf '%s\n' 'export const answer = 42;' > "$R/answer.mjs"
	{
		printf '%s\n' 'import assert from "node:assert/strict";'
		printf '%s\n' 'import { test } from "node:test";'
		printf '%s\n' ''
		printf '%s\n' 'import { answer } from "./answer.mjs";'
		printf '%s\n' ''
		printf '%s\n' 'test("the fixture holds", () => {'
		printf '%s\n' '  assert.equal(answer, 42);'
		printf '%s\n' '});'
	} > "$R/answer.test.mjs"
	precondition 0
	git -C "$R" init -q -b main
	git -C "$R" config user.email t@example.com
	git -C "$R" config user.name t
}

failing_suite() { # <path> <test name>
	{
		printf '%s\n' 'import assert from "node:assert/strict";'
		printf '%s\n' 'import { test } from "node:test";'
		printf '%s\n' ''
		printf '%s\n' "test(\"$2\", () => {"
		printf '%s\n' '  assert.equal(1, 2);'
		printf '%s\n' '});'
	} > "$1"
}

seal() {
	git -C "$R" add -A
	run_in "$R"
}

# --- The gate's own contract -------------------------------------------------

run_in "$WORK"
check "outside a git checkout exits 2, not 0" 2 "$RC" "not a git checkout"

fixture
rm "$R/answer.test.mjs"
seal
check "a tree with no suite exits 2, not 0" 2 "$RC" "the suite glob matched nothing"

fixture --no-modules
seal
check "a missing toolchain exits 2, not 0" 2 "$RC" "Install with"

fixture
seal
check "a clean tree passes every stage" 0 "$RC" "0 stage(s) failed, 3 run"
# The figures are asserted against a fixture whose suites and release this
# file wrote, so the line cannot report a run it did not make.
check "the clean line counts the suites and names the release" 0 "$RC" "unit ran 1 suite(s) against @chuggy/worker-contract 9.9.9"

# --- The precondition ----------------------------------------------------------
#
# The failing suite is what says the unit stage never started: it would print
# its own name had it run.

fixture
precondition 2
failing_suite "$R/failing.test.mjs" "this one would have run"
seal
check "a precondition that is not clean exits 2, not 0" 2 "$RC" "would not run against the locked contract release"
check "and its reason is shown" 2 "$RC" "sha512-fixture"
refute "and no suite runs" 2 "$RC" "this one would have run"

fixture
rm "$R/.chug/tasks/check-contract.sh"
seal
check "a missing precondition exits 2, not 0" 2 "$RC" "would not run against the locked contract release"

# A commit's `git commit -a` hands its hook an absolute GIT_INDEX_FILE, and a
# suite's scratch repository would write through it into this one.
fixture
{
	printf '%s\n' 'import assert from "node:assert/strict";'
	printf '%s\n' 'import process from "node:process";'
	printf '%s\n' 'import { test } from "node:test";'
	printf '%s\n' ''
	printf '%s\n' 'test("no suite inherits the index of the repository it checks", () => {'
	printf '%s\n' '  assert.equal(process.env.GIT_INDEX_FILE, undefined);'
	printf '%s\n' '});'
} > "$R/index.test.mjs"
git -C "$R" add -A
run_in "$R" GIT_INDEX_FILE="$R/.git/index"
check "a suite runs without the hook's index" 0 "$RC" "unit ran 2 suite(s)"

# --- The lint, the format and the suites ---------------------------------------

fixture
{
	printf '%s\n' 'export const undeclared = elsewhere;'
	printf '%s\n' 'export const pair = new Array(1, 2);'
	printf '%s\n' 'export const loose = (a, b) => a == b;'
} > "$R/lint.mjs"
{
	printf '%s\n' 'export function long() {'
	printf '%s\n' '  let n = 0;'
	i=0
	while [ "$i" -lt 71 ]; do
		printf '%s\n' "  n += 1;"
		i=$((i + 1))
	done
	printf '%s\n' '  return n;'
	printf '%s\n' '}'
} > "$R/long.mjs"
printf '%s\n' 'export const  spaced   =    1;' > "$R/ugly.mjs"
failing_suite "$R/failing.test.mjs" "this one is meant to fail"
# A checkout nested under .claude/ is an agent's worktree of this tree, and a
# linter that walked in would judge every file twice.
mkdir -p "$R/.claude/worktrees/agent-x"
printf '%s\n' 'export const loose = (a, b) => a == b;' > "$R/.claude/worktrees/agent-x/nested.mjs"
seal

check "the recommended set applies: an undeclared name is a finding" 1 "$RC" "'elsewhere' is not defined"
check "the TypeScript recommended set applies to JavaScript too" 1 "$RC" "@typescript-eslint/no-array-constructor"
check "loose equality is a finding" 1 "$RC" "Expected '===' and instead saw '=='"
check "a function over the cap is a finding" 1 "$RC" "Maximum allowed is 70"
check "unformatted source is a finding" 1 "$RC" "Code style issues found"
check "a failing suite is a finding" 1 "$RC" "this one is meant to fail"
check "each stage reports independently of the others" 1 "$RC" "3 stage(s) failed"
refute "a checkout nested under .claude/ is not this tree's source" 1 "$RC" "nested.mjs"

done_ "check-source.test.sh"
