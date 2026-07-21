import { DEFAULT_EXECUTOR_BASE_URL } from "./api";
import { executorKeyFromCookieHeader } from "./executor-key";
import { EXECUTOR_PROJECT_HEADER } from "./executor-key-shared";
import { isCloudMode, type RuntimeEnvironment } from "./runtime-config";

export interface ExecutorProxyRouteContext {
  params: Promise<{ path: string[] }>;
}

export function isAllowedExecutorProxyRequest(
  method: string,
  path: readonly string[],
): boolean {
  const normalizedMethod =
    method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  if (
    normalizedMethod === "GET" ||
    normalizedMethod === "POST" ||
    normalizedMethod === "DELETE"
  ) {
    return path[0] === "v1" || path[0] === "health";
  }
  return (
    normalizedMethod === "PATCH" &&
    path.length === 3 &&
    path[0] === "v1" &&
    path[1] === "webhooks" &&
    path[2] !== undefined &&
    path[2].length > 0 &&
    path[2] !== "." &&
    path[2] !== ".."
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

export function configuredServerExecutorUrl(
  environment: RuntimeEnvironment,
): string | undefined {
  const configured = (
    environment.EYEBALL_EXECUTOR_URL ??
    environment.NEXT_PUBLIC_EYEBALL_EXECUTOR_URL ??
    DEFAULT_EXECUTOR_BASE_URL
  ).trim();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return undefined;
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export async function proxyExecutorRequest(
  request: Request,
  context: ExecutorProxyRouteContext,
  environment: RuntimeEnvironment = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const baseUrl = configuredServerExecutorUrl(environment);
  if (baseUrl === undefined) {
    return Response.json(
      {
        error: {
          code: "executor_not_configured",
          message:
            "The executor proxy requires an HTTPS or loopback HTTP server URL.",
          retryable: false,
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { path } = await context.params;
  if (
    path.length === 0 ||
    path.some((segment) => segment === "." || segment === "..") ||
    (path[0] !== "v1" && path[0] !== "health")
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
  if (!isAllowedExecutorProxyRequest(request.method, path)) {
    return Response.json(
      {
        error: {
          code: "executor_route_not_allowed",
          message: "The executor route is not available through this proxy.",
          retryable: false,
        },
      },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const incomingUrl = new URL(request.url);
  const encodedPath = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const executorUrl = new URL(`${baseUrl}/${encodedPath}${incomingUrl.search}`);
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
      redirect: "manual",
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
