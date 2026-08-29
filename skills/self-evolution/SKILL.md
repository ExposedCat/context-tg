---
name: self-evolution
description: Create, refine, or remove Loylex skills after a reusable procedure or failure boundary has been proven.
---

# Evolve skills

Before editing, inspect existing skill names and read any overlapping skill completely.

Create a skill only when the guidance is reusable and non-obvious. Use a lowercase
hyphen-separated directory under `skills` with a required `SKILL.md`. Its YAML
frontmatter needs a short `name` and a discriminating `description` that says when it
applies. Keep the body limited to decisions, proven contracts, constraints, and verification
that materially improve future work.

Put conditional detail in `references` and deterministic repeated mechanics in
`scripts`. Do not add empty scaffolding. Test scripts and the real workflow. Remove stale
or contradictory guidance rather than accumulating exceptions.

Review the diff for private memory, credentials, chat content, and host-specific secrets before
committing. Run the repository checks, make a clear commit, pull with rebase, and push only to
Loylex's own repository.
