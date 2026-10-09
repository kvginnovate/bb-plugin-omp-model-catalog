// bb-plugin-omp-model-catalog — a BB plugin frontend entry.
//
// Registers one composer popup: a collapsible, provider-grouped view of the
// live omp model catalog. Sections are ordered by the shared contract
// (`groupModels` + `PROVIDER_META`), separated by dividers, and individually
// collapsible; the user's collapse choices persist through the server's
// `collapsed_set` RPC, so they survive reloads and are shared by every
// surface. Picking a model inserts its `provider/id` selector into the
// composer draft — the omp catalog addresses models, and composer pickers
// address BB agent providers, so there is no setSelection path here.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRpc,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { CatalogModel, rpcContract } from "@/contract";
import type { ProviderGroup } from "@/grouping";
import { isModelFree } from "@/grouping";
import {
  CollapsibleProviderList,
  filterGroups,
  isSectionExpanded,
} from "@/components/CollapsibleProviderList";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The server's `catalog` output: grouped rows plus the stored collapse set. */
type CatalogResult = PluginRpcResult<typeof rpcContract["catalog"]>;

/** One keyboard-reachable model row of the visible catalog. */
interface PickerRow {
  model: CatalogModel;
  groupKey: string;
}

function totalRows(groups: readonly ProviderGroup[]): number {
  return groups.reduce((sum, group) => sum + group.models.length, 0);
}

/** OmpCatalogPicker — the grouped, collapsible catalog popup.
 *
 * The host owns placement, dismissal, and focus restore; this component owns
 * its content and keyboard navigation (ArrowUp/Down/Enter/Escape).
 */
