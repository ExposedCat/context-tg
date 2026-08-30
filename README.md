# Loylex

Loylex is a persistent, self-evolving Codex agent that lives in Telegram and owns a
sandboxed Fedora workbench on its personal VPS.

Write `loylex …` or `лойлекс …` in any supported case, or reply to a
Loylex answer. A reply resumes the exact Codex thread. The agent can work in its terminal for
as long as needed, remember private context, improve its own skills, search the complete
archived chat, and deliver native Telegram Rich Messages.

## Shape

```text
Telegram Bot API 10.2
        |
        v
gateway container                 agent container
- only holder of bot token        - Codex gpt-5.6-luna / max
- raw update archive              - Fedora 44 workbench
- SQLite WAL + FTS5               - terminal, sudo, packages, subagents
- trigger/thread routing          - private memory and buckets
- rich streaming/editing          - repo-scoped Git push key
        |                                  |
        +------ authenticated bridge ------+
                          |
                          v
                 host supervisor
                 - fixed restart/deploy API
                 - no arbitrary host commands
```

The bridge exposes jobs, archive search, media transfer, status, and scoped outbound
Telegram operations. It never exposes the Telegram token. The agent has no host Podman
socket, host PID namespace, host devices, privileged mode, or host mounts. The gateway image
is pinned by digest, and `main` requires review, so an agent-authored branch cannot replace
the component holding the secret.

An authenticated host-local supervisor lets the agent restart or deploy only the Loylex
agent and gateway. It validates workspace changes, pins pulled images by digest, verifies
container health, and rolls Quadlet image references back when deployment fails. The agent
never receives a Podman socket, systemd bus, general host shell, or host reboot capability.

Root inside the agent is root only in a rootless user namespace. It can maintain its own
computer but cannot reboot or kill the Rocky Linux host.

## Persistence

Four named volumes survive image replacement:

| Volume | Contents |
| --- | --- |
| `loylex-gateway-data` | SQLite archive, jobs, Telegram/Codex thread mapping |
| `loylex-agent-home` | Codex auth and sessions, SSH deploy key, user config |
| `loylex-memory` | Private memories, journals, knowledge, conditional buckets |
| `loylex-workspace` | Loylex repo and all agent projects/experiments |

The repository contains public skills and personality/instructions. Private memory is never
mounted into the gateway and is never committed. Daily compressed volume backups are kept
for 14 days.

The agent starts its TypeScript runtime from the mounted `/workspace/Loylex` repository.
After checks pass, a supervised restart therefore applies its self-authored agent changes
without replacing memory, Codex sessions, or the workspace.

## Self-management

```bash
loylex system status
loylex system restart agent
loylex system restart gateway
loylex system restart all
loylex system deploy agent
loylex system deploy gateway
loylex system deploy all
```

Restart and deploy operations default to a 15-second delay so the scheduling Telegram task
can send its final response. An optional final argument changes the delay from 5 to 300
seconds. Deploying runs the repository checks for agent changes, pulls the selected `main`
images, records exact digests in the live Quadlets, restarts the data plane, and performs live
health checks. The supervisor itself stays outside both containers.

## Telegram behavior

Every Bot API update is stored raw. Messages and edits are normalized, reply relationships
and media file IDs are retained, and text is indexed with FTS5. On a trigger, the latest chat
window and matching private memory buckets are added to the request.

While Codex works, terminal and reasoning events create or edit one persistent Rich Message
with a collapsed `<details>` history in every chat. Completion replaces that same message
with the same collapsed `<details>` history and the final Rich Markdown.
Rich API errors are surfaced instead of silently sending the same document as unformatted text.
Replying `/stop` to any Loylex message belonging to an active job cancels that Codex thread;
the command is consumed and is not submitted as a new prompt.
Telegram Bot API 10.2 supports up to 32,768 UTF-8 characters,
500 rich blocks, tables, LaTeX, inline media, collages, slideshows, audio, custom emoji,
quotes, and headings.

Loylex uses the same persistent editable Rich Message path in groups and private chats.

## Initial chat backfill

Bots cannot request arbitrary old group history from the Bot API. Export the chat as
machine-readable JSON from Telegram Desktop and import it:

```bash
podman cp result.json loylex-gateway:/tmp/result.json
podman exec loylex-gateway \
  bun /app/src/gateway/import.ts /tmp/result.json --chat-id -1001234567890
```

The importer understands Telegram Desktop text entities, edits, replies, and exported media
paths. Future updates are archived automatically.

For a group archive to include ordinary future messages, disable privacy mode for the bot in
BotFather. Without that setting Telegram intentionally sends the bot only commands, replies,
and service events.

## Development

```bash
bun install
bun run check
podman build -f containers/gateway.Containerfile -t loylex-gateway .
podman build -f containers/agent.Containerfile -t loylex-agent .
```

Reviewed main-branch pushes test the TypeScript runtime and publish
`ghcr.io/chelokot/loylex-gateway:main` and
`ghcr.io/chelokot/loylex-agent:main`. Rootless Podman auto-update replaces the agent
container while leaving all volumes intact. Gateway updates are deliberately pinned by
digest and require updating its Quadlet after reviewing the secret-holding code.

## Host installation

On Rocky Linux 10, create two root-readable files containing the Telegram token and a random
bridge secret, then run:

```bash
sudo deploy/scripts/install-host.sh /root/loylex-telegram-token /root/loylex-bridge-token
```

The installer creates the locked `loylex` host user, enables lingering rootless
Podman, installs Quadlets and the narrow self-management supervisor, adds a 4 GiB swap file
when the server has no swap, opens only SSH, and enables backups and registry auto-update for
the agent.

The agent still needs:

1. a writable GitHub deploy key scoped only to `chelokot/Loylex` in its persistent
   home volume; protected `main` rejects direct changes while personal branches remain
   writable;
2. `$CODEX_HOME/auth.json` created with `codex login --device-auth` or copied
   through a trusted channel;
3. the two Quadlet services started with `systemctl --user start loylex-gateway
   loylex-agent`.

Never commit either Telegram or Codex credentials.

## Credit and provenance

Loylex is a GitHub fork of
[ExposedCat/context-tg](https://github.com/ExposedCat/context-tg), created by Artem Prokop.
The original commit history remains intact. Artem's durable-thread, remembered-chat, media,
and rich-message work was the conceptual launchpad; респект Артёму.

The upstream repository did not contain a license file when this fork was created. See
[NOTICE.md](NOTICE.md) before redistributing derivative code.
