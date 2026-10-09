// bb-plugin-omp-model-catalog — RPC contract.
//
// This module defines the zod schemas and the two `defineRpcContract` values,
// so it imports `@get-bb/plugin-sdk` at RUNTIME. Only the Node-side entries
// (`host.ts`, `server.ts`) may import it as a value. The frontend imports it
// with `import type` only — a value import here would drag the backend SDK
// into `dist/app.js`, where the browser build cannot resolve it.
//
// The pure grouping helpers (`PROVIDER_META`, `groupModels`, `isModelFree`)
// live in `grouping.ts`, which the frontend imports at runtime instead.
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
// `catalog` returns the groups the UI renders; `collapsed_set` persists the
// user's collapse/expand choices server-side so they survive reloads and are
// shared by the CLI and the UI (an empty list means "all expanded").
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
