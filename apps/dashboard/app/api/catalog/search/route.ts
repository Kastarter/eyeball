import { defaultCatalog } from "@eyeball/catalog";

const MAX_QUERY_LENGTH = 160;

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length === 0) return Response.json({ tools: [] });
  if (query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: `Catalog search is limited to ${MAX_QUERY_LENGTH} characters.`,
          retryable: false,
        },
      },
      { status: 422 },
    );
  }

  const tools = await defaultCatalog.searchTools({ limit: 20, query });
  return Response.json(
    {
      tools: tools.map((tool) => ({
        capability: tool.capability,
        name: tool.name,
        toolkit: tool.toolkit,
      })),
    },
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
}