function OmpCatalogPicker() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchCatalog = useCallback(() => {
    rpc
      .call("catalog")
      .then((result) => {
        setCatalog(result);
        setLoadError(null);
        // Persisted collapses win; registry defaults apply to every
        // default-collapsed key, so free-tier sections stay tucked away
        // until the user opens them.
        const next = new Set(result.collapsed);
        for (const group of result.groups) {
          if (group.defaultCollapsed) next.add(group.key);
        }
        setCollapsed(next);
      })
      .catch((error: unknown) => {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load the model catalog.",
        );
      });
  }, [rpc]);

  // One fetch on open; the server publishes "catalog-changed" after every
  // collapse write, so refetch to stay in sync across surfaces.
  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  useRealtime("catalog-changed", () => {
    fetchCatalog();
  });

  // Toggle a section and persist the working set; a write failure just means
  // the choice does not survive a reload.
  const toggleCollapsed = useCallback(
    (groupKey: string) => {
      const next = new Set(collapsed);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      setCollapsed(next);
      rpc.call("collapsed_set", { collapsed: [...next] }).catch(() => {});
    },
    [collapsed, rpc],
  );

  const groups: ProviderGroup[] = catalog?.groups ?? [];
  const query = search.trim();
  const searching = query !== "";

  // One flat row list shared with the rendered sections: filterGroups and
  // isSectionExpanded are the list component's own code paths, so keyboard
  // navigation can never target a row that is not visible.
  const rows = useMemo<PickerRow[]>(() => {
    const out: PickerRow[] = [];
    for (const group of filterGroups(groups, searching ? query : "")) {
      if (!isSectionExpanded(group.key, collapsed, searching)) continue;
      for (const model of group.models) {
        out.push({ model, groupKey: group.key });
      }
    }
    return out;
  }, [groups, searching, query, collapsed]);

  // Keep the highlight in range and scroll it into view.
  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows]);

  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  useEffect(() => {
    const active = rows[highlight];
    if (active === undefined) return;
    rowRefs.current
      .get(active.model.selector)
      ?.scrollIntoView({ block: "nearest" });
  }, [rows, highlight]);

  // Reset navigation when the query changes.
  useEffect(() => {
    setHighlight(0);
  }, [search]);

  const commit = useCallback(
    (model: CatalogModel) => {
      composer.insert(model.selector, { at: "cursor" });
      composer.experimental_closePopup();
    },
    [composer],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0 && event.key !== "Escape") return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlight((current) => Math.min(current + 1, rows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => Math.max(current - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const active = rows[highlight];
        if (active !== undefined) commit(active.model);
        break;
      }
      case "Escape":
        event.preventDefault();
        composer.experimental_closePopup();
        break;
    }
  };

  const activeKey = highlight >= 0 ? rows[highlight]?.model.selector : undefined;

  const renderRow = (model: CatalogModel, _active: boolean, group: ProviderGroup) => {
    const highlighted = model.selector === activeKey;
    return (
      <div
        role="option"
        aria-selected={highlighted}
        tabIndex={-1}
        ref={(element) => {
          if (element !== null) rowRefs.current.set(model.selector, element);
        }}
        onClick={() => {
          const index = rows.findIndex(
            (row) => row.model.selector === model.selector,
          );
          if (index !== -1) setHighlight(index);
          commit(model);
        }}
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm",
          highlighted ? "bg-state-active text-foreground" : "hover:bg-state-hover",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{model.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {model.selector}
          </span>
        </span>
        {isModelFree(model) && (
          <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            Free
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      role="listbox"
      aria-label="OMP model catalog"
      className="flex h-full max-h-[420px] w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-lg"
      onKeyDown={handleKeyDown}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2">
        <Input
          autoFocus
          value={search}
          placeholder="Search models"
          aria-label="Search models"
          onChange={(event) => setSearch(event.target.value)}
        />
        {catalog !== null && (
          <p className="px-1 text-xs text-muted-foreground">
            {totalRows(groups)} model(s) · omp {catalog.version}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loadError !== null ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">{loadError}</p>
        ) : catalog === null ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            Loading model catalog…
          </p>
        ) : (
          <CollapsibleProviderList
            models={groups.flatMap((group) => group.models)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onSelectModel={commit}
            searchQuery={search}
            defaultRow={renderRow}
            listbox={false}
          />
        )}
      </div>
    </div>
  );
}

/** CatalogSettingsSection — the same grouped catalog, browsable from
 * Settings → Plugins.
 *
 * This registration is also what makes the plugin appear in that list at all:
 * BB lists a plugin there only when it declares a settings section, so a
 * plugin whose only surface is a composer popup is otherwise invisible. A
 * settings page has no composer to insert into, so picking a row copies the
 * `provider/id` selector instead.
 */
function CatalogSettingsSection() {
  const rpc = useRpc<typeof rpcContract>();

  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchCatalog = useCallback(() => {
    rpc
      .call("catalog")
      .then((result) => {
        setCatalog(result);
        setLoadError(null);
        const next = new Set(result.collapsed);
        for (const group of result.groups) {
          if (group.defaultCollapsed) next.add(group.key);
        }
        setCollapsed(next);
      })
      .catch((error: unknown) => {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load the model catalog.",
        );
      });
  }, [rpc]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  useRealtime("catalog-changed", () => {
    fetchCatalog();
  });

  const toggleCollapsed = useCallback(
    (groupKey: string) => {
      const next = new Set(collapsed);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      setCollapsed(next);
      rpc.call("collapsed_set", { collapsed: [...next] }).catch(() => {});
    },
    [collapsed, rpc],
  );

  const copySelector = useCallback((model: CatalogModel) => {
    navigator.clipboard
      .writeText(model.selector)
      .then(() => toast.success(`Copied ${model.selector}`))
      .catch(() => toast.error("Could not copy the selector."));
  }, []);

  const groups: ProviderGroup[] = catalog?.groups ?? [];

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={search}
        placeholder="Search models"
        aria-label="Search models"
        onChange={(event) => setSearch(event.target.value)}
      />
      {catalog !== null && (
        <p className="text-xs text-muted-foreground">
          {totalRows(groups)} model(s) · omp {catalog.version} · select a row to
          copy its selector
        </p>
      )}
      {loadError !== null ? (
        <p className="text-sm text-muted-foreground">{loadError}</p>
      ) : catalog === null ? (
        <p className="text-sm text-muted-foreground">Loading model catalog…</p>
      ) : (
        <CollapsibleProviderList
          models={groups.flatMap((group) => group.models)}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onSelectModel={copySelector}
          searchQuery={search}
        />
      )}
    </div>
  );
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. The popup and command are registered here; the host
// owns popup placement, dismissal, and focus restore — OmpCatalogPicker
// owns its own content and keyboard navigation.
export default definePluginApp((app) => {
  // Declaring a settings section is what lists the plugin under
  // Settings → Plugins; without it the plugin has no entry there.
  app.slots.settingsSection({
    id: "omp-model-catalog",
    title: "Model catalog",
    description:
      "Collapsible, provider-grouped view of the live omp model catalog.",
    component: CatalogSettingsSection,
  });

  app.composer.customize({
    id: "omp-model-catalog",
    experimental_popups: [
      {
        id: "omp-model-catalog",
        label: "OMP model catalog",
        component: OmpCatalogPicker,
      },
    ],
  });

  app.composer.experimental_registerCommand({
    id: "open-omp-model-catalog",
    title: "Model catalog: omp grouped",
    defaultShortcut: { key: "g", mod: true, shift: true },
    run: ({ composer }) => {
      composer.experimental_openPopup("omp-model-catalog");
    },
  });
});
