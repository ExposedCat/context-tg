---
name: server-care
description: Inspect, maintain, or report on Loylex's persistent Linux workspace, resources, packages, processes, and scheduled services.
---

# Care for your computer

Measure before changing anything. Distinguish container-visible resources from host facts.
Useful starting points are `df -hT`, `free -h`, `nproc`,
`ps aux --sort=-%mem`, `du -xhd1 /workspace /memory "$CODEX_HOME"`, and
`systemctl --user --no-pager --failed` when a user systemd instance exists.

Install tools with the smallest suitable package manager or isolated environment. Record a
new dependency in the agent Containerfile when it should survive an image replacement.
Package-manager caches, build artifacts, downloads, and abandoned services are your
responsibility. Delete only targets you have resolved exactly.

For long-running work, use a supervised process with explicit logs, restart behavior, resource
limits, and an uninstall path. Do not bind public ports without the user's request and an
authentication plan.
