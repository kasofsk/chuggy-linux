# Thin wrappers. `.chug/tasks/ci.sh` is the real logic.

# Every gate, and the gates' own suites.
check:
    ./.chug/tasks/ci.sh

# Install the pre-commit hook. A fresh clone needs this once.
hooks:
    git config core.hooksPath .githooks
    @echo "hooks installed: core.hooksPath = .githooks"
