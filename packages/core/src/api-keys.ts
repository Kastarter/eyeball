export interface ApiKeyPrincipal {
  projectId: string;
  /** When present, every user-scoped request must use exactly this end-user ID. */
  userId?: string;
}

export type ApiKeyringValue = string | ApiKeyPrincipal;

export type ApiKeyringInput =
  | Readonly<Record<string, ApiKeyringValue>>
  | ReadonlyMap<string, ApiKeyringValue>;

function principal(value: ApiKeyringValue): ApiKeyPrincipal {
  const candidate =
    typeof value === "string" ? { projectId: value } : { ...value };
  if (candidate.projectId.trim().length === 0) {
    throw new Error("API key principals must include a project ID.");
  }
  if (candidate.userId !== undefined && candidate.userId.trim().length === 0) {
    throw new Error(
      "Pinned API key principals must include a non-empty user ID.",
    );
  }
  return Object.freeze(candidate);
}

/** Parses comma-separated `key:projectId` and `key:projectId:userId` entries. */
export function parseApiKeyring(
  value: string | undefined,
): Map<string, ApiKeyPrincipal> {
  const keyring = new Map<string, ApiKeyPrincipal>();
  if (value === undefined || value.trim().length === 0) return keyring;

  for (const rawEntry of value.split(",")) {
    const parts = rawEntry.split(":").map((part) => part.trim());
    if (
      (parts.length !== 2 && parts.length !== 3) ||
      parts.some((part) => part.length === 0)
    ) {
      throw new Error(
        "EYEBALL_API_KEYS entries must use key:projectId or key:projectId:userId.",
      );
    }
    const [key, projectId, userId] = parts as [string, string, string?];
    if (keyring.has(key)) {
      throw new Error("EYEBALL_API_KEYS must not contain duplicate keys.");
    }
    keyring.set(
      key,
      principal({ projectId, ...(userId === undefined ? {} : { userId }) }),
    );
  }
  return keyring;
}

export function materializeApiKeyring(
  input: ApiKeyringInput,
): Map<string, ApiKeyPrincipal> {
  const entries =
    input instanceof Map ? input.entries() : Object.entries(input);
  return new Map(
    [...entries].map(([key, value]) => {
      if (key.trim().length === 0)
        throw new Error("API keys must not be empty.");
      return [key, principal(value)] as const;
    }),
  );
}
