import type { ResolvedCredential } from "@eyeball/core";
import type {
  ActivepiecesAuthDeclaration,
  ActivepiecesPiece,
} from "./types.js";

export class BridgeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeAuthError";
  }
}

function declarations(
  piece: ActivepiecesPiece,
): readonly ActivepiecesAuthDeclaration[] {
  if (piece.auth === undefined) {
    return [];
  }
  return Array.isArray(piece.auth)
    ? piece.auth
    : [piece.auth as ActivepiecesAuthDeclaration];
}

function selectApiKey(
  values: Readonly<Record<string, string>>,
  preferredField?: string,
): string {
  if (preferredField !== undefined) {
    const selected = values[preferredField];
    if (selected === undefined || selected.length === 0) {
      throw new BridgeAuthError(
        `The resolved API-key credential does not contain ${preferredField}.`,
      );
    }
    return selected;
  }

  const entries = Object.entries(values);
  if (entries.length === 1 && entries[0] !== undefined) {
    return entries[0][1];
  }

  const commonField = entries.find(([name]) =>
    /^(api_?key|token|secret|personal_?access_?token)$/iu.test(name),
  );
  if (commonField !== undefined) {
    return commonField[1];
  }

  throw new BridgeAuthError(
    "A SECRET_TEXT piece requires one API-key value or an explicit apiKeyField.",
  );
}

function oauthValue(
  credential: Extract<ResolvedCredential, { type: "oauth2" }>,
): Readonly<Record<string, unknown>> {
  const now = Date.now();
  const expiresAt =
    credential.expiresAt === undefined
      ? undefined
      : Date.parse(credential.expiresAt);
  const expiresIn =
    expiresAt === undefined || !Number.isFinite(expiresAt)
      ? undefined
      : Math.max(0, Math.floor((expiresAt - now) / 1_000));
  return {
    type: "OAUTH2",
    access_token: credential.accessToken,
    token_type: credential.tokenType ?? "Bearer",
    scope: credential.scopes?.join(" ") ?? "",
    claimed_at: now,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    client_id: "",
    client_secret: "",
    redirect_url: "",
    refresh_token: "",
    token_url: "",
    data: {},
  };
}

/** Maps eyeball's vault result to the connection-value shape a piece receives. */
export function resolvedCredentialToPieceAuth(
  credential: ResolvedCredential,
  piece: ActivepiecesPiece,
  options: { readonly apiKeyField?: string } = {},
): unknown {
  const auth = declarations(piece);

  switch (credential.type) {
    case "none":
      if (auth.length > 0) {
        throw new BridgeAuthError(
          `${piece.displayName} declares authentication but received a none credential.`,
        );
      }
      return undefined;
    case "oauth2": {
      const declaration = auth.find((candidate) => candidate.type === "OAUTH2");
      if (declaration === undefined) {
        throw new BridgeAuthError(
          `${piece.displayName} does not declare an OAuth2 connection.`,
        );
      }
      return oauthValue(credential);
    }
    case "basic": {
      const declaration = auth.find(
        (candidate) => candidate.type === "BASIC_AUTH",
      );
      if (declaration === undefined) {
        throw new BridgeAuthError(
          `${piece.displayName} does not declare a basic-auth connection.`,
        );
      }
      return {
        type: "BASIC_AUTH",
        username: credential.username,
        password: credential.password,
      };
    }
    case "api_key": {
      const custom = auth.find((candidate) => candidate.type === "CUSTOM_AUTH");
      if (custom !== undefined) {
        return { type: "CUSTOM_AUTH", props: { ...credential.values } };
      }
      const secret = auth.find((candidate) => candidate.type === "SECRET_TEXT");
      if (secret !== undefined) {
        return {
          type: "SECRET_TEXT",
          secret_text: selectApiKey(credential.values, options.apiKeyField),
        };
      }
      throw new BridgeAuthError(
        `${piece.displayName} does not declare an API-key-compatible connection.`,
      );
    }
  }
}
