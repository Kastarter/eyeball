import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  includesValue,
  inputRecord,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  queryPath,
  records,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

function record(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    rowId: requiredId(context, value.id, "record"),
    values: isRecord(value.fields) ? value.fields : {},
    createdAt: requiredString(context, value, "createdTime"),
  };
}

function tablePath(context: AdapterContext): string {
  return `v0/${encodeURIComponent(inputString(context, "documentId"))}/${encodeURIComponent(inputString(context, "tableId"))}`;
}

function formula(input: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(input.filter)) return undefined;
  const entry = Object.entries(input.filter)[0];
  if (entry === undefined) return undefined;
  const [field, expected] = entry;
  const serialized =
    typeof expected === "string"
      ? JSON.stringify(expected)
      : JSON.stringify(String(expected));
  return `{${field}}=${serialized}`;
}

export class AirtableAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "airtable";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "airtable.list_rows":
        return this.listRows(context, false);
      case "airtable.search_rows":
        return this.listRows(context, true);
      case "airtable.get_row":
        return this.getRow(context);
      case "airtable.create_row":
        return this.createRow(context);
      case "airtable.update_row":
        return this.updateRow(context);
      case "airtable.delete_row":
        return this.deleteRow(context);
      default:
        return unsupported(context);
    }
  }

  private async listRows(
    context: AdapterContext,
    search: boolean,
  ): Promise<JsonValue> {
    const input = context.canonicalInput;
    const result = await jsonObject(
      context,
      queryPath(tablePath(context), {
        pageSize: numberValue(input, "pageSize") ?? 50,
        offset: stringValue(input, "pageToken"),
        filterByFormula: search ? formula(input) : undefined,
      }),
    );
    const query = search ? stringValue(input, "query") : undefined;
    return asJson({
      rows: records(result.records)
        .map((value) => record(context, value))
        .filter(
          (value) => query === undefined || includesValue(value.values, query),
        ),
      ...(stringValue(result, "offset") === undefined
        ? {}
        : { nextPageToken: stringValue(result, "offset") }),
    });
  }

  private async getRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `${tablePath(context)}/${encodeURIComponent(inputString(context, "rowId"))}`,
    );
    return asJson({ row: record(context, result) });
  }

  private async createRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      tablePath(context),
      jsonRequest({ fields: inputRecord(context, "values") }),
    );
    return asJson({ row: record(context, result) });
  }

  private async updateRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `${tablePath(context)}/${encodeURIComponent(inputString(context, "rowId"))}`,
      jsonRequest({ fields: inputRecord(context, "values") }, "PATCH"),
    );
    return asJson({ row: record(context, result) });
  }

  private async deleteRow(context: AdapterContext): Promise<JsonValue> {
    const rowId = inputString(context, "rowId");
    const result = await jsonObject(
      context,
      `${tablePath(context)}/${encodeURIComponent(rowId)}`,
      { method: "DELETE" },
    );
    return asJson({
      rowId: requiredId(context, result.id, "record"),
      deleted: result.deleted === true,
    });
  }
}

export const airtableAdapter = new AirtableAdapter();
