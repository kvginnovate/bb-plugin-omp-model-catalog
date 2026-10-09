// bb-plugin-omp-model-catalog — shared contract.
//
// ONE file both the host daemon (host.ts) and the server/app (server.ts,
// app.tsx) import. The host owns the real `omp` binary and returns the raw
// catalog; the server groups it into provider sections; the app renders the
// groups as collapsible, divided, extensible provider sections.
//
// Grouping lives here (not in the host) so the CLI (`bb omp-model-catalog`)
// and the UI render the exact same structure, and so a new provider's display
// name / sort order / default-collapsed is registered once in `PROVIDER_META`
// and every surface picks it up.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Model catalog row — one `omp models --json` entry.
//
// Every field is optional except the identity trio because the catalog is
// provider-authored: a future omp release may add keys, and a provider that
// omits metadata must not fail the whole listing.
// ---------------------------------------------------------------------------
export const catalogModelSchema = z.object({
  /** Provider key, e.g. "agnes", "free_models", "opencode-zen-free". */
  provider: z.string(),
  /** Catalog kind: "chat" | "embed" | ... (whatever omp reports). */
  kind: z.string().optional(),
  /** Model id within the provider, e.g. "agnes-2.5-flash". */
  id: z.string(),
  /** `provider/id` — the value omp addresses the model by. */
  selector: z.string(),
  /** Human display name, e.g. "Agnes 2.5 Flash". */
  name: z.string(),
  contextWindow: z.number().nullable().optional(),
  maxTokens: z.number().nullable().optional(),
  reasoning: z.boolean().optional(),
  /**
   * Thinking support, or null when the model has none. omp emits an ARRAY of
   * level names for models that accept a thinking suffix (e.g.
   * `["off","low","high"]`) and null otherwise — a plain string here silently
   * dropped 33 of 41 catalog rows, so accept both shapes.
   */
  thinking: z.union([z.array(z.string()), z.string()]).nullish(),
  /** Modalities the model accepts, e.g. ["text","image"]. */
  input: z.array(z.string()).optional(),
  /** Per-token pricing; 0 means free/unpriced. */
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
  /** How omp sourced the pricing, e.g. "unknown", "catalog". */
  pricingStatus: z.string().optional(),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

// ---------------------------------------------------------------------------
// Extensible provider metadata — the "extensable" hook.
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

// ---------------------------------------------------------------------------
// Host RPC — the real `omp` binary runs on the invoking machine.
// The host stays a thin wrapper: it returns the RAW catalog; the server does
// the grouping, so the host has zero knowledge of provider display rules.
// ---------------------------------------------------------------------------
export const hostCatalogSchema = z.object({
  /** `omp --version` (bare semver). */
  version: z.string(),
  /** The omp config path the catalog was read from. */
  configPath: z.string(),
  /** Raw catalog rows, ungrouped. */
  models: z.array(catalogModelSchema),
});
export type HostCatalog = z.infer<typeof hostCatalogSchema>;

export const hostContract = defineRpcContract({
  /** Read the live omp model catalog. */
  catalog: { input: z.null(), output: hostCatalogSchema },
});
export type OmpCatalogHostContract = typeof hostContract;

// ---------------------------------------------------------------------------
// Server RPC — what the BB frontend / CLI call.
//
// `catalog` returns the groups the UI renders; `collapsed_get` /
// `collapsed_set` persist the user's collapse/expand choices server-side so
// they survive reloads and shared the CLI + UI (collapsed wins the
// server store; an empty list means "all expanded").
// ---------------------------------------------------------------------------
export const serverCatalogSchema = z.object({
  version: z.string(),
  configPath: z.string(),
  /** Ordered, expanded provider sections. */
  groups: z.array(
    z.object({
      key: z.string(),
      displayName: z.string(),
      priority: z.number(),
      defaultCollapsed: z.boolean(),
      free: z.boolean(),
      models: z.array(catalogModelSchema),
    }),
  ),
  /** Provider keys the user has collapsed. */
  collapsed: z.array(z.string()),
});

export const rpcContract = defineRpcContract({
  /** One round trip: the live catalog, grouped, plus the stored collapse set. */
  catalog: { input: z.null(), output: serverCatalogSchema },
  /** Persist the current collapsed provider-key set (empty = all expanded). */
  collapsed_set: {
    input: z.object({ collapsed: z.array(z.string()) }),
    output: z.object({ collapsed: z.array(z.string()) }),
  },
});
