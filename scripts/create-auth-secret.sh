#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
secret_parent="$project_dir/deploy/.secrets"
secret_dir="$secret_parent/auth"
mkdir -p "$secret_dir"
chmod 700 "$secret_parent"
chmod 755 "$secret_dir"
if [[ -e "$secret_dir/code_secret" ]]; then
  echo 'Existing auth code secret preserved.'
  exit 0
fi
secret_tmp="$(mktemp "$secret_dir/code_secret.XXXXXX")"
trap 'rm -f -- "$secret_tmp"' EXIT
openssl rand -hex 32 > "$secret_tmp"
chmod 444 "$secret_tmp"
# A hard link installs the complete file atomically and never replaces a secret.
if ln "$secret_tmp" "$secret_dir/code_secret" 2>/dev/null; then
  echo 'Auth code secret created. Its value is not printed.'
elif [[ -e "$secret_dir/code_secret" ]]; then
  echo 'Existing auth code secret preserved.'
else
  echo 'Could not create auth code secret.' >&2
  exit 1
fi
