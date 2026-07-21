import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type Clock,
  EyeballError,
  isCanonicalToolName,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  VOICE_AGENT_MAX_DURATION_SECONDS,
} from "@eyeball/core";
import type { AgentStore, VoiceSessionGrantIssuer } from "@eyeball/toolkits";

export const VOICE_SESSION_GRANT_PREFIX = "evg1.";
export const VOICE_SESSION_GRANT_AUDIENCE =
  "eyeball.executor.voice-session.execute.v1";

const SIGNING_DOMAIN = "eyeball.voice-session-grant.v1\0";
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_TOOLS = 256;
const CLOCK_SKEW_SECONDS = 30;
const MAX_DATE_UNIX_SECONDS = 8_640_000_000_000;
const SESSION_ID_PATTERN = /^session_[0-9a-f]{32}$/;
const GRANT_ID_PATTERN = /^vsg_[A-Za-z0-9_-]{43}$/;
const CLAIM_KEYS = [
  "aud",
  "exp",
  "iat",
  "jti",
  "projectId",
  "sessionId",
  "tools",
  "userId",
] as const;

interface VoiceSessionGrantClaims {
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  projectId: string;
  sessionId: string;
  tools: readonly QualifiedToolName[];
  userId: string;
}

export interface VoiceSessionGrantPrincipal {
  kind: "voice_session_grant";
  projectId: string;
  userId: string;
  sessionId: string;
  grantId: string;
  expiresAt: string;
  allowedTools: readonly QualifiedToolName[];
}

export type VoiceSessionGrantVerificationResult =
  | { status: "valid"; principal: VoiceSessionGrantPrincipal }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "insufficient_scope" }
  | { status: "unavailable" };

export interface VoiceSessionGrantVerifier {
  verify(token: string): Promise<VoiceSessionGrantVerificationResult>;
}

export interface VoiceSessionGrantAuthority {
  issuer: VoiceSessionGrantIssuer;
  verifier: VoiceSessionGrantVerifier;
}

interface VoiceSessionGrantAuthorityOptions {
  secret: string;
  store: AgentStore;
  clock: Clock;
  randomBytes?: (size: number) => Uint8Array;
}

function canonicalClaimsJson(claims: VoiceSessionGrantClaims): string {
  return JSON.stringify({
    aud: claims.aud,
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    projectId: claims.projectId,
    sessionId: claims.sessionId,
    tools: claims.tools,
    userId: claims.userId,
  });
}

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function signedBytes(secret: string, payloadSegment: string): Buffer {
  return createHmac("sha256", secret)
    .update(SIGNING_DOMAIN)
    .update(payloadSegment)
    .digest();
}

function nonEmptyIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function unixSeconds(clock: Clock): number {
  const milliseconds = clock.now().getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Voice-session grant clock returned an invalid date.");
  }
  return Math.floor(milliseconds / 1_000);
}

function normalizedClaims(value: unknown): VoiceSessionGrantClaims | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== CLAIM_KEYS.length ||
    !CLAIM_KEYS.every((key, index) => keys[index] === key)
  ) {
    return undefined;
  }
  if (
    typeof object.aud !== "string" ||
    !Number.isSafeInteger(object.exp) ||
    !Number.isSafeInteger(object.iat) ||
    typeof object.exp !== "number" ||
    typeof object.iat !== "number" ||
    object.exp <= object.iat ||
    Math.abs(object.exp) > MAX_DATE_UNIX_SECONDS ||
    Math.abs(object.iat) > MAX_DATE_UNIX_SECONDS ||
    !nonEmptyIdentifier(object.projectId) ||
    !nonEmptyIdentifier(object.userId) ||
    typeof object.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(object.sessionId) ||
    typeof object.jti !== "string" ||
    !GRANT_ID_PATTERN.test(object.jti) ||
    !Array.isArray(object.tools) ||
    object.tools.length > MAX_TOOLS
  ) {
    return undefined;
  }
  const tools: QualifiedToolName[] = [];
  let previous: string | undefined;
  for (const tool of object.tools) {
    if (
      typeof tool !== "string" ||
      !isCanonicalToolName(tool) ||
      (previous !== undefined && tool <= previous)
    ) {
      return undefined;
    }
    tools.push(tool);
    previous = tool;
  }
  return {
    aud: object.aud,
    exp: object.exp,
    iat: object.iat,
    jti: object.jti,
    projectId: object.projectId,
    sessionId: object.sessionId,
    tools,
    userId: object.userId,
  };
}

function pointerMissing(error: unknown): boolean {
  return (
    error instanceof EyeballError && error.code === TOOL_ERROR_CODES.NOT_FOUND
  );
}

