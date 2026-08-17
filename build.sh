#!/usr/bin/env bash

set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "${repo_dir}"

npm --prefix frontend run build
cargo install --path . --locked
echo "Build completed successfully."
echo "Executable located at: ${CARGO_HOME:-$HOME/.cargo}/bin/jian"
