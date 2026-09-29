# Thin wrappers. `.chug/tasks/ci.sh` is the real logic.

# Every gate, and the gates' own suites.
check:
    ./.chug/tasks/ci.sh

# The installable tarball, its dependencies bundled from the locked install.
pack:
    npm ci
    npm pack

# Install the pre-commit hook. A fresh clone needs this once.
hooks:
    git config core.hooksPath .githooks
    @echo "hooks installed: core.hooksPath = .githooks"
