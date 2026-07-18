import {
  credentialMappingForManifest,
  requiredCredentialEnvironment,
} from "@eyeball/catalog";
import {
  type CredentialProvider,
  CredentialProviderError,
  type EnvCredentialMapping,
  EnvCredentialProvider,
  type JsonValue,
  type ProviderManifest,
  type ResolvedCredential,
} from "@eyeball/core";
import { VoiceAgentsAdapter } from "@eyeball/toolkits";
import {
  EXPIRED_TOKEN,
  type ProviderMock,
  type SeedInput,
} from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  createHubSpotMock,
  createOdooMock,
  createQuickBooksMock,
  createShopifyMock,
  createStripeMock,
  createZendeskMock,
  hubSpotFixtures,
  odooFixtures,
  quickBooksFixtures,
  shopifyFixtures,
  stripeFixtures,
  zendeskFixtures,
} from "../../../../mocks/packages/mocks-business/dist/index.js";
import {
  createGmailMock,
  createMailgunMock,
  createMicrosoftOutlookMock,
  createResendMock,
  createSendGridMock,
  createSmtpMock,
  gmailFixtures,
  mailgunFixtures,
  microsoftOutlookFixtures,
  resendFixtures,
  sendGridFixtures,
  smtpFixtures,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createDiscordMock,
  createSlackMock,
  createTelegramMock,
  createWhatsAppBusinessMock,
  discordFixtures,
  slackFixtures,
  telegramFixtures,
  whatsAppBusinessFixtures,
} from "../../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  airtableFixtures,
  createAirtableMock,
  createGitHubMock,
  createGoogleCalendarMock,
  createGoogleDriveMock,
  createGoogleSheetsMock,
  createLinearMock,
  createNotionMock,
  githubFixtures,
  googleCalendarFixtures,
  googleDriveFixtures,
  googleSheetsFixtures,
  linearFixtures,
  notionFixtures,
} from "../../../../mocks/packages/mocks-productivity/dist/index.js";
import {
  createScrapeCreatorsMock,
  scrapeCreatorsFixtures,
} from "../../../../mocks/packages/mocks-social/dist/index.js";
import {
  createDeepgramMock,
  createElevenLabsMock,
  createLiveKitMock,
  createPipecatMock,
  createTwilioMock,
  deepgramFixtures,
  elevenLabsFixtures,
  liveKitFixtures,
  pipecatFixtures,
  twilioFixtures,
} from "../../../../mocks/packages/mocks-voice/dist/index.js";
import {
  createInProcessExecutorHarness,
  executionOutput,
  type InProcessExecutorHarness,
} from "../helpers/executor-harness.js";
import type { ContractTarget } from "./fixtures.js";

interface MockDefinition {
  readonly create: () => ProviderMock;
  readonly seed?: unknown;
  readonly providerSlug?: string;
}

const socialDefinition: MockDefinition = {
  create: createScrapeCreatorsMock,
  seed: scrapeCreatorsFixtures.default,
  providerSlug: "scrapecreators",
};

