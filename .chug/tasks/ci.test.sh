#!/bin/sh
# Shell test for ci.sh — the sequencer's own behaviour, not the gates'.
#
# Cases run against throwaway repos holding stub gates with controllable exit
# codes: what is under test is how ci.sh *treats* a verdict — that a finding
# and a could-not-run stay different answers all the way to its own exit code,
# and that the only time bound on the suites is each one's own cap.
#
# The fixture carries a stub for every gate the sequencer names, because a
# named gate that is absent is itself a could-not-run. A fixture short of one
# would exercise that rather than the case it was written for.
#
# Run:  .chug/tasks/ci.test.sh
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/_suite.sh"
SUT="$HERE/ci.sh"
BARE="$(mktemp -d)"
trap 'rm -rf "$WORK" "$BARE"' EXIT

R="$WORK/repo"

# No case inherits a sequencer input it did not choose, less
# CHUG_CI_SHELL_SUITES — the recursion guard, which each case that reaches the
# suite stage sets for itself.
unset CHUG_CI_SUITE_TIMEOUT_SECS

ROOT="$(cd "$HERE/../.." && pwd)"
grep -F '    ./.chug/tasks/ci.sh' "$ROOT/justfile" >/dev/null

# Read off the sequencer rather than listed here: the roster is the calls, and
# a second copy of it would be the half that drifts.
named_gates() { # <script> — the gates it calls, by bare name
	grep -o '\./\.chug/tasks/[a-z-]*\.sh' "$1" | sed 's|.*/||; s|\.sh$||'
}

# An empty roster would leave every case below passing against a repo with no
# gates at all — the exact reading this suite exists to refuse.
if [ -z "$(named_gates "$SUT")" ]; then
	echo "ci.test.sh: no gate calls found in $SUT; the fixture would stub nothing"
	exit 2
fi

stub_repo() { # <exit> — every named gate stubbed clean but check-paths
	fresh_repo "$R"
	mkdir -p "$R/.chug/tasks"
	cp "$SUT" "$R/.chug/tasks/ci.sh"
	chmod +x "$R/.chug/tasks/ci.sh"
	for gate in $(named_gates "$SUT"); do
		printf '#!/bin/sh\necho stub %s\nexit 0\n' "$gate" > "$R/.chug/tasks/$gate.sh"
		chmod +x "$R/.chug/tasks/$gate.sh"
	done
	printf '#!/bin/sh\necho stub check-paths\nexit %s\n' "$1" > "$R/.chug/tasks/check-paths.sh"
	chmod +x "$R/.chug/tasks/check-paths.sh"
	git -C "$R" add -A
}

