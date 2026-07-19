import {
  DASHBOARD_CONTEXT_HEADER,
  DASHBOARD_ORGANIZATION_COOKIE,
  DASHBOARD_PROJECT_COOKIE,
} from "./cloud-api";
import { isCloudMode, type RuntimeEnvironment } from "./runtime-config";

const CONTEXT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ONE_YEAR_SECONDS = 31_536_000;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function contextCookie(name: string, value: string, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    secure ? "Secure" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("; ");
}

function requestIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

export async function handleDashboardContextPost(
  request: Request,
  environment: RuntimeEnvironment = process.env,
): Promise<Response> {
  if (!isCloudMode(environment)) {
    return json({ error: "not_found" }, 404);
  }
  if (
    request.headers.get(DASHBOARD_CONTEXT_HEADER) !== "1" ||
    !requestIsSameOrigin(request)
  ) {
    return json({ error: "forbidden" }, 403);
  }
  if (
    !(request.headers.get("Content-Type") ?? "").includes("application/json")
  ) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  const body = (await request.json().catch(() => undefined)) as
    | { organizationId?: unknown; projectId?: unknown }
    | undefined;
  if (
    typeof body?.organizationId !== "string" ||
    !CONTEXT_ID.test(body.organizationId) ||
    (body.projectId !== undefined &&
      (typeof body.projectId !== "string" || !CONTEXT_ID.test(body.projectId)))
  ) {
    return json({ error: "invalid_context" }, 400);
  }

  const secure = new URL(request.url).protocol === "https:";
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    contextCookie(DASHBOARD_ORGANIZATION_COOKIE, body.organizationId, secure),
  );
  if (body.projectId !== undefined) {
    headers.append(
      "Set-Cookie",
      contextCookie(DASHBOARD_PROJECT_COOKIE, body.projectId, secure),
    );
  }
  return Response.json({ persisted: true }, { headers });
}
