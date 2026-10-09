---
name: omp-model-catalog
description: Use when the user asks which models omp can address on a machine, whether a provider or model is free, how the catalog is grouped, or how to register a new provider. Covers the `bb omp-model-catalog` CLI, the `omp_model_catalog` agent tool, and the `PROVIDER_META` extension hook in the shared contract.
---

# omp model catalog

The Omp Model Catalog plugin surfaces the live `omp models --json` catalog as
ordered provider sections. Every surface — the composer popup, the CLI, the
agent tool, and the RPC — renders the EXACT same grouping: the host entry
returns raw rows, the server groups them with `groupModels`, and
`PROVIDER_META` (in `contract.ts`) supplies each section's display name, sort
order, and default-collapsed state; the `free` badge is derived from catalog
cost by `isModelFree`.

## CLI grammar

```
bb omp-model-catalog list            # human listing
bb omp-model-catalog list --json     # machine output
```

`list` prints one section per provider:

- A header line: the provider's display name, a `(free)` badge when EVERY
  model in the section costs zero (derived from catalog cost via
  `isModelFree`, not a hand-maintained flag), a `(collapsed)` badge when the
  user has collapsed that section in the UI, and the model count.
- One row per model: the `provider/model` selector aligned in a column, then
  the display name with context window (`128k ctx`) and per-M-tok price.
- Sections are separated by a `─` divider; they appear in `PROVIDER_META`
  priority order.
- The footer reports the total model count, the omp version, and the config
  path the catalog was read from.

`--json` emits `{ ok, payload }` where payload is `{ version, configPath,
collapsed, groups }` — the full ordered groups array. Use it when the output
drives code; never parse the human listing.

Host resolution follows the plugin's standard order: explicit `--machine` →
the invoking thread's environment host → the system primary host. The agent
tool `omp_model_catalog` accepts the same `machine` parameter and returns the
grouped catalog as compact text (provider line + up to 40 model rows), so it
never floods a transcript.

## Provider-grouping semantics

`groupModels(models)` buckets the raw rows by lowercased `provider`, resolves
each bucket through `resolveProvider(key)`, and sorts sections by
`priority`, with the provider key as the tie-breaker. `resolveProvider` has
two outcomes:

- **Registered key** (present in `PROVIDER_META`): the section uses the
  entry's `displayName`, `priority`, and `defaultCollapsed`.
- **Unregistered key**: the section still renders — the display name is the
  key title-cased, `priority` is `UNKNOWN_PRIORITY` (900, so new providers
  sort last), and the section starts expanded.

Collapse state is user data, not grouping data: it lives in the server-side
`bb.storage.kv` store (shared by the UI and CLI), is returned with `catalog`,
and is written by the `collapsed_set` RPC, which publishes a
`catalog-changed` realtime signal so open popups refetch in place.

## Extending `PROVIDER_META`

`PROVIDER_META` in `contract.ts` is the single registry. To add or re-order a
provider, add one entry to the array:

```ts
{ key: "newprovider", displayName: "New Provider", priority: 15, defaultCollapsed: true }
```

and every surface picks it up without touching the host, CLI, tool, or UI:

- `displayName` — the section header on all surfaces.
- `priority` — sort weight; lower renders first, between two known entries.
- `defaultCollapsed` — the section starts collapsed in the UI (the user can
  still expand it; that choice is stored in the kv collapse set, which wins).
- `free` — optional override that FORCES the section-wide `Free` badge. Leave
  it unset so the badge is derived from cost (a section is free only when all
  of its models cost zero); row badges always use per-model cost.

Because the registry lives in the shared contract, the CLI and the UI can
never disagree about which providers exist or how they render. Extend the
table; do not fork the render paths, and do not hard-code provider names
elsewhere in the plugin.