const MOCKS: Readonly<Record<string, MockDefinition>> = {
  airtable: { create: createAirtableMock, seed: airtableFixtures.default },
  deepgram: { create: createDeepgramMock, seed: deepgramFixtures.default },
  discord: { create: createDiscordMock, seed: discordFixtures.default },
  elevenlabs: {
    create: createElevenLabsMock,
    seed: elevenLabsFixtures.default,
  },
  github: { create: createGitHubMock, seed: githubFixtures.default },
  gmail: { create: createGmailMock, seed: gmailFixtures.default },
  "google-calendar": {
    create: createGoogleCalendarMock,
    seed: googleCalendarFixtures.default,
  },
  "google-drive": {
    create: createGoogleDriveMock,
    seed: googleDriveFixtures.default,
  },
  "google-sheets": {
    create: createGoogleSheetsMock,
    seed: googleSheetsFixtures.default,
  },
  hubspot: { create: createHubSpotMock, seed: hubSpotFixtures.default },
  "instagram-data": socialDefinition,
  linear: { create: createLinearMock, seed: linearFixtures.default },
  "linkedin-data": socialDefinition,
  livekit: { create: createLiveKitMock, seed: liveKitFixtures.default },
  mailgun: { create: createMailgunMock, seed: mailgunFixtures.default },
  "microsoft-outlook": {
    create: createMicrosoftOutlookMock,
    seed: microsoftOutlookFixtures.default,
  },
  notion: { create: createNotionMock, seed: notionFixtures.default },
  odoo: { create: createOdooMock, seed: odooFixtures.default },
  pipecat: { create: createPipecatMock, seed: pipecatFixtures.default },
  quickbooks: {
    create: createQuickBooksMock,
    seed: quickBooksFixtures.default,
  },
  "reddit-data": socialDefinition,
  resend: { create: createResendMock, seed: resendFixtures.default },
  sendgrid: { create: createSendGridMock, seed: sendGridFixtures.default },
  shopify: { create: createShopifyMock, seed: shopifyFixtures.default },
  slack: { create: createSlackMock, seed: slackFixtures.default },
  smtp: { create: createSmtpMock, seed: smtpFixtures.default },
  "snapchat-data": socialDefinition,
  stripe: { create: createStripeMock, seed: stripeFixtures.default },
  telegram: { create: createTelegramMock, seed: telegramFixtures.default },
  "tiktok-data": socialDefinition,
  twilio: { create: createTwilioMock, seed: twilioFixtures.default },
  "twitch-data": socialDefinition,
  "voice-agents": {
    create: createPipecatMock,
    seed: pipecatFixtures.default,
    providerSlug: "pipecat",
  },
  "whatsapp-business": {
    create: createWhatsAppBusinessMock,
    seed: whatsAppBusinessFixtures.default,
  },
  "x-data": socialDefinition,
  "youtube-data": socialDefinition,
  zendesk: { create: createZendeskMock, seed: zendeskFixtures.default },
};

export interface ContractTargetHarness {
  readonly harness: InProcessExecutorHarness;
  readonly readiness?: string;
  initialize(): Promise<void>;
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toUpperCase();
}

function envPrefix(
  kind: "EYEBALL_CRED" | "EYEBALL_REAL",
  slug: string,
): string {
  return `${kind}_${snakeCase(slug)}_`;
}

function apiKeyValues(
  fields: readonly string[],
  token: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    fields.map((field) => {
      if (field === "phoneNumberId") {
        return [field, "fixture:15550001111"];
      }
      if (field === "apiSecret") {
        return [field, "fixture:secret"];
      }
      return [field, token];
    }),
  );
}

function basicCredential(slug: string, token: string): ResolvedCredential {
  if (slug === "twilio") {
    return { type: "basic", username: "ACfixture", password: token };
  }
  if (slug === "odoo") {
    return {
      type: "basic",
      username: "fixture-user",
      password: token,
      parameters: { database: "fixture-db" },
    };
  }
  return { type: "basic", username: "fixture-user", password: token };
}

export function mockCredential(
  manifest: ProviderManifest,
  expired = false,
): ResolvedCredential {
  const token = expired ? EXPIRED_TOKEN : "fixture:valid";
  switch (manifest.auth.class) {
    case "oauth2":
      return {
        type: "oauth2",
        accessToken: token,
        scopes: [
          ...(manifest.auth.requiredScopes ?? []),
          ...(manifest.auth.optionalScopes ?? []),
        ],
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    case "api_key":
      return {
        type: "api_key",
        values: apiKeyValues(manifest.auth.fields ?? ["apiKey"], token),
      };
    case "basic":
      return basicCredential(manifest.toolkit.slug, token);
    case "none":
      return { type: "none" };
  }
}

function realReadiness(
  manifest: ProviderManifest,
  mapping: EnvCredentialMapping,
): { baseUrl?: string; reason?: string } {
  const realPrefix = envPrefix("EYEBALL_REAL", manifest.toolkit.slug);
  const baseUrlEnv = `${realPrefix}BASE_URL`;
  const required = [baseUrlEnv, ...requiredCredentialEnvironment(mapping)];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return { reason: `missing real configuration: ${missing.join(", ")}` };
  }
  const baseUrl = process.env[baseUrlEnv];
  return baseUrl === undefined ? {} : { baseUrl };
}

