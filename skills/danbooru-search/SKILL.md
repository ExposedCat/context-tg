---
name: danbooru-search
description: Search Danbooru posts with pybooru and Loylex's private API credentials; use for image lookup or constructing Danbooru tag queries.
---

# Danbooru search

## Setup

- Use `pybooru==4.2.2`: `from pybooru import Danbooru`.
- Credentials live only in `/memory/knowledge/danbooru.env` (`600`, outside Git). Load silently:

  ```bash
  set -a
  source /memory/knowledge/danbooru.env
  set +a
  ```

  Never print the file or put its values in a prompt, log, skill, bucket, command argument, or commit.
- Create the client from `DANBOORU_SITE`, `DANBOORU_USERNAME`, and `DANBOORU_API_KEY`; use `post_list(tags=..., limit=...)` for searches.

## Query rules

- For an ordinary tag search, append `order:score` when the user did not specify ordering. Preserve an explicit `order:*` or `random`.
- Tags are space-separated (`AND`); use `-tag` to exclude, `rating:*` for rating, and Danbooru metatags such as `score:`, `id:`, `width:`, or `height:` when useful.
- Use the exact Danbooru tag spelling (underscores). Do not use `raw=True` unless literal, unparsed tag text is explicitly needed.
- Keep `limit <= 100`; start with a small result set and paginate with `page` only when asked or needed.
- If there are no hits, relax the least certain tag one at a time and say what changed. Do not silently rewrite the request.

Return compact results: post URL (`https://danbooru.donmai.us/posts/{id}`), score, rating, and the best available file/preview URL. Do not dump whole JSON or download files unless requested.

## Smoke test

After loading the env file, verify without revealing credentials:

```python
import os
from pybooru import Danbooru

client = Danbooru(
    os.environ["DANBOORU_SITE"],
    username=os.environ["DANBOORU_USERNAME"],
    api_key=os.environ["DANBOORU_API_KEY"],
)
posts = client.post_list(tags="order:score", limit=1)
print({"ok": bool(posts), "id": posts[0].get("id") if posts else None})
```
