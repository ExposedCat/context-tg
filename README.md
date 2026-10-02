# Chat Context | Telegram

## Threaded DMs

Enable **Threaded Mode** for the bot in BotFather to use separate topics in
private chats. The bot responds to text and images in all private chats without
a name trigger or a reply, including messages without a topic ID when Threaded
Mode is disabled. Each topic continues its own conversation and retains
its selected agent and alias. An explicit reply continues from that message;
an explicit agent trigger can change the topic's agent.

The first text request in a DM topic also generates its name using the responding
agent's model. The naming call uses a separate prompt without tools or conversation
history. Its entire response, trimmed, becomes the topic name; if generation fails
or returns an empty name, the bot uses the first three words of the request.

Responses, reports, typing indicators, and scheduled messages stay in the
originating topic. Message search and recent-history tools support the current
DM topic through `target=topic_thread`; `target=group` searches the whole chat.
Conversation links persist in SQLite across restarts. Enable the BotFather
option that lets users create threads if users should manage their own topics.

## Trigger names

Set `NAMES` to a comma-separated list of normal-agent aliases, for example
`NAMES=laylo,patrick,патрик,лейло,grok,грок,@grok,@грок`. Surrounding whitespace
and empty entries are ignored. When unset or empty, the aliases default to
`laylo,лейло`. Restart the bot after changing `NAMES`.

The matched alias is used in the agent's identity prompt and retained for
follow-up replies. Mentions of the bot's actual username use the first alias.
Guest mode keeps its own first name; the other agents keep their own aliases.

## Incoming rate limiting

The bot uses [grammY ratelimiter](https://grammy.dev/plugins/ratelimiter) to
allow up to 10 updates per user every 2 seconds across chats. Excess updates
are silently dropped before telemetry, message indexing, commands, and LLM
processing. The burst allowance accommodates photo albums. Updates without
a sender user ID bypass the limiter.

Counters are held in memory per bot process and reset on restart. This limits
user spam; it does not provide network-level DDoS protection. Adjust
`USER_RATE_LIMIT_TIME_FRAME_MS` and `USER_RATE_LIMIT_MAX_UPDATES` in `src/bot.ts`
to change the limits.

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

Image generation uses the same `LLM_BASE_URL` and `LLM_API_KEY` as the main LLM.
Set `/model image_small DEPLOYMENT_NAME` and `/model image_big DEPLOYMENT_NAME`
for the primary image models, and `/model image DEPLOYMENT_NAME` for their shared
fallback (shown as “Fallback” in settings). The optional `size` tool argument
selects `small` (the default) or `big`; an unset or failed primary uses the fallback.
`LLM_IMAGE_MODEL` is no longer used. Both use
`/images/generations` under the shared base URL; primary image edits use
`/images/edits`. Separate image endpoint and API key variables are no longer used.

## Trolling tone

Each chat can select one of three modes using the existing buttons under
`/settings` → Trolling. The selected mode is highlighted:

- `aggressive`: the original crude, profane style with harsh personal roasts.
- `mild`: softer, playful roasts with light context-specific name-calling and
  occasional profanity, without aggressive personal abuse.
- `clean`: wordplay, situational sarcasm, and nitpicking the wording or logic,
  without name-calling or profanity. This is the default.

Automatic trolling triggers at every configured message interval, without a
random chance. It first generates a candidate, then makes a separate stateless
Responses API call to `gpt-61-sol` with reasoning effort `high` and strict
structured output `{ valid: boolean }`. The validator receives recent messages,
the exact candidate, and the selected mode. It rejects generic,
off-topic, or inappropriate replies; a `false` verdict means nothing is sent
and no replacement is generated. A validation failure or invalid response also
prevents sending and is reported through the automatic-response error log.

The validator uses the existing `LLM_BASE_URL` and `LLM_API_KEY`, so that endpoint
must support `gpt-61-sol` and Responses structured outputs. No alternative model
or JSON-mode fallback is used. Generation and validation each cost one request
credit, including a validation that rejects the candidate. If the remaining
balance cannot fund validation, the candidate is not sent. This gate applies to
automatic trolling; explicit troll-agent conversations keep their existing flow.

If automatic trolling and proactive responses both trigger on the same message,
the bot randomly chooses one with equal probability. Both message counters
advance, but only the chosen response runs and spends credits. If the chosen
troll is rejected or the chosen response fails, the bot does not try the other.

The application injects only the selected style into generation and validation
prompts. Neither call receives a catalogue of the other modes to choose from.

Only chat admins can change the mode. It applies to automatic trolling and
explicit troll-agent conversations, including follow-ups. Changing the mode
preserves the interval, enabled state, and message counter. `/trolling 100`
continues to set the message interval, not the intensity.

Database initialization adds `chat_trolling.trolling_mode`, defaulting to
`clean`. Existing two-mode preferences migrate once: `allow_insults = 1`
becomes `mild`, and `0` becomes `clean`. Original databases without a tone
setting use `clean`. Later startups preserve the selected mode.
These are model instructions, not an output filter; evaluate the tone with
the deployed model.
