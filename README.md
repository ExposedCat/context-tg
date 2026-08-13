# Chat Context | Telegram

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
the vision model. When the image should be delivered to the chat, `send_image`
attaches that existing URL through the same response path as `generate_image`.
