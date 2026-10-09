// bb-plugin-omp-model-catalog — provider grouping (pure).
//
// Deliberately free of any `@get-bb/plugin-sdk` or `zod` import: the frontend
// bundle imports this module at RUNTIME, and the browser build cannot resolve
// the backend SDK. Keeping the grouping helpers here (rather than in
// `contract.ts`, which defines the RPC contracts and therefore imports the
// SDK) is what lets `app.tsx` group rows without dragging the server SDK into
// `dist/app.js`.
//
// Grouping lives in the shared layer (not the host) so the CLI
// (`bb omp-model-catalog`) and the UI render the exact same structure, and so
// a new provider's display name / sort order / default-collapsed is registered
// once in `PROVIDER_META` and every surface picks it up.
import type { CatalogModel } from "./contract";

// ---------------------------------------------------------------------------
// Extensible provider metadata — the "extensible" hook.
//
// `PROVIDER_META` is the default registry. A provider key absent here still
// resolves: `resolveProvider` falls back to a title-cased display name, the
// default priority, and expanded-by-default. Anyone (this plugin's own code,
// or a future extension) can add a key to `PROVIDER_META` to pin a display
// name, sort order, brand, or a collapsed-by-default section, and BOTH the
// CLI and the UI reflect it without touching either surface.
// ---------------------------------------------------------------------------
export interface ProviderMeta {
  /** Registry key, matches `CatalogModel.provider`, lowercased. */
  key: string;
  /** Section header label. */
  displayName: string;
  /** Sort weight: lower renders first. Unknown providers use `UNKNOWN_PRIORITY`. */
  priority?: number;
  /** Section starts collapsed when there is no search. */
  defaultCollapsed?: boolean;
  /**
   * Force the section-wide `Free` badge. Leave undefined to derive it from
   * the catalog: a section is free only when EVERY model in it costs zero.
   * A hand-set flag went stale immediately (agnes was badged free while 3 of
   * its 8 models carried real pricing), so cost data is the source of truth.
   */
  free?: boolean;
}

/** Priority for providers we have not registered — they sort last. */
export const UNKNOWN_PRIORITY = 900;

/**
 * Default provider registry. Keys match the `provider` strings omp actually
 * emits today (`free_models`, `opencode-zen-free`, `agnes`, `devin`,
 * `workbuddy`, `typesafe`, ...). Extend this table — do not fork the render
 * paths — to add or re-order a provider.
 */
export const PROVIDER_META: readonly ProviderMeta[] = [
  { key: "agnes", displayName: "Agnes", priority: 10 },
  { key: "typesafe", displayName: "Typesafe", priority: 20 },
  { key: "devin", displayName: "Devin", priority: 30 },
  { key: "workbuddy", displayName: "WorkBuddy", priority: 40 },
  { key: "free_models", displayName: "Free Models", priority: 50 },
  { key: "opencode-zen-free", displayName: "OpenCode Zen (Free)", priority: 60 },
];

const META_BY_KEY = new Map<string, ProviderMeta>(
  PROVIDER_META.map((meta) => [meta.key, meta]),
);

/**
 * Resolve one provider key to its metadata. Registered keys return their
 * entry; unregistered keys get a sensible fallback (title-cased name, last
 * position, expanded) so a brand-new provider still renders cleanly.
 */
export function resolveProvider(provider: string): ProviderMeta {
  const key = provider.toLowerCase();
  const known = META_BY_KEY.get(key);
  if (known) return known;
  return {
    key,
    displayName: provider.charAt(0).toUpperCase() + provider.slice(1),
    priority: UNKNOWN_PRIORITY,
    defaultCollapsed: false,
  };
}

/** One provider section of the grouped catalog, already ordered + expanded. */
export interface ProviderGroup {
  key: string;
  displayName: string;
  priority: number;
  defaultCollapsed: boolean;
  free: boolean;
  /** Models for this provider, in catalog order. */
  models: CatalogModel[];
}

/** True when a model carries no cost at all in the catalog (free tier). */
export function isModelFree(model: CatalogModel): boolean {
  const cost = model.cost;
  if (cost === undefined) return true;
  return (
    (cost.input ?? 0) === 0 &&
    (cost.output ?? 0) === 0 &&
    (cost.cacheRead ?? 0) === 0 &&
    (cost.cacheWrite ?? 0) === 0
  );
}

/**
 * Group raw models into ordered provider sections. Exported so the CLI and
 * the app share one grouping implementation.
 */
export function groupModels(models: readonly CatalogModel[]): ProviderGroup[] {
  const byKey = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const key = model.provider.toLowerCase();
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
    }
    bucket.push(model);
  }
  return Array.from(byKey.entries())
    .map(([key, models]) => {
      const meta = resolveProvider(key);
      return {
        key,
        displayName: meta.displayName,
        priority: meta.priority ?? UNKNOWN_PRIORITY,
        defaultCollapsed: meta.defaultCollapsed ?? false,
        free: meta.free ?? models.every(isModelFree),
        models,
      };
    })
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}
