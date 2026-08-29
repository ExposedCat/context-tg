---
name: telegram
description: Search Loylex's Telegram archive and send, download, or upload Telegram content through the secret-isolating gateway.
---

# Telegram gateway

Use the `loylex` command. The gateway owns the bot token; never seek or recreate it.

- `loylex status` reports archive and queue counts.
- `loylex search 'FTS QUERY' [CHAT_ID]` searches archived message text with SQLite
  FTS5 syntax.
- `loylex media FILE_ID OUTPUT_PATH` downloads Telegram media without exposing the
  bot token.
- `loylex send CHAT_ID 'RICH MARKDOWN'` sends to a chat already present in the
  archive.
- `loylex upload CHAT_ID FILE [CAPTION]` uploads a local file as a document.

The runtime automatically delivers the final Codex response to the current request. Do not
call `loylex send` for that ordinary response. Use it only when the task explicitly requires
a separate proactive message or another destination.

Rich Markdown supports GitHub-flavored Markdown, tables, `$$LaTeX$$`, arbitrary
supported Rich HTML, `<details>`, `<tg-collage>`,
`<tg-slideshow>`, and media URLs. Keep a rich message within 32,768 UTF-8
characters and 500 blocks.

Use current-request metadata for chat and message IDs. Do not guess a destination chat. Search
results are private chat data: quote or forward only when the user's request authorizes it.
