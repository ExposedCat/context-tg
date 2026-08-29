# Chat Context | Telegram

## Codex chat runtime

Normal chat generation runs through a separate Codex app-server container.
The bot opens an authenticated WebSocket connection, starts a durable Codex
thread for a new Telegram conversation, and stores that thread UUID in the
existing `response_id` columns. Later messages resume the same thread and send
only the new message and attachments; the bot no longer reconstructs and sends
the full conversation to the Azure Responses endpoint.

`LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_TEMPERATURE` are now optional legacy
settings. If the URL/key pair is kept, it is used only by the existing memo
pruning job, not for Telegram conversation turns.

Codex receives the bot's existing tools as dynamic tools, so message search,
image search, schedules, memos, stickers, reports, and reply selection still run
inside the bot with the current Telegram/database context. Codex's built-in
shell, file editing, web search, image generation, and multi-agent features are
disabled for these threads.

The image installs `@openai/codex` at the version selected by `CODEX_VERSION`
(`0.151.0` by default). Configure authentication in `.env` with an OpenAI API
key:

```dotenv
OPENAI_API_KEY=...
CODEX_APP_SERVER_TOKEN=replace-with-a-long-random-token
# Optional; otherwise the existing /model setting or Codex default is used.
CODEX_MODEL=your-codex-model
```

Alternatively, persist a ChatGPT login directly in the Codex volume before
starting the stack:

```sh
docker compose run --rm --entrypoint codex codex login --device-auth
```

`CODEX_HOME` is `/codex-home`, backed by the persistent `codex_home` named
volume. A completed conversation can therefore be resumed after the Codex
container is replaced or restarted. `docker compose down -v` intentionally
deletes this history. Old Azure response IDs are not Codex thread UUIDs, so the
first message after migration starts a new Codex thread without replaying the
old Azure history.

The service defaults to 512 MiB RAM with no additional swap, one CPU, 128 PIDs,
a read-only root filesystem, and a 64 MiB `/tmp`. Compose does not provide a
portable hard quota for persistent local volumes, so the entrypoint enforces a
fail-closed 512 MiB high-water limit (`CODEX_HOME_MAX_BYTES`). It checks every
30 seconds and stops Codex if the volume crosses the limit; it never silently
deletes chats. To perform maintenance after that happens, bypass only the guard
for the one-off command:

```sh
docker compose run --rm --entrypoint codex \
  -e CODEX_HOME_QUOTA_BYPASS=1 codex delete THREAD_ID
```

The limits can be adjusted with `CODEX_MEMORY_LIMIT`, `CODEX_CPU_LIMIT`,
`CODEX_HOME_MAX_BYTES`, and `CODEX_HOME_CHECK_INTERVAL_SECONDS`. The app-server
port is available only on the Compose network and requires the shared bearer
token.

## Remembered-message search

Chat search combines the existing dense embeddings with Qdrant full-text
matching. Ranked lists are fused, then each of the six best message anchors is
expanded with three messages before and after it. Overlapping windows are
merged, and a matched message's reply parent is included when it is available.

The bot creates the required full-text `text` payload index automatically.
Qdrant is pinned in `compose.yml` because phrase matching requires Qdrant 1.15
or newer. Before deploying over an older persistent Qdrant volume, take a
snapshot and follow Qdrant's sequential minor-version upgrade guidance.

Existing messages gain lexical search when the payload index is created. The
new `reply_to_message_id` payload is recorded only when a message is newly
indexed or edited, so older messages still receive chronological context but
cannot include a distant reply parent until they are reindexed.

Agents can follow up on any known result with `get_message_context`. Given a
message ID and a radius from 1 to 10, it returns that many remembered messages
before and after the target and marks whether the target itself was found.

## Image search

Compose runs an internal SearXNG service for `search_images`. It exposes only
JSON search responses and loads only the Google, Brave, Bing, and DuckDuckGo
image engines. Failed engines are ignored while results from successful engines
are returned. The service has no limiter, engine suspension, Valkey, plugins,
metrics, autocomplete, favicon lookup, or image proxy. It is reachable by the
bot over the Compose network and bound only to host loopback on port 8080 for
local development; it is not publicly exposed.
Its configuration is baked into the local image so SELinux labels on the bot's
repository bind mount cannot make the settings unreadable to SearXNG.

`search_images` returns direct `image_url` values and source metadata. The agent
then calls `read_image` with one of those URLs to provide the selected image to
the vision model. `read_image` also accepts a saved image ID from a
`tg://photo` or `tg://document` reference. Existing JPG, MP4, MP3, OGG, and GIF
URLs can be inserted into a response with `![](URL)` or
`![](URL "caption")`.

## Saved images

Set `MEDIA_CACHE_CHAT_ID` to a private group or channel where the bot can send
photos. Generated images are uploaded to that chat once, and their Telegram
`file_id` values are stored in SQLite behind persistent `image_<uuid>` IDs.
Photos and image documents received from Telegram are registered directly from
their existing `file_id` and use persistent `tg://photo` or `tg://document`
references in live context and newly indexed message-search results. Telegram
album membership is retained as `media_group_id` in prompt and search metadata.

Agents receive `![](tg://photo?id=IMAGE_ID)` from the image generation tool and
can place those references anywhere in rich Markdown, including collages and
slideshows. Before sending, the bot resolves every referenced ID from SQLite
and supplies its Telegram file ID through the rich message `media` field.
Normal, guest-inline, scheduled, and repeating-message delivery all resolve the
same mappings.
