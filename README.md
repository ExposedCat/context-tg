# Chat Context | Telegram

## Finance MCP

Anyone can open `/settings`. In groups, the command and menu are ephemeral,
visible only to the person who opens them. The menu shows only controls they may use:
chat admins retain Emoji, Trolling and Proactive controls, while Models, Debug
and Effort remain restricted to the bot admin.

**Finance MCP** is a personal toggle, off by default. It is saved by Telegram
user ID in SQLite and applies across chats. When enabled, requests from that
user discover Eyri's MCP reports and expose them to the model as `finance_*`
tools. The bot supplies the requesting user's Telegram ID itself; the model
cannot choose another portfolio. In groups, report answers are sent to that
group. Open `/start` in Eyri first to create the account.

Local development defaults to `http://127.0.0.1:8000/mcp`. Disabled users cause
no MCP connection or discovery calls.
If Eyri is unavailable or report discovery fails, the request continues without
finance tools. Later requests try discovery again.

For PM3 (Podman Compose), both projects' Compose files connect their app service
to the external `finance-mcp` network. Context defaults to
`http://eyri_app:8000/mcp`. Create the network once before starting either app. Set
`FINANCE_MCP_NETWORK` and `FINANCE_MCP_URL` in `.env` to override the network
name and endpoint. Set the same network override in Eyri's `.env` too. PM3's
down/up restarts leave this external network intact, allowing either app to
restart independently. Both apps retain their existing volumes and PM3 projects.

On `kitkat@server.local`, the PM3 projects are named `eyri` and `context`:

```sh
podman network exists finance-mcp || podman network create finance-mcp
pm3 restart eyri -y -g
pm3 restart context -y -g
```

Use these restarts after both updated repositories are available to PM3. The
Compose network change requires recreating both app containers; merely restarting the
Deno process does not attach the network. Eyri's host port stays bound to
loopback; Context accesses MCP directly over the container network.

## Text credits

Each request costs **1 credit**, plus **1 credit per 620 tokens** of assistant
progress text and final answers, configured by `TOKENS_PER_CREDIT`. Text usage
accumulates as exact token counts across requests, rather than rounding every
reply up to a credit; `/usage` displays credits to three decimal places.
For example, 310 generated text tokens cost 1.5 credits including the request fee.

The fixed fee is charged once when accepting a request, including resumed and
automatic requests, without charging again for model retries or tool follow-ups.
Input rejected by the user-message limit is not charged. Input, context, hidden
reasoning, tool arguments, thread titles and automatic validation verdicts do not
spend text credits.
Tool charges remain 1 credit per execution, an extra 1 for web search, and
5 per image-generation attempt. These charges share the same daily balance.
Requests from `ADMIN_ID` always bypass credit limits in private chats, groups,
guest mode and automatic responses, including tool and image charges. Their
usage is still recorded; the exemption never changes the chat's quota or grants
unlimited usage to other users.

Before generating an answer, the app atomically reserves available text tokens
so parallel requests and tools cannot spend the same balance. Unused allowance
is released after completion or cancellation. While streaming, the app counts
visible text and aborts when its funded allowance runs out, keeping the bounded
partial answer and adding a limit notice. Token batching may deliver several
tokens together; only the funded portion is retained and charged. Non-streaming
providers instead receive an output cap; streaming is required for live text
cancellation. Unknown provider-side reasoning costs never become text credits.

The migration preserves existing usage and limits. Reservations expire after
two minutes if a process crashes, longer than the 90-second model timeout.

## Per-request token limits

The incoming user message plus its immediate reply text have a combined
5,000-token limit, counted with the text tokenizer before model calls or credit
reservations. Captions and rich message text count; reply chains, thread history,
instructions, tool definitions and media do not. Configure these limits in `.env`:

- `LLM_REQUEST_TOKEN_BUDGET=64000`: cumulative generated tokens, including reasoning,
  across model calls, tool follow-ups, thread naming and delivery recovery.
- `LLM_MAX_OUTPUT_TOKENS=8192`: output per model call, including reasoning.
- `LLM_MAX_USER_INPUT_TOKENS=5000`: combined current message and immediate reply text.
- `LLM_MAX_TOOL_CALLS=12`: total tool executions per request, including parallel batches.

Before each model call, the app reserves output allowance, then reconciles it
with provider-reported output usage. Input and replayed context do not consume
this generation budget. Failed attempts without usage retain their output
reservation; validation and rate-limit rejections release it. Tool results are
limited to 16 KB each with an explicit truncation notice. Image generation
retains its existing credit charges and its reported output tokens count toward
the remaining generation budget after generation.

Budget exhaustion and output-limit responses stop immediately without retries.
The user receives a short explanation asking for a smaller task. All responding
agents are instructed to reject meaningless long requests aimed at draining
tokens, including repetitive generation and excessive reading or tool loops.

## Progress updates and timing

