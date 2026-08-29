#!/usr/bin/env bash
set -euo pipefail

umask 077
mkdir -p "$CODEX_HOME" /memory/buckets /memory/journal /memory/knowledge /workspace

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

while [[ ! -d /workspace/Loylex/.git ]]; do
  if [[ -f /home/loylex/.ssh/id_ed25519 ]]; then
    rm -rf /workspace/Loylex
    git clone git@github.com:chelokot/Loylex.git /workspace/Loylex
  else
    mkdir -p /workspace/Loylex
    sleep 5
  fi
done

while [[ ! -f "$CODEX_HOME/auth.json" ]]; do
  sleep 5
done

git config --global user.name "Loylex"
git config --global user.email "loylex@users.noreply.github.com"
git config --global pull.rebase true
git config --global --add safe.directory /workspace/Loylex

exec bun /opt/loylex/app/src/agent/main.ts
