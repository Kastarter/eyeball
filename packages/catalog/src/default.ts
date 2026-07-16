import { emailCapabilityContracts } from "./capabilities/email.js";
import { CATALOG_VERSION } from "./catalog.js";
import { gmailManifest } from "./manifests/gmail.js";
import { mailgunManifest } from "./manifests/mailgun.js";
import { microsoftOutlookManifest } from "./manifests/microsoft-outlook.js";
import { resendManifest } from "./manifests/resend.js";
import { sendGridManifest } from "./manifests/sendgrid.js";
import { smtpManifest } from "./manifests/smtp.js";
import { CatalogRegistry } from "./registry.js";

/** The materialized catalog shipped by the open-core runtime. */
export const defaultCatalog = new CatalogRegistry({
  catalogVersion: CATALOG_VERSION,
  contracts: emailCapabilityContracts,
  manifests: [
    gmailManifest,
    microsoftOutlookManifest,
    smtpManifest,
    sendGridManifest,
    resendManifest,
    mailgunManifest,
  ],
});