export function createContractTargetHarness(
  manifest: ProviderManifest,
  target: ContractTarget,
  options: { expired?: boolean } = {},
): ContractTargetHarness {
  const slug = manifest.toolkit.slug;
  if (target === "mock") {
    const definition = MOCKS[slug];
    if (definition === undefined) {
      throw new Error(
        `No in-process mock registered for catalog provider ${slug}.`,
      );
    }
    const provider = definition.create();
    const liveKitProvider =
      slug === "voice-agents" ? createLiveKitMock() : undefined;
    const twilioProvider =
      slug === "voice-agents" ? createTwilioMock() : undefined;
    const liveKitHarness =
      liveKitProvider === undefined
        ? undefined
        : createInProcessExecutorHarness({
            toolkitSlug: "livekit",
            provider: liveKitProvider,
            credential: {
              type: "api_key",
              values: {
                apiKey: "fixture:valid",
                apiSecret: "fixture:secret",
              },
            },
            label: "contract_voice_agents_livekit",
          });
    const twilioHarness =
      twilioProvider === undefined
        ? undefined
        : createInProcessExecutorHarness({
            toolkitSlug: "twilio",
            provider: twilioProvider,
            credential: {
              type: "basic",
              username: "ACfixture",
              password: "fixture:valid",
            },
            label: "contract_voice_agents_twilio",
          });
    const adapter =
      slug === "voice-agents"
        ? new VoiceAgentsAdapter({
            executeProviderTool: async (request) => {
              const nested = request.tool.startsWith("livekit.")
                ? liveKitHarness
                : twilioHarness;
              if (nested === undefined) {
                throw new Error(
                  `No nested voice provider harness for ${request.tool}.`,
                );
              }
              return executionOutput(
                await nested.execute(request.tool, request.input),
              ) as JsonValue;
            },
          })
        : undefined;
    const harness = createInProcessExecutorHarness({
      toolkitSlug: slug,
      provider,
      credential: mockCredential(manifest, options.expired),
      ...(adapter === undefined ? {} : { adapter }),
      ...(definition.providerSlug === "scrapecreators"
        ? { baseUrlEnv: "EYEBALL_SCRAPECREATORS_BASE_URL" }
        : {}),
      label: `contract_${slug}`,
    });
    return {
      harness,
      async initialize() {
        if (definition.seed !== undefined) {
          await provider.seed(definition.seed as SeedInput);
        }
      },
    };
  }

  const mapping = credentialMappingForManifest(manifest);
  const readiness = realReadiness(manifest, mapping);
  const env = process.env;
  const adapter =
    slug === "voice-agents" ? new VoiceAgentsAdapter() : undefined;
  const credentialProvider: CredentialProvider = options.expired
    ? {
        kind: "mock",
        async resolve() {
          throw new CredentialProviderError({
            code: "auth_expired",
            message: `The configured ${slug} certification credential is expired.`,
            retryable: false,
          });
        },
      }
    : new EnvCredentialProvider({
        mappings: { [slug]: mapping },
        env,
        allowedProjectId: "proj_in_process",
        allowedUserId: "user_in_process",
      });
  return {
    ...(readiness.reason === undefined ? {} : { readiness: readiness.reason }),
    harness: createInProcessExecutorHarness({
      toolkitSlug: slug,
      credentialProvider,
      ...(adapter === undefined ? {} : { adapter }),
      env,
      ...(readiness.baseUrl === undefined
        ? {}
        : { baseUrl: readiness.baseUrl }),
      ...(MOCKS[slug]?.providerSlug === "scrapecreators"
        ? { baseUrlEnv: "EYEBALL_SCRAPECREATORS_BASE_URL" }
        : {}),
      label: `contract_real_${slug}`,
    }),
    initialize: async () => undefined,
  };
}

export function hasMockDefinition(slug: string): boolean {
  return MOCKS[slug] !== undefined;
}
