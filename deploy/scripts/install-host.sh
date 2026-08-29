#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ "$#" -ne 2 ]]; then
  echo "Usage: install-host.sh TELEGRAM_TOKEN_FILE BRIDGE_TOKEN_FILE" >&2
  exit 1
fi

telegram_token_file="$(realpath "$1")"
bridge_token_file="$(realpath "$2")"
deploy_root="$(realpath "$(dirname "$0")/..")"

dnf install -y \
  containernetworking-plugins \
  curl \
  firewalld \
  fuse-overlayfs \
  git \
  jq \
  podman \
  shadow-utils \
  slirp4netns \
  uidmap \
  zstd

if ! id loylex >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash loylex
  passwd --lock loylex
fi

loginctl enable-linger loylex
systemctl enable --now firewalld
firewall-cmd --permanent --add-service=ssh
firewall-cmd --reload

if [[ -z "$(swapon --show --noheadings)" && ! -e /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap defaults 0 0\n' >>/etc/fstab
fi

install -d -m 0700 -o loylex -g loylex /home/loylex/.config/containers/systemd
install -d -m 0700 -o loylex -g loylex /home/loylex/.config/systemd/user
install -d -m 0700 -o loylex -g loylex /home/loylex/.local/bin
install -d -m 0700 -o loylex -g loylex /home/loylex/backups/loylex

install -m 0644 -o loylex -g loylex \
  "$deploy_root"/quadlet/* \
  /home/loylex/.config/containers/systemd/
install -m 0644 -o loylex -g loylex \
  "$deploy_root"/systemd/* \
  /home/loylex/.config/systemd/user/
install -m 0755 -o loylex -g loylex \
  "$deploy_root"/scripts/loylex-backup \
  /home/loylex/.local/bin/loylex-backup

runtime_directory="/run/user/$(id -u loylex)"
install -d -m 0700 -o loylex -g loylex "$runtime_directory"

if ! runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
  podman secret inspect loylex-telegram-token >/dev/null 2>&1; then
  runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
    podman secret create loylex-telegram-token - <"$telegram_token_file"
fi
if ! runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
  podman secret inspect loylex-bridge-token >/dev/null 2>&1; then
  runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
    podman secret create loylex-bridge-token - <"$bridge_token_file"
fi

runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" systemctl --user daemon-reload
runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
  systemctl --user enable podman-auto-update.timer loylex-backup.timer
runuser -u loylex -- env XDG_RUNTIME_DIR="$runtime_directory" \
  systemctl --user start podman-auto-update.timer loylex-backup.timer
