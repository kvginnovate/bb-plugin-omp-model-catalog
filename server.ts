// bb-plugin-omp-model-catalog — headless server entry.
//
// Three surfaces share one host client:
//   - the `bb omp-model-catalog` CLI (`list` / `--json`),
//   - the `omp_model_catalog` native agent tool,
//   - the RPC the composer popup calls (catalog / collapsed_set).
//
// The server never touches the omp binary or its config: every catalog read
// is forwarded to the host entry, which shells out to `omp` on the target
// machine. Grouping happens here, not in the host, so the CLI, the tool,
// and the UI all render the exact same provider sections — and the user's
// collapse set is persisted server-side in bb.storage.kv, so it survives
// reloads and is shared by every surface.
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type ExperimentalHostClient,
  type PluginAgentToolContext,
  type PluginAgentToolResult,
  type PluginCliOption,
  type PluginCliResult,
  type StandardSchemaV1InferInput,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

import { hostContract, rpcContract, type CatalogModel } from "./contract.js";
import { groupModels, type ProviderGroup } from "./grouping.js";

// ---------------------------------------------------------------------------
// Formatting helpers — one per command, shared by the CLI and the tool.
// The tool path always renders compact text: no table, no JSON, hard cap.
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" && code !== err.name ? `${err.message} [${code}]` : err.message;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** The server-side store holds the user's collapsed provider keys; empty = all expanded. */
const COLLAPSED_KEY = "collapsed";

/** Realtime channel the composer popup listens on; the payload is the collapse set. */
const CATALOG_CHANGED = "catalog-changed";

type GroupedCatalog = {
  version: string;
  configPath: string;
  groups: ProviderGroup[];
  collapsed: string[];
};

function totalModels(groups: readonly ProviderGroup[]): number {
  return groups.reduce((sum, group) => sum + group.models.length, 0);
}

/** One model row as the human listing prints it. */
function modelLine(model: CatalogModel): string {
  const meta: string[] = [];
  if (model.contextWindow !== null && model.contextWindow !== undefined) {
    meta.push(`${(model.contextWindow / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}k ctx`);
  }
  if (model.cost !== undefined && (model.cost.input > 0 || model.cost.output > 0)) {
    const price =
      model.cost.input === 0 && model.cost.output === 0
        ? "free"
        : `$${model.cost.input}/${model.cost.output} per M tok`;
    meta.push(price);
  }
  return meta.length > 0 ? `${model.name}  (${meta.join(", ")})` : model.name;
}

/** CLI `list`: one provider section with a divider, header, aligned rows. */
function formatCatalogTable(catalog: GroupedCatalog, json: boolean): string {
  const { version, configPath, groups, collapsed } = catalog;
  if (json) {
    return JSON.stringify({
      ok: true,
      payload: {
        version,
        configPath,
        collapsed,
        groups,
      },
    });
  }
  if (groups.length === 0) return `No models found. omp ${version}. Config: ${configPath}`;
  const total = totalModels(groups);
  // Cap the VALUE width, not the padded width: a selector exactly as wide as
  // the column would butt up against the name with no separator otherwise.
  const selW = Math.min(
    44,
    Math.max(...groups.flatMap((group) => group.models.map((model) => model.selector.length))),
  );
  const out: string[] = [];
  groups.forEach((group, index) => {
    if (index > 0) out.push("─".repeat(64));
    const badges = [group.free ? "free" : undefined, collapsed.includes(group.key) ? "collapsed" : undefined]
      .filter((badge) => badge !== undefined)
      .map((badge) => ` (${badge})`);
    out.push(`${group.displayName}${badges.join("")} — ${group.models.length} model(s)`);
    for (const model of group.models) {
      out.push(`  ${truncate(model.selector, selW).padEnd(selW)}  ${truncate(modelLine(model), 60)}`);
    }
  });
  out.push(`\n${total} model(s) across ${groups.length} provider(s). omp ${version}. Config: ${configPath}`);
  return out.join("\n");
}

/** Tool: one line per provider with its models inlined, hard-capped. */
function formatCatalogCompact(catalog: GroupedCatalog, limit: number): string {
  const { version, groups } = catalog;
  const total = totalModels(groups);
  const out: string[] = [`${total} model(s) in ${groups.length} provider(s) — omp ${version}`];
  let shown = 0;
  for (const group of groups) {
    out.push(`${group.displayName}${group.free ? " (free)" : ""} — ${group.models.length} model(s)`);
    for (const model of group.models) {
      if (shown >= limit) break;
      shown += 1;
      out.push(`  ${truncate(`${model.selector}  ${modelLine(model)}`, 96)}`);
    }
    if (shown >= limit) break;
  }
  if (total > limit) {
    out.push(`… ${total - limit} more — run \`bb omp-model-catalog list\` for the full catalog.`);
  }
  return out.join("\n");
}

