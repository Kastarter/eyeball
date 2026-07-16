import { calendarCapabilityContracts } from "./capabilities/calendar.js";
import { crmCapabilityContracts } from "./capabilities/crm.js";
import { ecommerceCapabilityContracts } from "./capabilities/ecommerce.js";
import { emailCapabilityContracts } from "./capabilities/email.js";
import { erpCapabilityContracts } from "./capabilities/erp.js";
import { messagingCapabilityContracts } from "./capabilities/messaging.js";
import { paymentsCapabilityContracts } from "./capabilities/payments.js";
import { pmCapabilityContracts } from "./capabilities/pm.js";
import { socialDataCapabilityContracts } from "./capabilities/social-data.js";
import { spreadsheetsCapabilityContracts } from "./capabilities/spreadsheets.js";
import { storageCapabilityContracts } from "./capabilities/storage.js";
import { supportCapabilityContracts } from "./capabilities/support.js";
import { voiceCapabilityContracts } from "./capabilities/voice.js";
import { voiceAgentCapabilityContracts } from "./capabilities/voice-agents.js";
import { CATALOG_VERSION } from "./catalog.js";
import { airtableManifest } from "./manifests/airtable.js";
import { deepgramManifest } from "./manifests/deepgram.js";
import { discordManifest } from "./manifests/discord.js";
import { elevenLabsManifest } from "./manifests/elevenlabs.js";
import { gitHubManifest } from "./manifests/github.js";
import { gmailManifest } from "./manifests/gmail.js";
import { googleCalendarManifest } from "./manifests/google-calendar.js";
import { googleDriveManifest } from "./manifests/google-drive.js";
import { googleSheetsManifest } from "./manifests/google-sheets.js";
import { hubSpotManifest } from "./manifests/hubspot.js";
import { linearManifest } from "./manifests/linear.js";
import { liveKitManifest } from "./manifests/livekit.js";
import { mailgunManifest } from "./manifests/mailgun.js";
import { microsoftOutlookManifest } from "./manifests/microsoft-outlook.js";
import { notionManifest } from "./manifests/notion.js";
import { odooManifest } from "./manifests/odoo.js";
import { pipecatManifest } from "./manifests/pipecat.js";
import { quickBooksManifest } from "./manifests/quickbooks.js";
import { resendManifest } from "./manifests/resend.js";
import { sendGridManifest } from "./manifests/sendgrid.js";
import { shopifyManifest } from "./manifests/shopify.js";
import { slackManifest } from "./manifests/slack.js";
import { smtpManifest } from "./manifests/smtp.js";
import { socialDataManifests } from "./manifests/social-data.js";
import { stripeManifest } from "./manifests/stripe.js";
import { telegramManifest } from "./manifests/telegram.js";
import { twilioManifest } from "./manifests/twilio.js";
import { voiceAgentsManifest } from "./manifests/voice-agents.js";
import { whatsAppBusinessManifest } from "./manifests/whatsapp-business.js";
import { zendeskManifest } from "./manifests/zendesk.js";
import { CatalogRegistry } from "./registry.js";

/** The materialized catalog shipped by the open-core runtime. */
export const defaultCatalog = new CatalogRegistry({
  catalogVersion: CATALOG_VERSION,
  contracts: [
    ...emailCapabilityContracts,
    ...calendarCapabilityContracts,
    ...messagingCapabilityContracts,
    ...voiceCapabilityContracts,
    ...voiceAgentCapabilityContracts,
    ...crmCapabilityContracts,
    ...erpCapabilityContracts,
    ...paymentsCapabilityContracts,
    ...ecommerceCapabilityContracts,
    ...supportCapabilityContracts,
    ...socialDataCapabilityContracts,
    ...storageCapabilityContracts,
    ...spreadsheetsCapabilityContracts,
    ...pmCapabilityContracts,
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
    hubSpotManifest,
    odooManifest,
    quickBooksManifest,
    stripeManifest,
    shopifyManifest,
    zendeskManifest,
    googleCalendarManifest,
    googleDriveManifest,
    googleSheetsManifest,
    airtableManifest,
    notionManifest,
    gitHubManifest,
    linearManifest,
    ...socialDataManifests,
  ],
});
