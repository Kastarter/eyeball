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
  createInProcessExecutorHarness,
  executionOutput,
  type InProcessExecutorHarness,
} from "../helpers/executor-harness.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  type MockKitModule,
  type ProviderMock,
} from "../mocks-checkout.js";
import type { ContractTarget } from "./fixtures.js";

type MockProviderModule = Readonly<Record<string, unknown>>;

interface MockModules {
  readonly mockKit: MockKitModule;
  readonly business: MockProviderModule;
  readonly email: MockProviderModule;
  readonly messaging: MockProviderModule;
  readonly productivity: MockProviderModule;
  readonly social: MockProviderModule;
  readonly voice: MockProviderModule;
}

const mockModules: MockModules | undefined = hasMocksCheckout()
  ? await Promise.all([
      loadMocksModule<MockKitModule>("mock-kit"),
      loadMocksModule<MockProviderModule>("mocks-business"),
      loadMocksModule<MockProviderModule>("mocks-email"),
      loadMocksModule<MockProviderModule>("mocks-messaging"),
      loadMocksModule<MockProviderModule>("mocks-productivity"),
      loadMocksModule<MockProviderModule>("mocks-social"),
      loadMocksModule<MockProviderModule>("mocks-voice"),
    ]).then(
      ([mockKit, business, email, messaging, productivity, social, voice]) => ({
        mockKit,
        business,
        email,
        messaging,
        productivity,
        social,
        voice,
      }),
    )
  : undefined;

interface MockDefinition {
  readonly create: () => ProviderMock;
  readonly seed?: unknown;
  readonly providerSlug?: string;
}

function requiredMockExport(
  module: MockProviderModule,
  exportName: string,
): unknown {
  const value = module[exportName];
  if (value === undefined) {
    throw new Error(`Mockhouse module did not export ${exportName}.`);
  }
  return value;
}

function mockFactory(
  module: MockProviderModule,
  exportName: string,
): () => ProviderMock {
  const value = requiredMockExport(module, exportName);
  if (typeof value !== "function") {
    throw new Error(`Mockhouse export ${exportName} is not a factory.`);
  }
  return value as () => ProviderMock;
}

function mockFixture(module: MockProviderModule, exportName: string): unknown {
  const value = requiredMockExport(module, exportName);
  if (typeof value !== "object" || value === null || !("default" in value)) {
    throw new Error(`Mockhouse export ${exportName} has no default fixture.`);
  }
  return (value as { default: unknown }).default;
}

function mockDefinition(
  module: MockProviderModule,
  factoryExport: string,
  fixtureExport: string,
  providerSlug?: string,
): MockDefinition {
  return {
    create: mockFactory(module, factoryExport),
    seed: mockFixture(module, fixtureExport),
    ...(providerSlug === undefined ? {} : { providerSlug }),
  };
}

