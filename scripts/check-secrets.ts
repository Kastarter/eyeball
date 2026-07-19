#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const SKIPPED_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".sqlite",
  ".sqlite3",
  ".webp",
  ".zip",
]);
const OBVIOUS_FIXTURE_MARKERS = [
  "dummy",
  "example",
  "fake",
  "fixture",
  "local",
  "mock",
  "never",
  "not-a-real",
  "placeholder",
  "redacted",
  "replace",
  "sample",
  "test",
  "top-secret",
];
const OBVIOUS_FIXTURE_PATTERN = new RegExp(
  `(?:^|[^a-z0-9])(?:${OBVIOUS_FIXTURE_MARKERS.map((marker) =>
    marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  ).join("|")})(?:$|[^a-z0-9])`,
  "u",
);

const KNOWN_SECRET_RULES: readonly SecretRule[] = [
  {
    id: "eyeball-live-api-key",
    pattern: /\beb_live_[A-Za-z0-9_-]{32,}\b/gu,
  },
  {
    id: "stripe-live-secret-key",
    pattern: /\b(?:rk|sk)_live_[A-Za-z0-9]{16,}\b/gu,
  },
  {
    id: "stripe-webhook-secret",
    pattern: /\bwhsec_[A-Za-z0-9]{20,}\b/gu,
  },
  {
    id: "github-token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/gu,
  },
  {
    id: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  },
  {
    id: "private-key-pem",
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu,
  },
];

const CREDENTIAL_LITERAL =
  /(?:api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|secret|token)\s*[:=]\s*["'`]([A-Za-z0-9+/_=.:-]{24,})["'`]/giu;
const URL_CREDENTIAL = /https?:\/\/[^\s/:@]+:([^\s/@]{12,})@[^\s/]+/giu;
const URL_QUERY_CREDENTIAL =
  /https?:\/\/[^\s"'`#]*[?&](?:api[_-]?key|key|secret|token)=([^&#\s"'`]{12,})/giu;

function lineNumber(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function obviouslyFixture(value: string): boolean {
  return OBVIOUS_FIXTURE_PATTERN.test(value.toLowerCase());
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const frequency of frequencies.values()) {
    const probability = frequency / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function entropyLike(value: string): boolean {
  if (obviouslyFixture(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter(
    (pattern) => pattern.test(value),
  ).length;
  return classes >= 3 && shannonEntropy(value) >= 3.7;
}

function addFinding(
  findings: SecretFinding[],
  seen: Set<string>,
  path: string,
  text: string,
  offset: number,
  rule: string,
): void {
  const line = lineNumber(text, offset);
  const identity = `${path}:${line}:${rule}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  findings.push({ path, line, rule });
}

/** Scans one tracked text file without returning or printing the candidate value. */
export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const rule of KNOWN_SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (value === undefined || obviouslyFixture(value)) continue;
      addFinding(findings, seen, path, text, match.index, rule.id);
    }
  }

  CREDENTIAL_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(CREDENTIAL_LITERAL)) {
    const value = match[1];
    if (value === undefined || !entropyLike(value)) continue;
    addFinding(
      findings,
      seen,
      path,
      text,
      match.index,
      "high-entropy-credential-literal",
    );
  }

  URL_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(URL_CREDENTIAL)) {
    const value = match[1];
    if (value === undefined || obviouslyFixture(value)) continue;
    addFinding(findings, seen, path, text, match.index, "url-userinfo-secret");
  }

  URL_QUERY_CREDENTIAL.lastIndex = 0;
  for (const match of text.matchAll(URL_QUERY_CREDENTIAL)) {
    const value = match[1];
    if (value === undefined || !entropyLike(value)) continue;
    addFinding(findings, seen, path, text, match.index, "url-query-secret");
  }

  return findings;
}

function trackedFiles(root: string): string[] {
  const encoded = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return encoded.split("\0").filter(Boolean);
}

/** Scans tracked, non-binary files in one Git worktree. */
export function scanRepository(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const path of trackedFiles(root)) {
    if (SKIPPED_EXTENSIONS.has(extname(path).toLowerCase())) {
      continue;
    }
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > MAX_TEXT_FILE_BYTES)
      continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    findings.push(...scanText(path, bytes.toString("utf8")));
  }
  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

function selectedRepository(argv: readonly string[]): string {
  const repoIndex = argv.indexOf("--repo");
  if (repoIndex === -1) return repositoryRoot;
  const value = argv[repoIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--repo requires a repository path.");
  }
  return resolve(value);
}

function main(): void {
  const root = selectedRepository(process.argv.slice(2));
  const findings = scanRepository(root);
  if (findings.length === 0) {
    process.stdout.write("Secret scan passed for tracked files.\n");
    return;
  }
  process.stderr.write(
    `${findings
      .map(
        (finding) =>
          `${finding.path}:${finding.line} [${finding.rule}] potential secret`,
      )
      .join("\n")}\n`,
  );
  process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  main();
}
