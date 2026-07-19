import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepository, scanText } from "./secret-scan.js";

describe("tracked-file secret scanner", () => {
  it("detects known production prefixes without returning the secret", () => {
    const candidate = [
      "eb",
      "live",
      "mJ8pQ2vZ7xN4cR6tW9yK3sF5dH1uL0aB8eC2gT7q",
    ].join("_");
    const findings = scanText(
      "config.ts",
      `export const apiKey = "${candidate}";`,
    );

    expect(findings).toContainEqual({
      path: "config.ts",
      line: 1,
      rule: "eyeball-live-api-key",
    });
    expect(JSON.stringify(findings)).not.toContain(candidate);
  });

  it("detects high-entropy credential assignments", () => {
    const candidate = ["mJ8pQ2vZ7xN4", "cR6tW9yK3sF5dH1uL0aB"].join("");

    expect(
      scanText("settings.ts", `\nconst clientSecret = "${candidate}";`),
    ).toContainEqual({
      path: "settings.ts",
      line: 2,
      rule: "high-entropy-credential-literal",
    });
  });

  it("detects high-entropy secrets embedded in URL queries", () => {
    const candidate = ["mJ8pQ2vZ7xN4", "cR6tW9yK3sF5dH1uL0aB"].join("");
    const findings = scanText(
      "callback.ts",
      `const callback = "https://service.example/callback?token=${candidate}";`,
    );

    expect(findings).toContainEqual({
      path: "callback.ts",
      line: 1,
      rule: "url-query-secret",
    });
    expect(JSON.stringify(findings)).not.toContain(candidate);
  });

  it("ignores explicit fixture values and placeholders", () => {
    expect(
      scanText(
        "fixture.ts",
        'const token = "worker-control-test-token-at-least-32-bytes";',
      ),
    ).toEqual([]);
    expect(scanText(".env.example", "API_KEY=replace-me")).toEqual([]);
  });

  it("does not let a file-wide comment suppress a production-shaped key", () => {
    const candidate = [
      "eb",
      "live",
      "mJ8pQ2vZ7xN4cR6tW9yK3sF5dH1uL0aB8eC2gT7q",
    ].join("_");

    expect(
      scanText(
        "config.ts",
        `// secret-scan: allow-file\nexport const apiKey = "${candidate}";`,
      ),
    ).toContainEqual({
      path: "config.ts",
      line: 2,
      rule: "eyeball-live-api-key",
    });
  });

  it("does not treat fixture words embedded in random material as an allowlist", () => {
    const candidate = [
      "eb",
      "live",
      "mJ8pQ2vZ7xN4cR6testW9yK3sF5dH1uL0aB8eC2gT7q",
    ].join("_");

    expect(
      scanText("config.ts", `const apiKey = "${candidate}";`),
    ).toContainEqual({
      path: "config.ts",
      line: 1,
      rule: "eyeball-live-api-key",
    });
  });

  it("skips index-visible files deleted from the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "eyeball-secret-scan-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      writeFileSync(
        join(root, "kept.ts"),
        'export const token = "fixture:valid";\n',
      );
      writeFileSync(
        join(root, "removed.ts"),
        'export const token = "fixture:removed";\n',
      );
      execFileSync("git", ["add", "kept.ts", "removed.ts"], { cwd: root });
      unlinkSync(join(root, "removed.ts"));

      expect(scanRepository(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
