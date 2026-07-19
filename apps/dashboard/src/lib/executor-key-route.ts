import {
  executorKeyClearCookie,
  executorKeyFromCookieHeader,
  executorKeySetCookie,
  validDashboardProjectId,
} from "./executor-key";
import { EXECUTOR_KEY_SETTINGS_HEADER } from "./executor-key-shared";
import { isCloudMode, type RuntimeEnvironment } from "./runtime-config";

interface ExecutorKeyBody {
  key?: unknown;
  projectId?: unknown;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function requestAllowed(
  request: Request,
  environment: RuntimeEnvironment,
): boolean {
  if (!isCloudMode(environment)) return false;
  if (request.headers.get(EXECUTOR_KEY_SETTINGS_HEADER) !== "1") return false;
  const origin = request.headers.get("Origin");
  return origin === null || origin === new URL(request.url).origin;
}

async function body(request: Request): Promise<ExecutorKeyBody | undefined> {
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    return undefined;
  }
  try {
    const value = (await request.json()) as ExecutorKeyBody;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function handleExecutorKeyGet(
  request: Request,
  environment: RuntimeEnvironment = process.env,
): Promise<Response> {
  if (!requestAllowed(request, environment)) {
    return errorResponse(
      403,
      "forbidden",
      "Executor key settings request denied.",
    );
  }
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (projectId === null || !validDashboardProjectId(projectId)) {
    return errorResponse(
      400,
      "invalid_input",
      "A valid project ID is required.",
    );
  }
  return Response.json(
    {
      configured:
        executorKeyFromCookieHeader(
          request.headers.get("Cookie"),
          projectId,
        ) !== undefined,
      projectId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleExecutorKeyPost(
  request: Request,
  environment: RuntimeEnvironment = process.env,
): Promise<Response> {
  if (!requestAllowed(request, environment)) {
    return errorResponse(
      403,
      "forbidden",
      "Executor key settings request denied.",
    );
  }
  const value = await body(request);
  if (
    typeof value?.projectId !== "string" ||
    !validDashboardProjectId(value.projectId) ||
    typeof value.key !== "string" ||
    value.key.trim().length < 8 ||
    value.key.length > 4_096
  ) {
    return errorResponse(
      400,
      "invalid_input",
      "A valid project ID and executor key are required.",
    );
  }
  const response = Response.json(
    { configured: true, projectId: value.projectId },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.headers.append(
    "Set-Cookie",
    executorKeySetCookie({
      key: value.key.trim(),
      projectId: value.projectId,
      secure: new URL(request.url).protocol === "https:",
    }),
  );
  return response;
}

export async function handleExecutorKeyDelete(
  request: Request,
  environment: RuntimeEnvironment = process.env,
): Promise<Response> {
  if (!requestAllowed(request, environment)) {
    return errorResponse(
      403,
      "forbidden",
      "Executor key settings request denied.",
    );
  }
  const value = await body(request);
  if (
    typeof value?.projectId !== "string" ||
    !validDashboardProjectId(value.projectId)
  ) {
    return errorResponse(
      400,
      "invalid_input",
      "A valid project ID is required.",
    );
  }
  const response = Response.json(
    { configured: false, projectId: value.projectId },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.headers.append(
    "Set-Cookie",
    executorKeyClearCookie({
      projectId: value.projectId,
      secure: new URL(request.url).protocol === "https:",
    }),
  );
  return response;
}