Text-model calls use Responses API streaming by default (`LLM_STREAMING=true`),
including tool follow-ups, thread naming and trolling validation. Stream events
are available to the application through `onStreamEvent` while generation is
running. Telegram delivery still uses the existing progress batching and final
response flow. Set `LLM_STREAMING=false` for a provider that does not support SSE.

Use `/tasks` to find the cancellation link `/cancel_<message-id>` for a running
normal chat task. Cancellation aborts its active HTTP connection and any tools
using the task's signal, even while the stream is waiting for its next event.
This already works for non-streamed requests too. Stopping the connection asks
the provider to stop a foreground generation; tokens already generated remain
chargeable. There is no separate cancellation API for these `store:false`
foreground responses, and cancellation cannot recover work completed earlier.
Guest responses and periodic trolling do not have normal chat task cancel links.

Incomplete or broken streams never execute partial tool arguments. A connection
failure after stream events stops without automatic replay of that generation;
the previous complete context is preserved for an explicit continuation. An
aborted stream without final usage retains its reserved token allowance.

Each text-model HTTP attempt has a 90-second timeout. The application can retry
within the shared request budget; SDK retries are disabled so attempts cannot
bypass accounting. The timeout applies separately to each
model call, including calls after tool results, thread naming and trolling
validation; it is not a deadline for the entire task.

**Progress updates** is a per-chat `/settings` toggle, enabled by default and
controlled by chat admins (or the user in a private chat). During conversation
requests, the bot sends at most one progress message every 30 seconds. Azure's
intermediate assistant messages are combined in order, with their tools on a
separate final line. Every progress message ends that icon list with custom emoji
`5427181942934088912`, including split messages and updates without tools.
Updates with assistant text include only tools from those new parts;
a repeated tool appears again if called again. The final answer retains all tools
used across the request. Tool names without a configured icon are shown as text.

Without assistant text, new tool calls can produce a summary after 60 seconds
since the last update,
for example `Searched web, read 3 webpages`, with their icons below. Repeated
calls are counted within each batch; previously delivered activity is not repeated.
After five minutes without real assistant text or a delivered idle update, and
with no new tool calls, the bot randomly sends `Thinking...`, `Working...`,
`Analyzing...`, or `Processing...`. Further idle placeholders are at least
five minutes apart; incoming or delivered real text restarts the idle wait.
Queued text at completion is included with the final answer. Oversized batches
are carried into later intervals to keep each progress update a single Telegram
message. Cancellation and completion stop the timer; failed progress deliveries
retain their queued text. Automatic trolling quality checks and guest-query
answers do not publish intermediate chat messages.

Each `llm_call` telemetry event includes `duration_ms` for the entire model/tool
loop, including retries, tools, and final generation. Timing is also recorded on
failed calls and trolling validation calls. `progress_intervals_ms` records gaps
between Azure responses that continue into tool calls (or contain explicit
`commentary` messages); the first gap starts at request start. These timings are
collected even with progress delivery disabled.
Telegram batching, placeholders and bookkeeping callbacks do not add samples.
`progress_count`, `progress_total_ms`, `progress_median_ms`, `progress_min_ms`,
and `progress_max_ms` summarize those intervals for each full call. Calls without
intermediate responses have zero samples; their final wait is still included in
`duration_ms`. Durations use a monotonic clock.

New SigNoz SQL panels retain the existing time-range and `bucket`, `chat_type`,
`mode`, `status`, and `tools` filtering conventions, and display seconds:

- [Call duration](docs/signoz-call-duration.sql): bucketed median/minimum/maximum
  full-call time, grouped by chat type, mode and status.
- [Progress timings](docs/signoz-progress-timings.sql): bucketed Azure interval
  statistics and total progress time. Each call has equal weight in the median
  of per-call medians; extrema cover all included calls.
- [Per-call timings](docs/signoz-call-timings.sql): one table row per full call,
  with duration and its own progress count, total, median, minimum and maximum.

Historical events without duration fields are excluded. Progress charts exclude
calls without intervals; the per-call table displays NULL for their statistics.

## Threaded DMs

Enable **Threaded Mode** for the bot in BotFather to use separate topics in
private chats. The bot responds to text and images in all private chats without
a name trigger or a reply, including messages without a topic ID when Threaded
Mode is disabled. Each topic continues its own conversation and retains
its selected agent and alias. An explicit reply continues from that message;
an explicit agent trigger can change the topic's agent.

When Telegram omits the topic ID from a new DM topic's first message, the bot
recovers it from the immediately preceding implicit topic-creation event. This
also keeps commands and initial photo albums in that topic. The recovery applies
only to private chats; forum groups and ordinary group replies keep their existing
routing.

The first text request in a DM topic also generates its name using the responding
agent's model. The naming call uses a separate prompt without tools or conversation
history. Its entire response, trimmed, becomes the topic name; if generation fails
or returns an empty name, the bot uses the first three words of the request.

