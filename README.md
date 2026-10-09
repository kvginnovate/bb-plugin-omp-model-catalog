# bb-plugin-omp-model-catalog

A BB plugin that shows the live `omp` model catalog grouped by provider, with
collapsible sections and dividers, in the composer and on the command line.

- `contract.ts` — the shared spine: the catalog schema, the `PROVIDER_META`
  registry, `groupModels`, `isModelFree`, and both RPC contracts. Every
  surface renders the same grouping because they all import this file.
- `host.ts` — the host daemon: shells `omp models --json`, `omp --version`,
  and `omp config path` on the machine that invoked the call, and returns the
  raw catalog. It never groups or filters.
- `server.ts` — the backend: the `catalog` / `collapsed_set` RPC, the
  `bb omp-model-catalog` CLI, and the `omp_model_catalog` agent tool. Groups
  the raw rows with `groupModels` and persists the collapse set in
  `bb.storage.kv`.
- `app.tsx` + `components/CollapsibleProviderList.tsx` — the frontend: an
  **OMP model catalog** composer popup (`Mod+Shift+G`) with a search box,
  collapsible provider sections, dividers, and per-model free badges.
- `skills/omp-model-catalog/SKILL.md` — the CLI grammar, the grouping
  semantics, and the `PROVIDER_META` extension hook. BB imports it into agent
  threads automatically.
- `PLUGIN_OVERVIEW.md` — the store listing text: a longer version of
  `bb.description` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

Try it: install the plugin, press `Mod+Shift+G` in a composer, or run
`bb omp-model-catalog list` in a terminal — both render the same provider
sections.

## Provider grouping

`groupModels(models)` buckets the raw catalog rows by lowercased `provider`,
resolves each bucket through `resolveProvider(key)`, and sorts sections by
priority. `PROVIDER_META` in `contract.ts` is the single registry: add one
entry to pin a display name, sort order, or collapsed-by-default state, and
every surface picks it up. An unregistered provider still renders — title-cased
name, sorted last, expanded.

The `free` badge is derived from catalog cost, not a hand-set flag: a section
is free only when every model in it costs zero, and each row badges its own
cost via `isModelFree`.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins declared packages alongside the SDK; unused packages may be removed. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.host` — the daemon entry that shells out to `omp` on the target
  machine. Required here: the plugin is useless without it, and a `run` on
  the server would otherwise read the wrong machine's catalog.
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots, declared here as `skills/omp-model-catalog`.
  Each directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.6.15`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json`, `app.js` / `app.css` /
`app.meta.json`, and `host.js` + `host.meta.json`. Each `*.meta.json` stamps
SDK major/version, `artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Keep the two in sync whenever `bb.description` changes.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload omp-model-catalog
```

Or let `bb plugin dev` rebuild and reload on every save.

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.6.15` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
