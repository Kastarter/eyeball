import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  includesValue,
  inputArray,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

function encodedRange(range: string): string {
  return encodeURIComponent(range);
}

function table(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const properties = recordValue(value, "properties") ?? value;
  const grid = recordValue(properties, "gridProperties") ?? {};
  return {
    tableId: requiredId(context, properties.sheetId, "sheet"),
    name: requiredString(context, properties, "title"),
    ...(numberValue(properties, "index") === undefined
      ? {}
      : { index: numberValue(properties, "index") }),
    ...(numberValue(grid, "rowCount") === undefined
      ? {}
      : { rowCount: numberValue(grid, "rowCount") }),
    ...(numberValue(grid, "columnCount") === undefined
      ? {}
      : { columnCount: numberValue(grid, "columnCount") }),
  };
}

function matrix(value: unknown): readonly JsonValue[][] {
  return Array.isArray(value)
    ? value.filter(Array.isArray).map((row) => row as JsonValue[])
    : [];
}

function sheetRange(name: string): string {
  return `'${name.replaceAll("'", "''")}'!A:ZZ`;
}

function rowsFromMatrix(
  sheetName: string,
  values: readonly JsonValue[][],
): Readonly<Record<string, unknown>>[] {
  const headers = (values[0] ?? []).map((value, index) =>
    typeof value === "string" && value.length > 0
      ? value
      : `column_${index + 1}`,
  );
  return values.slice(1).map((cells, index) => ({
    rowId: `${sheetName}:${index + 2}`,
    values: Object.fromEntries(
      cells.map((value, column) => [
        headers[column] ?? `column_${column + 1}`,
        value,
      ]),
    ),
  }));
}

function filterMatches(
  row: Readonly<Record<string, unknown>>,
  filter: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (filter === undefined) return true;
  const values = isRecord(row.values) ? row.values : {};
  return Object.entries(filter).every(
    ([key, expected]) =>
      JSON.stringify(values[key]) === JSON.stringify(expected),
  );
}

export class GoogleSheetsAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "google-sheets";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "google-sheets.list_rows":
        return this.listRows(context, false);
      case "google-sheets.search_rows":
        return this.listRows(context, true);
      case "google-sheets.append_row":
        return this.appendRows(context);
      case "google-sheets.get_range":
        return this.getRange(context);
      case "google-sheets.update_range":
        return this.updateRange(context);
      case "google-sheets.list_tables":
        return this.listTables(context);
      default:
        return unsupported(context);
    }
  }

  private async spreadsheet(
    context: AdapterContext,
    documentId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return jsonObject(
      context,
      `v4/spreadsheets/${encodeURIComponent(documentId)}`,
    );
  }

  private async sheetName(
    context: AdapterContext,
    documentId: string,
  ): Promise<string> {
    const requested = stringValue(context.canonicalInput, "tableId");
    const metadata = await this.spreadsheet(context, documentId);
    const sheets = records(metadata.sheets);
    if (requested === undefined) {
      const properties = recordValue(sheets[0] ?? {}, "properties") ?? {};
      return requiredString(context, properties, "title");
    }
    const match = sheets.find((value) => {
      const properties = recordValue(value, "properties") ?? {};
      return (
        stringValue(properties, "title") === requested ||
        String(properties.sheetId) === requested
      );
    });
    const properties = recordValue(match ?? {}, "properties") ?? {};
    return requiredString(context, properties, "title");
  }

  private async readRange(
    context: AdapterContext,
    documentId: string,
    range: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    return jsonObject(
      context,
      `v4/spreadsheets/${encodeURIComponent(documentId)}/values/${encodedRange(range)}`,
    );
  }

  private async listRows(
    context: AdapterContext,
    search: boolean,
  ): Promise<JsonValue> {
    const input = context.canonicalInput;
    const documentId = inputString(context, "documentId");
    const name = await this.sheetName(context, documentId);
    const result = await this.readRange(context, documentId, sheetRange(name));
    const filter = isRecord(input.filter) ? input.filter : undefined;
    const query = stringValue(input, "query");
    const matching = rowsFromMatrix(name, matrix(result.values)).filter(
      (row) =>
        (!search || filterMatches(row, filter)) &&
        (query === undefined || includesValue(row.values, query)),
    );
    const selected = page(
      matching,
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      rows: selected.values,
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async appendRows(context: AdapterContext): Promise<JsonValue> {
    const documentId = inputString(context, "documentId");
    const result = await jsonObject(
      context,
      `v4/spreadsheets/${encodeURIComponent(documentId)}/values/${encodedRange(inputString(context, "range"))}/append`,
      jsonRequest({ values: inputArray(context, "values") }),
    );
    const updates = recordValue(result, "updates") ?? {};
    return asJson({
      documentId,
      updatedRange: requiredString(context, updates, "updatedRange"),
      updatedRows: numberValue(updates, "updatedRows") ?? 0,
      updatedCells: numberValue(updates, "updatedCells") ?? 0,
    });
  }

  private async getRange(context: AdapterContext): Promise<JsonValue> {
    const documentId = inputString(context, "documentId");
    const result = await this.readRange(
      context,
      documentId,
      inputString(context, "range"),
    );
    return asJson({
      range: requiredString(context, result, "range"),
      values: matrix(result.values),
    });
  }

  private async updateRange(context: AdapterContext): Promise<JsonValue> {
    const documentId = inputString(context, "documentId");
    const result = await jsonObject(
      context,
      `v4/spreadsheets/${encodeURIComponent(documentId)}/values/${encodedRange(inputString(context, "range"))}`,
      jsonRequest({ values: inputArray(context, "values") }, "PUT"),
    );
    return asJson({
      documentId,
      updatedRange: requiredString(context, result, "updatedRange"),
      updatedRows: numberValue(result, "updatedRows") ?? 0,
      updatedCells: numberValue(result, "updatedCells") ?? 0,
    });
  }

  private async listTables(context: AdapterContext): Promise<JsonValue> {
    const documentId = inputString(context, "documentId");
    const result = await this.spreadsheet(context, documentId);
    const selected = page(
      records(result.sheets),
      parseOffsetToken(
        context,
        stringValue(context.canonicalInput, "pageToken"),
      ),
      numberValue(context.canonicalInput, "pageSize") ?? 50,
    );
    return asJson({
      tables: selected.values.map((value) => table(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }
}

export const googleSheetsAdapter = new GoogleSheetsAdapter();