Responses, reports, typing indicators, and scheduled messages stay in the
originating topic. Message search and recent-history tools support the current
DM topic through `target=topic_thread`; `target=group` searches the whole chat.
Conversation links persist in SQLite across restarts. Enable the BotFather
option that lets users create threads if users should manage their own topics.

## Conversation context

Conversation requests use native Responses API compaction with `store: false`.
Set `LLM_COMPACT_THRESHOLD` to a positive integer token threshold (default:
100,000). Choose a value below the smallest conversation deployment's context
window, leaving room for instructions, tool definitions, tool results, and
generation. The configured deployments must support native compaction.

When the API returns a `compaction` item, the bot retains that encrypted item
and everything after it as the next context window. The compacted window and
memory state are saved in SQLite, so continuation and replies to older
checkpoints keep working across restarts.

Tool results, including `web_search`, `search_chat`, and `read_web_page`
outputs, stay in the history until native compaction replaces them.

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

## Danbooru search

All conversation agents have `search_danbooru` for illustration searches and
`search_danbooru_tags` for discovering tag names. Use space-separated tags with
underscores for multiword names, for example `1boy solo` or `blue_hair`;
`-tag` excludes a tag and `*pigeon*` looks up matching tag names. Post search
returns direct image URLs for `read_image` and Markdown image display, plus
post links, ratings, scores, and tags. Results default to 10, with a maximum
of 20 per call and page-based pagination.

Add `/rating:VALUE`, `/order:VALUE`, or both at the end of a message or image
caption, in either order:

```text
Hey laylo find me anime boy /rating:s /order:score
Hey laylo find me a pigeon art /order:score
```

The suffix is replaced by one `(use danbooru)` in saved message text and agent
input. For `/rating:e` or `/rating:explicit` (case-insensitive), it instead uses
`(use only danbooru, don't search web, you are strictly unallowed to view images yourself due to licensing, send it to user directly and notify)`.
The tool instructs the model to send explicit-rated results directly with source
links and notify the user that it has not viewed them, and does not request
`read_image` for those results.
Explicit searches return an empty query `tags` field. Explicit-result metadata
has empty `tags` and series/copyright fields and a returned rating of `g`;
the actual API search rating and direct-send instructions are preserved.
The application retains the supplied values separately for that request
and overrides the agent's corresponding Danbooru parameters and query metatags.
Unspecified options remain the agent's choice; overrides do not carry into the
next message. When the final query has no ordering, `order:score` is added;
ordering already provided in the query, parameters, or user suffix is preserved.
Options inside the message body are ordinary text, and the last
occurrence of a repeated suffix option wins. Values are passed through unchanged
without validation. Danbooru documents ratings `g`, `s`, `q`, `e` and orders
such as `score`, `rank`, `id`, and `random`; invalid values are left to the API.

Public searches work without credentials, subject to Danbooru account and tag
limits. Query length is left to the API and the authenticated account's limits.
If the API rejects a query for exceeding its term limit, the model receives the
API's actual error message and guidance to simplify and retry while preserving
the user's rating/order overrides.

Optionally set `DANBOORU_USERNAME` and `DANBOORU_TOKEN` for authenticated
searches. `DANBOORU_TOKEN` is the account's API key, used with the username
through HTTP Basic authentication; Danbooru does not support token-only Bearer
authentication. The existing `DANBOORU_API_KEY` remains supported as a fallback
when `DANBOORU_TOKEN` is unset. Credentials are sent only to the Danbooru API.

## Response formatting

Agents generate Telegram Rich Markdown, with real Markdown lists (`- item`),
blank lines between paragraphs and block elements, and `<br>` for explicit line
breaks inside a paragraph. Tables use `<table bordered striped>` without
`compact`, with text columns aligned left and numeric columns aligned right.
Table cells use HTML inline formatting because Telegram does not parse Markdown
inside HTML tables.

These rules are part of the shared agent instructions. Delivery preserves source
whitespace and markup; it does not infer missing line breaks or repair lists and
tables. Ordinary dollar signs are escaped so Telegram does not parse currency as
LaTeX.

## Saved images

Set `MEDIA_CACHE_CHAT_ID` to a private group or channel where the bot can send
photos. Generated images are uploaded to that chat once, and their Telegram
`file_id` values are stored in SQLite behind persistent `image_<uuid>` IDs.
Photos and image documents received from Telegram are registered directly from
their existing `file_id` and use persistent `tg://photo` or `tg://document`
references in live context and newly indexed message-search results. Telegram
album membership is retained as `media_group_id` in prompt and search metadata.

Incoming rich messages also pass every photo and image document to the model,
including images nested in slideshows, collages, lists, quotations, and details.
Each photo uses its largest available size. Normal and guest requests include
these images from the current message and reply context, including quoted
replies and thread continuations, and register persistent references for reuse.

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
or JSON-mode fallback is used. Candidate text costs token credits even if the
validator rejects it; the hidden verdict has no separate request charge. The
shared model budget still limits generation and validation. This gate applies
to automatic trolling; explicit troll-agent conversations keep their existing flow.

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
