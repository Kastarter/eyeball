export function parseConnectionDrawerQuery(url: URL): {
  newConnectionOpen: boolean;
} {
  return {
    newConnectionOpen: url.searchParams.get("new") === "true",
  };
}

export function connectionDrawerUrl(url: URL, open: boolean): string {
  if (open) url.searchParams.set("new", "true");
  else url.searchParams.delete("new");
  return `${url.pathname}${url.search}${url.hash}`;
}
