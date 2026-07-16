import { emailCapabilityContracts } from "./capabilities/email.js";
import { messagingCapabilityContracts } from "./capabilities/messaging.js";
import { CATALOG_VERSION } from "./catalog.js";
import { discordManifest } from "./manifests/discord.js";
import { gmailManifest } from "./manifests/gmail.js";
import { mailgunManifest } from "./manifests/mailgun.js";
import { microsoftOutlookManifest } from "./manifests/microsoft-outlook.js";
import { resendManifest } from "./manifests/resend.js";
import { sendGridManifest } from "./manifests/sendgrid.js";
import { slackManifest } from "./manifests/slack.js";
import { smtpManifest } from "./manifests/smtp.js";
import { telegramManifest } from "./manifests/telegram.js";
import { whatsAppBusinessManifest } from "./manifests/whatsapp-business.js";
import { CatalogRegistry } from "./registry.js";

/** The materialized catalog shipped by the open-core runtime. */
export const defaultCatalog = new CatalogRegistry({
  catalogVersion: CATALOG_VERSION,
  contracts: [...emailCapabilityContracts, ...messagingCapabilityContracts],
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
  ],
});
