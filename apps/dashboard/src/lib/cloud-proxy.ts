import {
  CLOUD_CSRF_COOKIE,
  CLOUD_CSRF_HEADER,
  CLOUD_SESSION_COOKIE,
  cloudControlCookieHeader,
} from "./cloud-api";
import { isCloudMode, type RuntimeEnvironment } from "./runtime-config";

export interface CloudProxyRouteContext {
  params: Promise<{ path: string[] }>;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname === "[::1]"
  );
}

export function configuredCloudControlUrl(
  environment: RuntimeEnvironment = process.env,
): string | undefined {
  if (!isCloudMode(environment)) return undefined;
  const configured = environment.EYEBALL_CLOUD_URL?.trim();
  if (configured === undefined || configured.length === 0) return undefined;
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

function allowedCloudSetCookie(value: string): boolean {
  const names = [...value.matchAll(/(?:^|,\s*)([^=;,\s]+)=/gu)].map(
    (match) => match[1],
  );
  return (
    names.length === 1 &&
    (names[0] === CLOUD_SESSION_COOKIE || names[0] === CLOUD_CSRF_COOKIE)
  );
}

function appendSetCookies(source: Headers, destination: Headers): void {
  const headersWithCookies = source as Headers & {
    getSetCookie?: () => readonly string[];
  };
  const values = headersWithCookies.getSetCookie?.() ?? [];
  if (values.length > 0) {
    for (const value of values) {
      if (allowedCloudSetCookie(value)) {
        destination.append("Set-Cookie", value);
      }
    }
    return;
  }
  const fallback = source.get("Set-Cookie");
  if (fallback !== null && allowedCloudSetCookie(fallback)) {
    destination.append("Set-Cookie", fallback);
  }
}

function proxyError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function proxyCloudRequest(
  request: Request,
  context: CloudProxyRouteContext,
  environment: RuntimeEnvironment = process.env,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const baseUrl = configuredCloudControlUrl(environment);
  if (baseUrl === undefined) {
    return proxyError(
      503,
      "cloud_not_configured",
      "Cloud mode requires a valid server-only EYEBALL_CLOUD_URL.",
    );
  }

  const { path } = await context.params;
  if (
    path.length < 2 ||
    path[0] !== "v1" ||
    path.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return proxyError(
      400,
      "invalid_cloud_path",
      "The cloud proxy accepts only versioned public control-plane paths.",
    );
  }

  const incomingUrl = new URL(request.url);
  const encodedPath = path
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const cloudUrl = new URL(`${baseUrl}/${encodedPath}${incomingUrl.search}`);
  const headers = new Headers({ Accept: "application/json" });
  const contentType = request.headers.get("Content-Type");
  if (contentType !== null) headers.set("Content-Type", contentType);
  const csrfToken = request.headers.get(CLOUD_CSRF_HEADER);
  if (csrfToken !== null) headers.set(CLOUD_CSRF_HEADER, csrfToken);
  const cookie = cloudControlCookieHeader(request.headers.get("Cookie"));
  if (cookie !== undefined) headers.set("Cookie", cookie);

  try {
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const response = await fetchImpl(cloudUrl, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const responseContentType = response.headers.get("Content-Type");
    if (responseContentType !== null) {
      responseHeaders.set("Content-Type", responseContentType);
    }
    appendSetCookies(response.headers, responseHeaders);
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return proxyError(
      502,
      "cloud_unavailable",
      "The configured cloud control plane is unavailable.",
    );
  }
}
