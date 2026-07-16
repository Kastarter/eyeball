import type { ToolkitAdapter } from "@eyeball/core";
import { gmailAdapter } from "./gmail.js";
import { mailgunAdapter } from "./mailgun.js";
import { microsoftOutlookAdapter } from "./microsoft-outlook.js";
import { resendAdapter } from "./resend.js";
import { sendGridAdapter } from "./sendgrid.js";
import { smtpAdapter } from "./smtp.js";

export * from "./gmail.js";
export * from "./mailgun.js";
export * from "./microsoft-outlook.js";
export * from "./resend.js";
export * from "./sendgrid.js";
export * from "./smtp.js";

/** Production email adapters shipped by the open-core runtime. */
export const emailToolkitAdapters = Object.freeze([
  gmailAdapter,
  microsoftOutlookAdapter,
  smtpAdapter,
  sendGridAdapter,
  resendAdapter,
  mailgunAdapter,
] as const satisfies readonly ToolkitAdapter[]);
