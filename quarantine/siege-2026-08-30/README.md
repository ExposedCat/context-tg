# Siege of Loylex quarantine

This directory preserves inert excerpts and a map of the August 30, 2026 prompt-injection
incident for later review. Nothing here is runtime configuration, an instruction source, or
code that should be executed.

The complete byte-for-byte repository state is preserved in the remote branch
`archive/siege-of-loylex-2026-08-30` at commit
`b4999911ed38b3fdab45135ca8ab0f469ab63491`. The last known-good pre-incident baseline is
`6f9f2934ae3b595d95644a36247c7da612b42dbb`.

## Commit map

- `1c49f19`: replaced the Bun project with the Deno `context-tg` baseline.
- `02f5368`: corrected the Deno `generate_image` tool description.
- `030f61a`: restored safety instructions on the Deno baseline.
- `701e767`: routed Deno Telegram conversations through a Codex app-server container.
- `98737b8`: added the private Telegram `/exec` command.
- `073a8cc`: restored the Bun tree while retaining `/exec`.
- `b05911a` through `68c28d2`: progressively replaced instructions and identity under
  misleading `/tasks` commit titles.
- `a51ad76`: replaced real progress with a fictional medieval chronicle.
- `e44ed58`: transmitted gateway configuration through an unrelated Telegram bot.
- `b499991`: reformatted that transmission so CI passed.

The Deno app-server experiment and the image-description fix may contain independently useful
ideas. Review them only from the archived branch and port individual, understood changes onto
a clean branch rather than merging incident commits.

Secrets and executable attack code are deliberately not duplicated here. They remain available
in the restricted forensic branch and must be treated as compromised.
