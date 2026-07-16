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
  page,
  parseOffsetToken,
  records,
  requiredId,
  stringValue,
  unsupported,
} from "./common.js";

function row(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    rowId: requiredId(context, value.id, "page"),
    values: isRecord(value.properties) ? value.properties : {},
    ...(stringValue(value, "created_time") === undefined
      ? {}
      : { createdAt: stringValue(value, "created_time") }),
    ...(stringValue(value, "last_edited_time") === undefined
      ? {}
      : { updatedAt: stringValue(value, "last_edited_time") }),
  };
}

function databaseName(value: Readonly<Record<string, unknown>>): string {
  const title = Array.isArray(value.title) ? value.title : [];
  return (
    title
      .filter(isRecord)
      .map((part) => stringValue(part, "plain_text") ?? "")
      .join("") || "Untitled"
  );
}

function notionFilter(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value.property === "string") return value;
  const entry = Object.entries(value)[0];
  return entry === undefined
    ? undefined
    : { property: entry[0], rich_text: { equals: entry[1] } };
}

export class NotionAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "notion";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "notion.list_rows":
        return this.listRows(context, false);
      case "notion.search_rows":
        return this.listRows(context, true);
      case "notion.get_row":
        return this.getRow(context);
      case "notion.create_row":
        return this.createRow(context);
      case "notion.update_row":
        return this.updateRow(context);
      case "notion.delete_row":
        return this.deleteRow(context);
      case "notion.list_tables":
        return this.listTables(context);
      default:
        return unsupported(context);
    }
  }

  private async listRows(
    context: AdapterContext,
    search: boolean,
  ): Promise<JsonValue> {
    const input = context.canonicalInput;
    const documentId = inputString(context, "documentId");
    const filter =
      search && isRecord(input.filter) ? notionFilter(input.filter) : undefined;
    const result = await jsonObject(
      context,
      `v1/databases/${encodeURIComponent(documentId)}/query`,
      jsonRequest(filter === undefined ? {} : { filter }),
    );
    const query = search ? stringValue(input, "query") : undefined;
    const matching = records(result.results)
      .map((value) => row(context, value))
      .filter(
        (value) => query === undefined || includesValue(value.values, query),
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

  private async getRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `v1/pages/${encodeURIComponent(inputString(context, "rowId"))}`,
    );
    return asJson({ row: row(context, result) });
  }

  private async createRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      "v1/pages",
      jsonRequest({
        parent: {
          type: "database_id",
          database_id: inputString(context, "documentId"),
        },
        properties: inputRecord(context, "values"),
      }),
    );
    return asJson({ row: row(context, result) });
  }

  private async updateRow(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `v1/pages/${encodeURIComponent(inputString(context, "rowId"))}`,
      jsonRequest({ properties: inputRecord(context, "values") }, "PATCH"),
    );
    return asJson({ row: row(context, result) });
  }

  private async deleteRow(context: AdapterContext): Promise<JsonValue> {
    const rowId = inputString(context, "rowId");
    await jsonObject(
      context,
      `v1/pages/${encodeURIComponent(rowId)}`,
      jsonRequest({ archived: true }, "PATCH"),
    );
    return asJson({ rowId, deleted: true });
  }

  private async listTables(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const result = await jsonObject(
      context,
      "v1/search",
      jsonRequest({ filter: { property: "object", value: "database" } }),
    );
    const selected = page(
      records(result.results),
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      tables: selected.values.map((value) => ({
        tableId: requiredId(context, value.id, "database"),
        name: databaseName(value),
      })),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }
}

export const notionAdapter = new NotionAdapter();
