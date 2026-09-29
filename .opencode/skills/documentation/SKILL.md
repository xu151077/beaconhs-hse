---
name: Documentation
description: Keep the in-app manual, walkthroughs, and docs/ truthful when user-facing behaviour changes. Use when adding, renaming, or removing any feature, route, button, or flow.
---

# Documentation

A stale manual article is not cosmetic: the AI assistant reads the same registry,
so a wrong article makes the assistant give wrong instructions to a worker on
site.

## When to use

- Any user-facing feature, route, button, or flow is added, changed, renamed, or
  removed.
- A permission changes what a user can see.
- A module gains a new capability or loses one.
- A `data-walkthrough` target or an `a[href="..."]` selector moves.

## The three surfaces

### 1. In-app manual — mandatory

- Articles: `apps/web/src/lib/manual/content/*`
- Types: `apps/web/src/lib/manual/types.ts`
- Assembly and visibility: `apps/web/src/lib/manual/registry.ts`
- Visibility gates mirror the nav registry's permissions.

**Every** user-facing change updates the matching article in the same commit.
A new module gets a new article. A removed or renamed feature has its article
updated or removed — never left describing something that no longer exists.

Manual style, because the audience is a construction worker, not an engineer:

- Short sentences. One idea per sentence.
- Numbered steps for procedures.
- **Bold the exact button label** the user will see, character for character.
- No jargon. If you must use a technical term, explain it in the same sentence.
- Write for someone standing on a site with gloves on.

### 2. Walkthroughs — when a tour points at the thing you moved

- Definitions: `apps/web/src/lib/walkthroughs/registry.ts`
- Per-tenant role and auto-start config lives in `walkthrough_settings`, edited
  at `/admin/walkthroughs`.
- Steps target `data-walkthrough="..."` attributes and stable `a[href="..."]`
  selectors.

If your change moves, renames, or removes anything a step targets, update the
step **in the same commit**. Otherwise the tour highlights nothing or points at
the wrong control.

### 3. `docs/` — analysis and engineering record

Reference-grade with `path:line` citations, and mark every claim:

- `RUNTIME VERIFIED` — proven against the running system
- `STATIC VERIFIED` — proven by reading code
- `UNVERIFIED` — could not be confirmed

Never write a `STATIC VERIFIED` claim as `RUNTIME VERIFIED`. If code and docs
disagree, fix the stale doc or call out the discrepancy — do not leave both.

## Also update

- `docs/project-development-state.md` after any sizeable task: current phase,
  what completed, what is blocked, what is next.
- `AGENTS.md` when a project-wide rule genuinely changes.

## Keeping docs honest

Documentation is part of the deliverable, not an afterthought. A finished change
with a stale manual is unfinished.

## Forbidden

- Never add a manual article for a feature that does not exist.
- Never leave an article describing a renamed or removed feature.
- Never change a `data-walkthrough` attribute or `a[href]` selector without
  updating the tour that targets it.
- Never cite `path:line` you have not read.
- Never claim runtime verification from a static read.
- Never duplicate an article's content across two articles.
- Never put a real secret, credential, or `.env` value in a doc.

## Completion criteria

For every user-facing change you can name:

- the manual article added or updated,
- the walkthrough step updated, or a statement that none targets the change,
- `docs/project-development-state.md` updated if the task was sizeable, and
- a manual article that, read alone, would let a worker complete the task.
