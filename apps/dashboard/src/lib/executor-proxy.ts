import { DEFAULT_EXECUTOR_BASE_URL } from "./api";
import { executorKeyFromCookieHeader } from "./executor-key";
import { EXECUTOR_PROJECT_HEADER } from "./executor-key-shared";
import { isCloudMode, type RuntimeEnvironment } from "./runtime-config";

export interface ExecutorProxyRouteContext {
  params: Promise<{ path: string[] }>;
}

function configuredServerExecutorUrl(environment: RuntimeEnvironment): string {
  return (
    environment.EYEBALL_EXECUTOR_URL ??
    environment.NEXT_PUBLIC_EYEBALL_EXECUTOR_URL ??
    DEFAULT_EXECUTOR_BASE_URL
  ).replace(/\/$/u, "");
}

export async function proxyExecutorRequest(
  request: Request,
  context: ExecutorProxyRouteContext,
  environment: RuntimeEnvironment = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
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
    `${configuredServerExecutorUrl(environment)}/${encodedPath}${incomingUrl.search}`,
  );
  const headers = new Headers({ Accept: "application/json" });
  const contentType = request.headers.get("Content-Type");
  if (contentType !== null) headers.set("Content-Type", contentType);
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey !== null) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  const apiKey = isCloudMode(environment)
    ? executorKeyFromCookieHeader(
        request.headers.get("Cookie"),
        request.headers.get(EXECUTOR_PROJECT_HEADER),
      )
    : environment.EYEBALL_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  try {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await fetchImpl(executorUrl, {
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
