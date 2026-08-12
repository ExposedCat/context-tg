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
