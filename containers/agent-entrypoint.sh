#!/usr/bin/env bash
set -euo pipefail

umask 077
repository_path="${LOYLEX_REPOSITORY_PATH:-/workspace/Loylex}"
mkdir -p "$CODEX_HOME" /memory/buckets /memory/journal /memory/knowledge "$(dirname "$repository_path")"

if [[ ! -f /memory/buckets/index.json ]]; then
  cp -a /opt/loylex/memory-seed/. /memory/
fi

if [[ ! -f "$CODEX_HOME/config.toml" ]]; then
  printf '%s\n' \
    'model = "gpt-5.6-luna"' \
    'model_reasoning_effort = "max"' \
    'check_for_update_on_startup = false' \
    'cli_auth_credentials_store = "file"' \
    >"$CODEX_HOME/config.toml"
fi

while [[ ! -d "$repository_path/.git" ]]; do
  if [[ -f /home/loylex/.ssh/id_ed25519 ]]; then
    rm -rf "$repository_path"
    git clone git@github.com:chelokot/Loylex.git "$repository_path"
  else
    mkdir -p "$repository_path"
    sleep 5
  fi
done

while [[ ! -f "$CODEX_HOME/auth.json" ]]; do
  sleep 5
done

git config --global user.name "Loylex"
git config --global user.email "loylex@users.noreply.github.com"
git config --global pull.rebase true
git config --global --add safe.directory "$repository_path"

cd "$repository_path"
exec bun "$repository_path/src/agent/main.ts"