function createMockDefinitions(
  modules: MockModules,
): Readonly<Record<string, MockDefinition>> {
  const socialDefinition = mockDefinition(
    modules.social,
    "createScrapeCreatorsMock",
    "scrapeCreatorsFixtures",
    "scrapecreators",
  );

  return {
    airtable: mockDefinition(
      modules.productivity,
      "createAirtableMock",
      "airtableFixtures",
    ),
    deepgram: mockDefinition(
      modules.voice,
      "createDeepgramMock",
      "deepgramFixtures",
    ),
    discord: mockDefinition(
      modules.messaging,
      "createDiscordMock",
      "discordFixtures",
    ),
    elevenlabs: mockDefinition(
      modules.voice,
      "createElevenLabsMock",
      "elevenLabsFixtures",
    ),
    github: mockDefinition(
      modules.productivity,
      "createGitHubMock",
      "githubFixtures",
    ),
    gmail: mockDefinition(modules.email, "createGmailMock", "gmailFixtures"),
    "google-calendar": mockDefinition(
      modules.productivity,
      "createGoogleCalendarMock",
      "googleCalendarFixtures",
    ),
    "google-drive": mockDefinition(
      modules.productivity,
      "createGoogleDriveMock",
      "googleDriveFixtures",
    ),
    "google-sheets": mockDefinition(
      modules.productivity,
      "createGoogleSheetsMock",
      "googleSheetsFixtures",
    ),
    hubspot: mockDefinition(
      modules.business,
      "createHubSpotMock",
      "hubSpotFixtures",
    ),
    "instagram-data": socialDefinition,
    linear: mockDefinition(
      modules.productivity,
      "createLinearMock",
      "linearFixtures",
    ),
    "linkedin-data": socialDefinition,
    livekit: mockDefinition(
      modules.voice,
      "createLiveKitMock",
      "liveKitFixtures",
    ),
    mailgun: mockDefinition(
      modules.email,
      "createMailgunMock",
      "mailgunFixtures",
    ),
    "microsoft-outlook": mockDefinition(
      modules.email,
      "createMicrosoftOutlookMock",
      "microsoftOutlookFixtures",
    ),
    notion: mockDefinition(
      modules.productivity,
      "createNotionMock",
      "notionFixtures",
    ),
    odoo: mockDefinition(modules.business, "createOdooMock", "odooFixtures"),
    pipecat: mockDefinition(
      modules.voice,
      "createPipecatMock",
      "pipecatFixtures",
    ),
    quickbooks: mockDefinition(
      modules.business,
      "createQuickBooksMock",
      "quickBooksFixtures",
    ),
    "reddit-data": socialDefinition,
    resend: mockDefinition(modules.email, "createResendMock", "resendFixtures"),
    sendgrid: mockDefinition(
      modules.email,
      "createSendGridMock",
      "sendGridFixtures",
    ),
    shopify: mockDefinition(
      modules.business,
      "createShopifyMock",
      "shopifyFixtures",
    ),
    slack: mockDefinition(
      modules.messaging,
      "createSlackMock",
      "slackFixtures",
    ),
    smtp: mockDefinition(modules.email, "createSmtpMock", "smtpFixtures"),
    "snapchat-data": socialDefinition,
    stripe: mockDefinition(
      modules.business,
      "createStripeMock",
      "stripeFixtures",
    ),
    telegram: mockDefinition(
      modules.messaging,
      "createTelegramMock",
      "telegramFixtures",
    ),
    "tiktok-data": socialDefinition,
    twilio: mockDefinition(modules.voice, "createTwilioMock", "twilioFixtures"),
    "twitch-data": socialDefinition,
    "voice-agents": mockDefinition(
      modules.voice,
      "createPipecatMock",
      "pipecatFixtures",
      "pipecat",
    ),
    "whatsapp-business": mockDefinition(
      modules.messaging,
      "createWhatsAppBusinessMock",
      "whatsAppBusinessFixtures",
    ),
    "x-data": socialDefinition,
    "youtube-data": socialDefinition,
    zendesk: mockDefinition(
      modules.business,
      "createZendeskMock",
      "zendeskFixtures",
    ),
  };
}

const MOCKS =
  mockModules === undefined ? {} : createMockDefinitions(mockModules);

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
  if (expired && mockModules === undefined) {
    throw new Error(
      "Mockhouse checkout is required for an expired credential.",
    );
  }
  const token = expired ? mockModules?.mockKit.EXPIRED_TOKEN : "fixture:valid";
  if (token === undefined) {
    throw new Error("Mockhouse checkout did not provide EXPIRED_TOKEN.");
  }
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
    if (mockModules === undefined) {
      throw new Error("Mockhouse checkout is required for contract mocks.");
    }
    const definition = MOCKS[slug];
    if (definition === undefined) {
      throw new Error(
        `No in-process mock registered for catalog provider ${slug}.`,
      );
    }
    const provider = definition.create();
    const liveKitProvider =
      slug === "voice-agents"
        ? mockFactory(mockModules.voice, "createLiveKitMock")()
        : undefined;
    const twilioProvider =
      slug === "voice-agents"
        ? mockFactory(mockModules.voice, "createTwilioMock")()
        : undefined;
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
          await provider.seed(definition.seed);
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
