#!/usr/bin/env node

// Security gate CLI. This entry point scans UNCONDITIONALLY on execution —
// there is deliberately no "am I the entry module" guard, because any such
// heuristic that guesses wrong silently skips the scan and exits 0 (fail
// open). Library consumers (tests) import ./secret-scan.js instead.

import { scanRepository, selectedRepository } from "./secret-scan.js";

const root = selectedRepository(process.argv.slice(2));
const findings = scanRepository(root);
if (findings.length === 0) {
  process.stdout.write("Secret scan passed for tracked files.\n");
} else {
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
