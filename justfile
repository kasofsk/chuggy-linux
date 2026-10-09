# Thin wrappers. `.chug/tasks/ci.sh` is the real logic.

# Every gate, and the gates' own suites.
check:
    ./.chug/tasks/ci.sh

# The installable tarball, its dependencies bundled from the locked install.
pack:
    npm ci
    npm pack

# Why two names: the install address `releases/latest/download/chuggy-linux.tgz`
# serves one file name from release to release, and a versioned name is not it.

# This version's GitHub release at this commit, the tarball under both names.
release $notes: pack
    #!/usr/bin/env sh
    set -eu
    git diff --quiet HEAD || { echo "release: uncommitted changes" >&2; exit 1; }
    version=$(node -p 'require("./package.json").version')
    cp "chuggy-linux-$version.tgz" chuggy-linux.tgz
    gh release create "v$version" "chuggy-linux-$version.tgz" chuggy-linux.tgz \
        --target "$(git rev-parse HEAD)" --title "v$version" --notes "$notes"

# Install the pre-commit hook. A fresh clone needs this once.
hooks:
    git config core.hooksPath .githooks
    @echo "hooks installed: core.hooksPath = .githooks"
