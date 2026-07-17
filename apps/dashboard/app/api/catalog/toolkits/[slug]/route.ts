import { getCatalogToolkit } from "@/src/lib/catalog";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  const { slug } = await context.params;
  const toolkit = getCatalogToolkit(slug);
  if (toolkit === undefined) {
    return Response.json(
      {
        error: {
          code: "not_found",
          message: `Toolkit ${slug} was not found.`,
          retryable: false,
        },
      },
      { status: 404 },
    );
  }
  return Response.json(toolkit, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
