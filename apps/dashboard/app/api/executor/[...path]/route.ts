import { DEFAULT_EXECUTOR_BASE_URL } from "@/src/lib/api";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function configuredServerExecutorUrl(): string {
  return (
    process.env.EYEBALL_EXECUTOR_URL ??
    process.env.NEXT_PUBLIC_EYEBALL_EXECUTOR_URL ??
    DEFAULT_EXECUTOR_BASE_URL
  ).replace(/\/$/u, "");
}

async function proxyExecutorRequest(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  if (
    path.length === 0 ||
    path.some((segment) => segment === "." || segment === "..")
  ) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: "The executor proxy path is invalid.",
          retryable: false,
        },
      },
      { status: 400 },
    );
  }

  const incomingUrl = new URL(request.url);
  const encodedPath = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const executorUrl = new URL(
    `${configuredServerExecutorUrl()}/${encodedPath}${incomingUrl.search}`,
  );
  const headers = new Headers({ Accept: "application/json" });
  const contentType = request.headers.get("Content-Type");
  if (contentType !== null) headers.set("Content-Type", contentType);
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey !== null) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  const apiKey = process.env.EYEBALL_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  try {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await fetch(executorUrl, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
    });
    const responseHeaders = new Headers();
    const responseContentType = response.headers.get("Content-Type");
    if (responseContentType !== null) {
      responseHeaders.set("Content-Type", responseContentType);
    }
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "provider_unavailable",
          message: "The configured executor is offline.",
          retryable: true,
        },
      },
      { status: 502 },
    );
  }
}

export function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}

export function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}

export function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}
