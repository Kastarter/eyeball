import { defineCapabilityFixtures } from "../fixtures.js";

function document(provider: string): string {
  switch (provider) {
    case "airtable":
      return "app_fixture_000001";
    case "google-sheets":
      return "sheet_tasks_000001";
    default:
      return "db_tasks_000001";
  }
}

function row(provider: string): string {
  return provider === "airtable" ? "rec_tasks_000001" : "page_tasks_000001";
}

function table(provider: string): string | undefined {
  return provider === "airtable" ? "Tasks" : undefined;
}

function tableInput(provider: string): Readonly<Record<string, string>> {
  const value = table(provider);
  return value === undefined ? {} : { tableId: value };
}

export const spreadsheetsFixtures = defineCapabilityFixtures(
  "spreadsheets_databases",
  {
    append_row: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        range: context.value("RANGE", "Tasks!A:C"),
        values: [["Contract task", "Ready", "Fixture Owner"]],
      }),
    },
    create_row: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        values: { Name: "Contract task", Status: "Ready" },
      }),
    },
    delete_row: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        rowId: context.value("ROW_ID", row(context.provider)),
      }),
    },
    get_range: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        range: context.value("RANGE", "Tasks!A1:C2"),
      }),
    },
    get_row: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        rowId: context.value("ROW_ID", row(context.provider)),
      }),
    },
    list_rows: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        pageSize: 10,
      }),
    },
    list_tables: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        pageSize: 10,
      }),
    },
    run_query: { input: { query: "select 1" } },
    search_rows: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        query: "fixture",
        pageSize: 10,
      }),
    },
    update_range: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        range: context.value("UPDATE_RANGE", "Tasks!B2:B2"),
        values: [["Done"]],
      }),
    },
    update_row: {
      input: (context) => ({
        documentId: context.value("DOCUMENT_ID", document(context.provider)),
        ...tableInput(context.provider),
        rowId: context.value("ROW_ID", row(context.provider)),
        values: { Status: "Ready" },
      }),
    },
  },
);
