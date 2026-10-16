#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "${repo_dir}"

backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/jian-build.XXXXXX")
had_dist=0
if [[ -d web/dist ]]; then
  had_dist=1
  cp -a web/dist "${backup_dir}/dist"
fi
previous_version=''
restore_on_failure() {
  local result=$?
  trap - EXIT
  if ((result != 0)); then
    if [[ -n "${previous_version}" ]]; then
      node scripts/build-version.mjs --version "${previous_version}" --keep-version >/dev/null || true
    fi
    if ((had_dist)); then
      rm -rf web/dist
      cp -a "${backup_dir}/dist" web/dist
    else
      rm -rf web/dist
    fi
  fi
  rm -rf "${backup_dir}"
  exit "${result}"
}
trap restore_on_failure EXIT

version_args=("$@")
version_result=$(node scripts/build-version.mjs "${version_args[@]}")
previous_version=${version_result%% *}
selected_version=${version_result#* }

echo "Building Jian ${selected_version}."
echo "Version options: --version x.y.z, --keep-version (-kv)."

npm --prefix frontend run build
cargo install --path . --locked --bin jian --bin jian-client
trap - EXIT
rm -rf "${backup_dir}"
echo "Build completed successfully."
echo "Executables located at: ${CARGO_HOME:-$HOME/.cargo}/bin/jian and jian-client"
