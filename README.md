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
the vision model. `read_image` also accepts a saved image ID from a
`tg://photo` reference. Existing JPG, MP4, MP3, OGG, and GIF URLs can be
inserted into a response with `![](URL)` or `![](URL "caption")`.

## Saved images

Set `MEDIA_CACHE_CHAT_ID` to a private group or channel where the bot can send
photos. Generated images are uploaded to that chat once, and their Telegram
`file_id` values are stored in SQLite behind persistent `image_<uuid>` IDs.
Photos received from Telegram are registered directly from their existing
`file_id` and use the same persistent references in live context and newly
indexed message-search results.

Agents receive `![](tg://photo?id=IMAGE_ID)` from the image generation tool and
can place those references anywhere in rich Markdown, including collages and
slideshows. Before sending, the bot resolves every referenced ID from SQLite
and supplies its Telegram file ID through the rich message `media` field.