# The gate stage alone: with the suite stage on, the fixture's empty suite glob
# would add a second could-not-run and the counts below would stop being about
# the roster.
run_gates_only() {
	OUT="$WORK/.out"
	set +e
	(cd "$R" && CHUG_CI_SHELL_SUITES=0 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
	RC=$?
	set -e
}

# The real ci.sh hands every suite CHUG_CI_SHELL_SUITES=0 so this file cannot
# recurse into a live run. That guard is inherited here and would skip the
# suite stage in the cases that exist to exercise it, so they set it back
# explicitly; recursion stays bounded because the stub ci.sh under test passes
# the guard down to its own stub suites.
run_ci() {
	OUT="$WORK/.out"
	set +e
	(cd "$R" && CHUG_CI_SHELL_SUITES=1 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
	RC=$?
	set -e
}

stub_repo 0
run_gates_only
check "all gates clean exits 0" 0 "$RC" "all gates clean"
check "CHUG_CI_SHELL_SUITES=0 skips the suite stage" 0 "$RC" "SKIPPED"
for gate in $(named_gates "$SUT"); do
	check "every run runs $gate" 0 "$RC" "stub $gate"
done

stub_repo 1
run_gates_only
check "a gate finding exits 1" 1 "$RC" "1 gate(s) failed"

# A gate that could not run exits 2, NOT 1 and never 0.
stub_repo 2
run_gates_only
check "a gate that could not run exits 2" 2 "$RC" "could not run"
check "could-not-run is reported as not a pass" 2 "$RC" "this is not a pass"

# A gate the sequencer names but the tree does not carry is a could-not-run
# too, or it would print "all gates clean" having never attempted the gate.
stub_repo 0
rm -f "$R/.chug/tasks/check-boundaries.sh"
git -C "$R" add -A
run_gates_only
check "a missing named gate exits 2, not 0" 2 "$RC" "1 gate(s) could not run"
check "the missing gate is named" 2 "$RC" "check-boundaries.sh is missing"

# The half a diff hides in a mode line.
stub_repo 0
chmod -x "$R/.chug/tasks/check-source.sh"
git -C "$R" add -A
run_gates_only
check "a non-executable named gate exits 2, not 0" 2 "$RC" "1 gate(s) could not run"
check "the non-executable gate is named" 2 "$RC" "check-source.sh is not executable"

stub_repo 0
printf '#!/bin/sh\nexit 1\n' > "$R/.chug/tasks/failing.test.sh"
chmod +x "$R/.chug/tasks/failing.test.sh"
git -C "$R" add -A
run_ci
check "a failing suite fails the run" 1 "$RC" "failing.test.sh"

stub_repo 0
printf '#!/bin/sh\nexit 0\n' > "$R/.chug/tasks/passing.test.sh"
chmod +x "$R/.chug/tasks/passing.test.sh"
git -C "$R" add -A
run_ci
check "a passing suite leaves the run clean" 0 "$RC" "all gates clean"

# The stage has no total: a clock that reads an hour later every time it is
# asked stops no suite, so a slower machine runs them all.
stub_repo 0
for suite in one two; do
	printf '#!/bin/sh\ntouch "%s/ran-%s"\n' "$WORK" "$suite" > "$R/.chug/tasks/$suite.test.sh"
done
mkdir -p "$WORK/clock"
printf '#!/bin/sh\nn="$(cat "%s/hours" 2>/dev/null || echo 0)"\necho $((n + 1)) > "%s/hours"\necho $((n * 3600))\n' \
	"$WORK/clock" "$WORK/clock" > "$WORK/clock/date"
chmod +x "$WORK/clock/date"
git -C "$R" add -A
OUT="$WORK/.out"
set +e
(cd "$R" && PATH="$WORK/clock:$PATH" CHUG_CI_SHELL_SUITES=1 ./.chug/tasks/ci.sh) >"$OUT" 2>&1
RC=$?
set -e
ls "$WORK" >>"$OUT"
check "hours between suites stop none of them" 0 "$RC" "all gates clean"
check "the first suite ran" 0 "$RC" "ran-one"
check "the last suite ran" 0 "$RC" "ran-two"
check "the stage states the one bound it applies" 0 "$RC" "per suite, no total"

# A suite past its own cap is stopped and fails the run by name.
stub_repo 0
printf '#!/bin/sh\nexec sleep 5\n' > "$R/.chug/tasks/slow.test.sh"
git -C "$R" add -A
OUT="$WORK/.out"
set +e
(cd "$R" && CHUG_CI_SHELL_SUITES=1 CHUG_CI_SUITE_TIMEOUT_SECS=1 \
	./.chug/tasks/ci.sh) >"$OUT" 2>&1
RC=$?
set -e
check "a suite past its cap fails the run" 1 "$RC" "slow.test.sh ran past the 1s cap"

# A glob matching nothing must not read as "the suites passed".
stub_repo 0
run_ci
check "no suites found exits 2, not 0" 2 "$RC" "matched nothing"

OUT="$BARE/.out"
set +e
(cd "$BARE" && "$SUT") >"$OUT" 2>&1
RC=$?
set -e
check "outside a git checkout exits 2, not 0" 2 "$RC" "LINTER ERROR"

done_ "ci.test.sh"
