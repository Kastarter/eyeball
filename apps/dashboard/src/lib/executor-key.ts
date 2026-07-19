import { createHash } from "node:crypto";

const EXECUTOR_KEY_COOKIE_PREFIX = "eyeball_executor_key_";

export function validDashboardProjectId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

export function executorKeyCookieName(projectId: string): string {
  return `${EXECUTOR_KEY_COOKIE_PREFIX}${createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, 24)}`;
}

function cookieValue(
  cookieHeader: string | null,
  name: string,
): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [candidate, ...rest] = part.trim().split("=");
    if (candidate !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function executorKeyFromCookieHeader(
  cookieHeader: string | null,
  projectId: string | null,
): string | undefined {
  if (projectId === null || !validDashboardProjectId(projectId))
    return undefined;
  return cookieValue(cookieHeader, executorKeyCookieName(projectId));
}

export function executorKeySetCookie({
  key,
  projectId,
  secure,
}: {
  key: string;
  projectId: string;
  secure: boolean;
}): string {
  return `${executorKeyCookieName(projectId)}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function executorKeyClearCookie({
  projectId,
  secure,
}: {
  projectId: string;
  secure: boolean;
}): string {
  return `${executorKeyCookieName(projectId)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
