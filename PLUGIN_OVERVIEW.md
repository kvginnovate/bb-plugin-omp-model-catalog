See which provider every omp model belongs to, grouped into collapsible
sections instead of one flat list.

## What you get

- An **OMP model catalog** popup in the composer (`Mod+Shift+G`) that lists
  the live `omp` catalog grouped by provider, with a divider between sections,
  a model count per section, and a `Free` badge on zero-cost models.
- Collapsible provider sections: click a header to fold it away, and the
  choice is remembered across reloads. Typing in the search box force-expands
  every matching section so results stay visible.
- A `bb omp-model-catalog list` command that renders the same grouping in a
  terminal, plus an `omp_model_catalog` tool agents can call.

## How it works

The plugin reads the catalog with `omp models --json` on the machine that
invoked it — the same catalog `omp` itself uses, so it never drifts from what
your sessions can actually address. Grouping, ordering, and the free badge are
computed from the catalog data, not a hardcoded provider list: a provider that
mixes free and paid models is never mislabeled.

## Extending it

Providers are registered in one table (`PROVIDER_META` in `contract.ts`). Add
an entry to pin a display name, sort order, or collapsed-by-default state, and
every surface — popup, CLI, and agent tool — picks it up. A provider that is
not registered still renders, sorted last, so a new provider never disappears.