export function createVoiceSessionGrantAuthority(
  options: VoiceSessionGrantAuthorityOptions,
): VoiceSessionGrantAuthority {
  if (Buffer.byteLength(options.secret, "utf8") < 32) {
    throw new Error(
      "EYEBALL_VOICE_SESSION_GRANT_SECRET must contain at least 32 UTF-8 bytes.",
    );
  }
  const secret = options.secret;
  const random = options.randomBytes ?? randomBytes;

  const issuer: VoiceSessionGrantIssuer = {
    async issue(input) {
      if (
        !nonEmptyIdentifier(input.projectId) ||
        !nonEmptyIdentifier(input.userId) ||
        !SESSION_ID_PATTERN.test(input.sessionId) ||
        !Number.isSafeInteger(input.maxDurationSeconds) ||
        input.maxDurationSeconds <= 0 ||
        input.maxDurationSeconds > VOICE_AGENT_MAX_DURATION_SECONDS
      ) {
        throw new Error(
          "Cannot issue a voice-session grant for invalid scope.",
        );
      }
      const tools = [...new Set(input.allowedTools)].sort();
      if (
        tools.length > MAX_TOOLS ||
        tools.some((tool) => !isCanonicalToolName(tool))
      ) {
        throw new Error(
          "Cannot issue a voice-session grant for invalid tools.",
        );
      }
      const iat = unixSeconds(options.clock);
      const exp = iat + input.maxDurationSeconds + 60;
      if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_DATE_UNIX_SECONDS) {
        throw new Error(
          "Cannot issue a voice-session grant with an invalid expiry.",
        );
      }
      const grantId = `vsg_${encode(random(32))}`;
      if (!GRANT_ID_PATTERN.test(grantId)) {
        throw new Error(
          "Voice-session grant entropy source returned invalid bytes.",
        );
      }
      const claims: VoiceSessionGrantClaims = {
        aud: VOICE_SESSION_GRANT_AUDIENCE,
        exp,
        iat,
        jti: grantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        tools,
        userId: input.userId,
      };
      const payload = encode(canonicalClaimsJson(claims));
      const token = `${VOICE_SESSION_GRANT_PREFIX}${payload}.${encode(
        signedBytes(secret, payload),
      )}`;
      if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
        throw new Error("Voice-session grant exceeds the maximum token size.");
      }
      return {
        token,
        grantId,
        expiresAt: new Date(exp * 1_000).toISOString(),
      };
    },
  };

  const verifier: VoiceSessionGrantVerifier = {
    async verify(token) {
      if (
        !token.startsWith(VOICE_SESSION_GRANT_PREFIX) ||
        Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES
      ) {
        return { status: "invalid" };
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "evg1") {
        return { status: "invalid" };
      }
      const payloadSegment = parts[1] ?? "";
      const suppliedSignature = decode(parts[2] ?? "");
      if (suppliedSignature === undefined || suppliedSignature.length !== 32) {
        return { status: "invalid" };
      }
      const expectedSignature = signedBytes(secret, payloadSegment);
      if (!timingSafeEqual(suppliedSignature, expectedSignature)) {
        return { status: "invalid" };
      }

      const payloadBytes = decode(payloadSegment);
      if (payloadBytes === undefined) return { status: "invalid" };
      let parsed: unknown;
      try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(
          payloadBytes,
        );
        parsed = JSON.parse(json) as unknown;
      } catch {
        return { status: "invalid" };
      }
      const claims = normalizedClaims(parsed);
      if (
        claims === undefined ||
        encode(canonicalClaimsJson(claims)) !== payloadSegment
      ) {
        return { status: "invalid" };
      }
      if (claims.aud !== VOICE_SESSION_GRANT_AUDIENCE) {
        return { status: "insufficient_scope" };
      }
      const now = unixSeconds(options.clock);
      if (
        claims.iat > now + CLOCK_SKEW_SECONDS ||
        now > claims.exp + CLOCK_SKEW_SECONDS
      ) {
        return { status: "expired" };
      }

      try {
        const pointer = await options.store.getSession(
          claims.projectId,
          claims.userId,
          claims.sessionId,
        );
        const expiresAt = new Date(claims.exp * 1_000).toISOString();
        if (
          pointer.grantId !== claims.jti ||
          pointer.grantExpiresAt !== expiresAt ||
          pointer.grantRevokedAt !== undefined
        ) {
          return { status: "expired" };
        }
        return {
          status: "valid",
          principal: {
            kind: "voice_session_grant",
            projectId: claims.projectId,
            userId: claims.userId,
            sessionId: claims.sessionId,
            grantId: claims.jti,
            expiresAt,
            allowedTools: claims.tools,
          },
        };
      } catch (error) {
        return pointerMissing(error)
          ? { status: "expired" }
          : { status: "unavailable" };
      }
    },
  };

  return { issuer, verifier };
}

export function createConfiguredVoiceSessionGrantAuthority(options: {
  env: Readonly<Record<string, string | undefined>>;
  store: AgentStore;
  clock: Clock;
  randomBytes?: (size: number) => Uint8Array;
}): VoiceSessionGrantAuthority | undefined {
  const configured = options.env.EYEBALL_VOICE_SESSION_GRANT_SECRET?.trim();
  if (configured === undefined || configured.length === 0) return undefined;
  return createVoiceSessionGrantAuthority({
    secret: configured,
    store: options.store,
    clock: options.clock,
    ...(options.randomBytes === undefined
      ? {}
      : { randomBytes: options.randomBytes }),
  });
}