// Options shared by every subcommand. `as const` keeps the `type`
// discriminants literal so cliCommand's generics infer precise value
// types per option.
const hostOptions = {
  machine: {
    type: "string",
    description: "Target host id. Omit to resolve from the thread's environment, else the system primary host.",
  },
  json: {
    type: "boolean",
    description: "Emit a `{ ok, payload }` JSON envelope on stdout instead of the human output.",
  },
} as const satisfies Record<string, PluginCliOption>;

// ---------------------------------------------------------------------------
// Host-boundary actions. Input/output types are inferred per method from
// `hostContract` at each call site, so no per-method aliases exist here.
// ---------------------------------------------------------------------------
// The tool and the CLI both hand us a shape with an optional thread id and
// signal; the tool's context just has required fields, which is assignable.
type ResolvableCtx = { threadId?: string; signal?: AbortSignal };

type ToolArgs = { machine?: string };

class OmpCatalogActions {
  private constructor(
    private readonly sdk: BbPluginApi["sdk"],
    private readonly host: ExperimentalHostClient<typeof hostContract>,
    private readonly storage: BbPluginApi["storage"],
    private readonly realtime: BbPluginApi["realtime"],
  ) {}

  static create(bb: BbPluginApi): OmpCatalogActions {
    const host = bb.hosts.experimental_client({ contract: hostContract });
    return new OmpCatalogActions(bb.sdk, host, bb.storage, bb.realtime);
  }

  private throwHostError(method: string, hostId: string, err: unknown): never {
    const reason = describeError(err);
    throw new PluginCliError(`omp host call '${method}' failed on ${hostId}: ${reason}`, {
      code: "host_call_failed",
      hint:
        "Check that the host daemon is online and that the omp binary is on PATH on that host. " +
        "Pin the target with `--machine <hostId>`.",
    });
  }

  /**
   * Host resolution, in order:
   *   1. explicit machine flag,
   *   2. thread → environment → host,
   *   3. system primary host.
   * A thread whose environment vanished falls through to (3); if that is
   * also absent we fail with a hint naming `--machine`.
   */
  async resolveHost(opts: { hostId?: string; ctx: ResolvableCtx }): Promise<string> {
    if (opts.hostId) return opts.hostId;
    const { threadId, signal } = opts.ctx;
    if (threadId) {
      try {
        const thread = await this.sdk.threads.get({ threadId, signal });
        const environmentId = thread.environmentId;
        if (environmentId) {
          const env = await this.sdk.environments.get({ environmentId, signal });
          if (env.hostId) return env.hostId;
        }
      } catch (err) {
        // Aborted: stop immediately; anything else means the thread or its
        // environment is gone — fall back to the primary host.
        if (signal?.aborted) throw err;
      }
    }
    const cfg = await this.sdk.system.config({ signal });
    if (cfg.primaryHostId) return cfg.primaryHostId;
    throw new PluginCliError(
      "No target host: no --machine flag, no thread environment host, and no system primary host.",
      { code: "host_resolution_failed", hint: "Add `--machine <hostId>` to target a host explicitly." },
    );
  }

