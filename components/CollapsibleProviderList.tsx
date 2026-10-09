// bb-plugin-omp-model-catalog — the collapsible, provider-grouped catalog list.
//
// Presentational: it renders `groupModels` output as ordered sections with a
// divider between sections, a collapsible header per section (chevron +
// display name + model count + Free badge), and one row per model. Grouping
// and provider metadata come from the shared contract, so the list can never
// drift from the CLI or the agent tool.
//
// Collapse state is controlled by the parent: the app owns the set of
// collapsed provider keys (persisted through the `collapsed_set` RPC) and
// this component just reports toggles. A search query force-expands every
// matching section so results are always visible; while searching, the
// section headers are disabled because a toggle would have no visible effect.

import { useMemo, type ReactNode } from "react";
import type { CatalogModel, ProviderGroup } from "@/contract";
import { groupModels, isModelFree } from "@/contract";
import { cn } from "@/lib/utils";

/** Does one model row match the search query? */
export function matchesQuery(model: CatalogModel, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return true;
  return [model.name, model.selector, model.provider].some((field) =>
    field.toLowerCase().includes(trimmed),
  );
}

/**
 * Search-filtered provider sections: when the query is non-empty, each
 * section keeps only matching rows and empty sections are dropped. This is
 * the single code path shared by the rendered sections and the picker's
 * keyboard-nav flat list, so the two can never drift.
 */
export function filterGroups(
  groups: readonly ProviderGroup[],
  query: string,
): readonly ProviderGroup[] {
  if (query.trim() === "") return groups;
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => matchesQuery(model, query)),
    }))
    .filter((group) => group.models.length > 0);
}

/** A section renders open when searching (results must stay visible) or when
 * the user has not collapsed it. */
export function isSectionExpanded(
  groupKey: string,
  collapsed: ReadonlySet<string>,
  searching: boolean,
): boolean {
  return searching || !collapsed.has(groupKey);
}

/** Inline chevrons — lucide-react is not available in this plugin, so the two
 * states are hand-rolled from lucide's 24×24 chevron-down / chevron-right. */
function ChevronIcon({
  expanded,
  className,
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden
    >
      {expanded ? (
        <path d="m6 9 6 6 6-6" />
      ) : (
        <path d="m9 18 6-6-6-6" />
      )}
    </svg>
  );
}

export interface CollapsibleProviderListProps {
  /** Raw catalog rows; grouped + ordered by the shared contract. */
  models: readonly CatalogModel[];
  /** Provider keys the user has collapsed (stale keys are simply ignored). */
  collapsed: ReadonlySet<string>;
  /** Report a section toggle; the parent persists it. */
  onToggleCollapsed: (groupKey: string) => void;
  /** Model that is already selected (row gets a checkmark). Matched against
   * both `model.id` and `model.selector`, so a composer selection recorded
   * in either shape highlights the right row. */
  selectedModelId?: string;
  /** Called when the user picks a row. */
  onSelectModel: (model: CatalogModel) => void;
  /** Non-empty → filter rows and force every matching section open. */
  searchQuery?: string;
  /**
   * Parent-rendered full model row (a `<li>`), e.g. to attach refs and a
   * keyboard highlight. When omitted, the default row (one `<li>` with
   * name + `provider/id` subtitle + Free badge) is rendered.
   *
   * The owning group is passed so a custom row can render provider-level
   * metadata (the `free` flag drives the Free badge).
   */
  defaultRow?: (
    model: CatalogModel,
    active: boolean,
    group: ProviderGroup,
  ) => ReactNode;
  /**
   * Whether this component owns the listbox role. Set it when the list is
   * the only listbox on screen; leave it false when a parent already wraps
   * the sections, as the composer popup does — nested listboxes are invalid
   * ARIA and break screen-reader row counts.
   */
  listbox?: boolean;
}

export function CollapsibleProviderList({
  models,
  collapsed,
  onToggleCollapsed,
  selectedModelId,
  onSelectModel,
  searchQuery,
  defaultRow,
  listbox = false,
}: CollapsibleProviderListProps) {
  const groups = useMemo(() => groupModels(models), [models]);

  const searching = searchQuery !== undefined && searchQuery.trim() !== "";
  const visibleGroups = useMemo(
    () => filterGroups(groups, searchQuery ?? ""),
    [groups, searchQuery],
  );

  const isSelected = (model: CatalogModel): boolean =>
    selectedModelId !== undefined &&
    (model.id === selectedModelId || model.selector === selectedModelId);

  if (visibleGroups.length === 0) {
    return (
      <p className="px-2 py-4 text-sm text-muted-foreground">
        {searching
          ? `No models match “${searchQuery?.trim()}”.`
          : "No models in catalog."}
      </p>
    );
  }

  return (
    <div
      role={listbox ? "listbox" : undefined}
      aria-label={listbox ? "OMP model catalog" : undefined}
      className="overflow-y-auto"
    >
      {visibleGroups.map((group, index) => {
        const expanded = isSectionExpanded(group.key, collapsed, searching);
        // While searching, toggles have no visible effect (sections are
        // force-open), so disable the headers instead of letting them lie.
        const headerDisabled = searching;
        return (
          <div key={group.key}>
            {/* Divider between sections — the first section has nothing above it. */}
            {index > 0 && (
              <div className="my-1.5 border-t border-border" aria-hidden />
            )}
            <div
              role={headerDisabled ? undefined : "button"}
              aria-expanded={headerDisabled ? undefined : expanded}
              tabIndex={-1}
              aria-disabled={headerDisabled ? true : undefined}
              onClick={() => {
                if (!headerDisabled) onToggleCollapsed(group.key);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1.5 select-none",
                !headerDisabled &&
                  "cursor-pointer hover:bg-state-hover active:bg-state-active",
              )}
            >
              <ChevronIcon
                expanded={expanded}
                className="text-muted-foreground"
              />
              <span className="min-w-0 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {group.displayName}
              </span>
              <span className="text-xs text-muted-foreground">
                ({group.models.length})
              </span>
              {group.free && (
                <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  Free
                </span>
              )}
            </div>
            {expanded &&
              (group.models.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  No models available.
                </p>
              ) : (
                <ul>
                  {group.models.map((model) => {
                    const active = isSelected(model);
                    if (defaultRow !== undefined) {
                      return (
                        <li key={model.selector}>
                          {defaultRow(model, active, group)}
                        </li>
                      );
                    }
                    return (
                      <li key={model.selector}>
                        <div
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          onClick={() => onSelectModel(model)}
                          className={cn(
                            "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                            active
                              ? "bg-state-active text-foreground"
                              : "hover:bg-state-hover",
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
                      </li>
                    );
                  })}
                </ul>
              ))}
          </div>
        );
      })}
    </div>
  );
}
