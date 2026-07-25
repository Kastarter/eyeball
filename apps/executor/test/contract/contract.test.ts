import { defaultCatalog } from "@eyeball/catalog";
import { afterAll, describe, it } from "vitest";
import { hasMocksCheckout, mocksSuiteTitle } from "../mocks-checkout.js";
import { calendarFixtures } from "./fixtures/calendar.js";
import { crmFixtures } from "./fixtures/crm.js";
import { ecommerceFixtures } from "./fixtures/ecommerce.js";
import { emailFixtures } from "./fixtures/email.js";
import { erpFixtures } from "./fixtures/erp.js";
import { messagingFixtures } from "./fixtures/messaging.js";
import { paymentsFixtures } from "./fixtures/payments.js";
import { projectManagementFixtures } from "./fixtures/project-management.js";
import { socialFixtures } from "./fixtures/social.js";
import { spreadsheetsFixtures } from "./fixtures/spreadsheets.js";
import { storageFixtures } from "./fixtures/storage.js";
import { supportFixtures } from "./fixtures/support.js";
import { voiceFixtures } from "./fixtures/voice.js";
import type { ContractTarget } from "./fixtures.js";
import {
  parseContractProviderFilter,
  validateContractProviderFilter,
} from "./provider-filter.js";
import { writeContractReport } from "./report.js";
import { describeCapability } from "./runner.js";

function contractTarget(): ContractTarget {
  const value = process.env.EYEBALL_CONTRACT_TARGET ?? "mock";
  if (value !== "mock" && value !== "real") {
    throw new Error("EYEBALL_CONTRACT_TARGET must be mock or real.");
  }
  return value;
}

const target = contractTarget();
const mocksAvailable = hasMocksCheckout();
const mockTargetUnavailable = target === "mock" && !mocksAvailable;
validateContractProviderFilter(
  parseContractProviderFilter(process.env.EYEBALL_CONTRACT_PROVIDERS),
  defaultCatalog.listManifests().map((manifest) => manifest.toolkit.slug),
);

describe.skipIf(mockTargetUnavailable)(
  mockTargetUnavailable
    ? mocksSuiteTitle("mock contract suite", mocksAvailable)
    : `${target} contract suite`,
  () => {
    if (mockTargetUnavailable) {
      it.skip("mocks checkout absent", () => {});
      return;
    }

    describeCapability("calendar_scheduling", {
      target,
      registry: calendarFixtures,
    });
    describeCapability("crm", { target, registry: crmFixtures });
    describeCapability("customer_support", {
      target,
      registry: supportFixtures,
    });
    describeCapability("ecommerce", { target, registry: ecommerceFixtures });
    describeCapability("email", { target, registry: emailFixtures });
    describeCapability("erp_accounting", { target, registry: erpFixtures });
    describeCapability("file_storage_docs", {
      target,
      registry: storageFixtures,
    });
    describeCapability("messaging_chat", {
      target,
      registry: messagingFixtures,
    });
    describeCapability("payments_billing", {
      target,
      registry: paymentsFixtures,
    });
    describeCapability("project_management_dev_tools", {
      target,
      registry: projectManagementFixtures,
    });
    describeCapability("social_media_data", {
      target,
      registry: socialFixtures,
    });
    describeCapability("spreadsheets_databases", {
      target,
      registry: spreadsheetsFixtures,
    });
    describeCapability("voice_telephony", { target, registry: voiceFixtures });
  },
);

afterAll(() => {
  writeContractReport(target);
});
