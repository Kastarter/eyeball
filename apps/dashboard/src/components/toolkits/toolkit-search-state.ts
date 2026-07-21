export type ToolkitSearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "ready"; matchedToolkitSlugs: ReadonlySet<string>; query: string }
  | { kind: "error"; message: string; query: string };

export type ToolkitSearchAction =
  | { type: "cleared" }
  | { query: string; type: "started" }
  | {
      matchedToolkitSlugs: ReadonlySet<string>;
      query: string;
      type: "succeeded";
    }
  | { message: string; query: string; type: "failed" };

export function normalizeToolkitSearchQuery(query: string): string {
  return query.trim();
}

export function toolkitSearchReducer(
  current: ToolkitSearchState,
  action: ToolkitSearchAction,
): ToolkitSearchState {
  switch (action.type) {
    case "cleared":
      return { kind: "idle" };
    case "started":
      return { kind: "loading", query: action.query };
    case "succeeded":
      return current.kind === "loading" && current.query === action.query
        ? {
            kind: "ready",
            matchedToolkitSlugs: action.matchedToolkitSlugs,
            query: action.query,
          }
        : current;
    case "failed":
      return current.kind === "loading" && current.query === action.query
        ? { kind: "error", message: action.message, query: action.query }
        : current;
  }
}
