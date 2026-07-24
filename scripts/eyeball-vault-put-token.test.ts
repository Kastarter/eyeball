import { describe, expect, it } from "vitest";
import {
  parseVaultPutTokenOptions,
  vaultPutTokenErrorMessage,
} from "./vault-put-token-options.js";

describe("vault token CLI argument boundary", () => {
  it("parses only documented non-secret selectors", () => {
    expect(
      parseVaultPutTokenOptions([
        "--user",
        "user_live",
        "--toolkit",
        "notion",
        "--type",
        "oauth2",
        "--client-id",
        "notion-internal-integration",
      ]),
    ).toEqual({
      userId: "user_live",
      toolkitSlug: "notion",
      credentialType: "oauth2",
      clientId: "notion-internal-integration",
    });
  });

  it.each([
    ["an access-token option", ["--token", "secret_candidate"]],
    ["an access-token alias", ["--access-token", "secret_candidate"]],
    ["a positional value", ["secret_candidate"]],
    [
      "a duplicate selector",
      [
        "--user",
        "user_live",
        "--user",
        "secret_candidate",
        "--toolkit",
        "notion",
      ],
    ],
    [
      "an invalid credential type",
      [
        "--user",
        "user_live",
        "--toolkit",
        "notion",
        "--type",
        "secret_candidate",
      ],
    ],
  ])("rejects %s without rendering the candidate", (_description, args) => {
    let rendered = "";
    try {
      parseVaultPutTokenOptions(args);
    } catch (error) {
      rendered = vaultPutTokenErrorMessage(error);
    }
    expect(rendered).not.toBe("");
    expect(rendered).not.toContain("secret_candidate");
  });

  it("does not render unexpected provider or vault causes", () => {
    expect(
      vaultPutTokenErrorMessage(
        new Error("provider rejected secret_candidate"),
      ),
    ).not.toContain("secret_candidate");
  });
});