  /**
   * One thin host call. `host.call` resolves with the validated output and
   * rejects on transport or host-side failure; the catch converts that
   * rejection into a `PluginCliError` so both the CLI's `--json` envelope
   * and the tool's error string stay well formed. `M` keeps input/output
   * inference precise per method.
   */
  async callHost<M extends keyof typeof hostContract & string>(
    method: M,
    input: StandardSchemaV1InferInput<(typeof hostContract)[M]["input"]>,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<StandardSchemaV1InferOutput<(typeof hostContract)[M]["output"]>> {
    try {
      return await this.host.call(method, input, { hostId, signal });
    } catch (err) {
      this.throwHostError(method, hostId, err);
    }
  }

  /** The user's collapsed provider-key set, shared by every surface. */
  async readCollapsed(): Promise<string[]> {
    return (await this.storage.kv.get<string[]>(COLLAPSED_KEY)) ?? [];
  }

  async writeCollapsed(collapsed: string[]): Promise<void> {
    await this.storage.kv.set(COLLAPSED_KEY, collapsed);
    // Ephemeral broadcast to every connected client; nothing is persisted.
    // Open popups refetch and re-render their dividers in place.
    this.realtime.publish(CATALOG_CHANGED, { collapsed });
  }

  /** Live catalog, grouped, plus the stored collapse set — one host round trip. */
  async readCatalog(ctx: ResolvableCtx, hostId: string): Promise<GroupedCatalog> {
    const catalog = await this.callHost("catalog", null, hostId, ctx.signal);
    return {
      version: catalog.version,
      configPath: catalog.configPath,
      groups: groupModels(catalog.models),
      collapsed: await this.readCollapsed(),
    };
  }

  /** Agent tool path: one compact block, no table, hard-capped rows. */
  async run(args: ToolArgs, ctx: ResolvableCtx): Promise<string> {
    const hostId = await this.resolveHost({ hostId: args.machine, ctx });
    const catalog = await this.readCatalog(ctx, hostId);
    return formatCatalogCompact(catalog, 40);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function plugin(bb: BbPluginApi) {
  const actions = OmpCatalogActions.create(bb);

  // -- CLI -------------------------------------------------------------------
  bb.cli.register(
    defineCli({
      name: "omp-model-catalog",
      summary: "List the live omp model catalog, grouped by provider.",
      description:
        "Drives the local omp CLI on the target machine and renders the catalog as " +
        "ordered provider sections: each section's header carries the provider's " +
        "display name, a `(free)` badge when every model is free-tier, and a " +
        "`(collapsed)` badge when the user has collapsed that section in the UI; " +
        "sections are separated by dividers. Without --machine, the host is " +
        "resolved from the invoking thread's environment, falling back to the " +
        "system primary host. `list` shows every model row; with --json the " +
        "groups array is the machine output instead of the human sections.",
      commands: {
        list: cliCommand({
          summary: "List the live omp model catalog, grouped by provider.",
          description:
            "One section per provider with a header line and aligned model rows, " +
            "sections separated by dividers. The footer reports the omp version " +
            "and the config path the catalog was read from. Use --json for the " +
            "`{ ok, payload }` envelope: version, configPath, collapsed, and the " +
            "full ordered groups array.",
          options: hostOptions,
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const catalog = await actions.readCatalog(ctx, hostId);
            const text = formatCatalogTable(catalog, input.options.json);
            return { exitCode: 0, stdout: text };
          },
        }),
      },
    }),
  );

  // -- Agent tool ------------------------------------------------------------
  const toolSchema = z.object({
    machine: z
      .string()
      .optional()
      .describe("Target host id; when omitted the thread's environment host, else the system primary host, is used."),
  });

  bb.agents.registerTool({
    name: "omp_model_catalog",
    description:
      "List the live omp model catalog grouped by provider. Returns one compact " +
      "line per provider plus its models — at most 40 model rows — with context " +
      "window and per-token price per model, so the catalog never floods a " +
      "transcript. Use it to check what models are available on the target " +
      "machine before naming a model, and whether a provider is free-tier. " +
      "`machine` pins a target host; when omitted the thread's environment " +
      "host, else the system primary host, is used.",
    parameters: toolSchema,
    presentation: {
      label: {
        pending: "Listing the omp model catalog",
        completed: "omp model catalog call finished",
      },
    },
    instructions:
      "The output is provider sections in registry order (unknown providers sort last). " +
      "A model row shows `provider/model selector` plus context window and price; " +
      "`free` means zero cost. When the user asks whether a specific model " +
      "exists, confirm its selector against this tool's output before using it.",
    async execute(args: ToolArgs, ctx: PluginAgentToolContext): Promise<PluginAgentToolResult> {
      try {
        return { content: [{ type: "text", text: await actions.run(args, ctx) }] };
      } catch (err) {
        if (err instanceof PluginCliError) {
          const text = err.hint ? `${err.message} (${err.hint})` : err.message;
          return { content: [{ type: "text", text }], isError: true };
        }
        return { content: [{ type: "text", text: `Unexpected error: ${describeError(err)}` }], isError: true };
      }
    },
  });

  // -- Frontend bridge --------------------------------------------------------
  // `useRpc` in app.tsx can only call methods registered here; it cannot reach
  // hostContract. `catalog` is the one round trip the popup renders: the live
  // catalog, grouped server-side, plus the stored collapse set. `collapsed_set`
  // persists the user's choice and publishes `catalog-changed` so every open
  // popup refetches without a second host call.
  //
  // The UI has no thread to resolve from, so this lands on the system primary
  // host — the machine running the omp install the user is configuring.
  bb.rpc.register(
    rpcContract,
    {
      async catalog() {
        const hostId = await actions.resolveHost({ ctx: {} });
        return actions.readCatalog({}, hostId);
      },
      async collapsed_set(input) {
        await actions.writeCollapsed(input.collapsed);
        return { collapsed: input.collapsed };
      },
    },
    {
      // Discoverable so `bb plugin rpc list`/`call` can exercise the same
      // bridge the popup uses, instead of leaving it testable only through a
      // browser.
      experimental_discoverable: true,
      experimental_description: "Read the grouped omp model catalog and persist the provider collapse set.",
    },
  );

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
