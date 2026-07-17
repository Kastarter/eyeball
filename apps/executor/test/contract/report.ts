import { writeFileSync } from "node:fs";

export type ContractOutcome = "pass" | "not_supported" | "skipped" | "fail";
export const CONTRACT_SUITE_VERSION = "1.0.0";

export interface ContractReportRow {
  readonly capability: string;
  readonly provider: string;
  readonly tool: string;
  readonly canonicalVersion: string;
  readonly fixtureVersion: string;
  readonly manifestCatalogVersion: string;
  readonly manifestSchemaVersion: string;
  readonly suiteVersion: string;
  readonly target: "mock" | "real";
  readonly outcome: ContractOutcome;
  readonly reason?: string;
  readonly quirk?: string;
}

export interface ContractAssertionRow {
  readonly capability: string;
  readonly provider: string;
  readonly assertion: string;
  readonly target: "mock" | "real";
  readonly outcome: "pass" | "skipped" | "fail";
  readonly reason?: string;
}

const matrix = new Map<string, ContractReportRow>();
const assertions = new Map<string, ContractAssertionRow>();

function rowKey(row: ContractReportRow): string {
  return [row.target, row.capability, row.provider, row.tool].join(":");
}

function assertionKey(row: ContractAssertionRow): string {
  return [row.target, row.capability, row.provider, row.assertion].join(":");
}

export function recordContractRow(row: ContractReportRow): void {
  matrix.set(rowKey(row), row);
}

export function recordContractAssertion(row: ContractAssertionRow): void {
  assertions.set(assertionKey(row), row);
}

function countByOutcome<T extends { outcome: string }>(
  rows: readonly T[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  }
  return counts;
}

export function writeContractReport(target: "mock" | "real"): void {
  const rows = [...matrix.values()]
    .filter((row) => row.target === target)
    .sort((left, right) =>
      `${left.provider}:${left.tool}`.localeCompare(
        `${right.provider}:${right.tool}`,
      ),
    );
  const assertionRows = [...assertions.values()]
    .filter((row) => row.target === target)
    .sort((left, right) =>
      `${left.provider}:${left.assertion}`.localeCompare(
        `${right.provider}:${right.assertion}`,
      ),
    );
  const providers = new Set(rows.map((row) => row.provider));
  const report = {
    suiteVersion: CONTRACT_SUITE_VERSION,
    generatedAt: new Date().toISOString(),
    target,
    summary: {
      providers: providers.size,
      matrixRows: rows.length,
      outcomes: countByOutcome(rows),
      sharedAssertions: assertionRows.length,
      sharedAssertionOutcomes: countByOutcome(assertionRows),
    },
    matrix: rows,
    assertions: assertionRows,
  };
  const reportUrl = new URL("../../contract-report.json", import.meta.url);
  writeFileSync(reportUrl, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const outcomes = report.summary.outcomes;
  console.log(
    `[contract] target=${target} providers=${providers.size} rows=${rows.length} ` +
      `pass=${outcomes.pass ?? 0} not_supported=${outcomes.not_supported ?? 0} ` +
      `skipped=${outcomes.skipped ?? 0} fail=${outcomes.fail ?? 0}`,
  );
}
