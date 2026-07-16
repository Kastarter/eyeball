import { emailCapabilityContracts } from "./capabilities/email.js";
import { messagingCapabilityContracts } from "./capabilities/messaging.js";
import { voiceCapabilityContracts } from "./capabilities/voice.js";
import { voiceAgentCapabilityContracts } from "./capabilities/voice-agents.js";
import { CATALOG_VERSION } from "./catalog.js";
import { deepgramManifest } from "./manifests/deepgram.js";
import { discordManifest } from "./manifests/discord.js";
import { elevenLabsManifest } from "./manifests/elevenlabs.js";
import { gmailManifest } from "./manifests/gmail.js";
import { liveKitManifest } from "./manifests/livekit.js";
import { mailgunManifest } from "./manifests/mailgun.js";
import { microsoftOutlookManifest } from "./manifests/microsoft-outlook.js";
import { pipecatManifest } from "./manifests/pipecat.js";
import { resendManifest } from "./manifests/resend.js";
import { sendGridManifest } from "./manifests/sendgrid.js";
import { slackManifest } from "./manifests/slack.js";
import { smtpManifest } from "./manifests/smtp.js";
import { telegramManifest } from "./manifests/telegram.js";
import { twilioManifest } from "./manifests/twilio.js";
import { voiceAgentsManifest } from "./manifests/voice-agents.js";
import { whatsAppBusinessManifest } from "./manifests/whatsapp-business.js";
import { CatalogRegistry } from "./registry.js";

/** The materialized catalog shipped by the open-core runtime. */
export const defaultCatalog = new CatalogRegistry({
  catalogVersion: CATALOG_VERSION,
  contracts: [
    ...emailCapabilityContracts,
    ...messagingCapabilityContracts,
    ...voiceCapabilityContracts,
    ...voiceAgentCapabilityContracts,
  ],
  manifests: [
    gmailManifest,
    microsoftOutlookManifest,
    smtpManifest,
    sendGridManifest,
    resendManifest,
    mailgunManifest,
    slackManifest,
    discordManifest,
    telegramManifest,
    whatsAppBusinessManifest,
    twilioManifest,
    liveKitManifest,
    pipecatManifest,
    elevenLabsManifest,
    deepgramManifest,
    voiceAgentsManifest,
  ],
});
