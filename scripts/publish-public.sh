#!/usr/bin/env bash
set -euo pipefail

if ! npm whoami >/dev/null 2>&1; then
  printf '%s\n' 'Cannot publish: npm authentication is required. Run npm login with an account that can publish @eyeball packages, then retry.' >&2
  exit 1
fi

# pnpm is required (workspace:* deps are rewritten to real versions only by pnpm publish),
# and it must be on PATH because turbo re-invokes it during the build.
# When absent, install a corepack shim into a temp dir and prepend it.
if ! command -v pnpm >/dev/null 2>&1; then
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  shim_dir="$(mktemp -d)"
  corepack enable --install-directory "$shim_dir" pnpm
  export PATH="$shim_dir:$PATH"
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Fresh dist before publishing.
(cd "$repo_root" && pnpm release:build)

for package_dir in packages/core packages/catalog packages/toolkits packages/sdk; do
  (
    cd "$repo_root/$package_dir"
    pnpm publish --access public --no-git-checks
  )
done
