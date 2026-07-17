import { describe, expect, it } from "vitest";
import {
  createWebhookSignature,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../src/index.js";

const SECRET = "whsec_test_signature_secret";
const NOW = new Date("2026-07-17T12:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW.valueOf() / 1_000));
const PAYLOAD = JSON.stringify({ id: "evt_signature", ok: true });

function headers(timestamp = TIMESTAMP, payload = PAYLOAD): Headers {
  return new Headers({
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignature({
      payload,
      secret: SECRET,
      timestamp,
    }),
  });
}

describe("webhook signature verification", () => {
  it("accepts the exact signed raw payload inside the replay window", () => {
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        headers: headers(),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a payload changed after it was signed", () => {
    expect(
      verifyWebhookSignature({
        payload: `${PAYLOAD}\n`,
        headers: headers(),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects an otherwise valid signature outside the five-minute window", () => {
    const stale = String(Number(TIMESTAMP) - 301);
    expect(
      verifyWebhookSignature({
        payload: PAYLOAD,
        headers: headers(stale),
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });
});
