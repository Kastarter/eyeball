import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "spreadsheets_databases" as const;
const VERSION = "1.0.0" as const;

const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const CREATE = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
} as const;
const UPDATE = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const DELETE = {
  readOnly: false,
  destructive: true,
  idempotent: true,
  async: false,
} as const;

const identifier = (description: string): JSONSchema202012 => ({
  type: "string",
  description,
  minLength: 1,
});

const valuesSchema = (description: string): JSONSchema202012 => ({
  type: "object",
  description,
  additionalProperties: true,
});

const matrixSchema = (description: string): JSONSchema202012 => ({
  type: "array",
  description,
  items: {
    type: "array",
    items: {
      type: ["null", "boolean", "number", "string"],
    },
  },
});

const rowSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized row or database record.",
  additionalProperties: false,
  required: ["rowId", "values"],
  properties: {
    rowId: identifier("Provider identifier of the row or record."),
    values: valuesSchema("Field names and values stored on the row."),
    createdAt: {
      type: "string",
      format: "date-time",
      description: "Creation timestamp when the provider exposes it.",
    },
    updatedAt: {
      type: "string",
      format: "date-time",
      description: "Most recent update timestamp when exposed.",
    },
  },
});

const documentId = identifier(
  "Provider identifier of the database, base, workbook, or equivalent document.",
);
const tableId = identifier(
  "Table, worksheet, collection, or view identifier when the provider requires one.",
);

const listRows = defineContract({
  capability: CAPABILITY,
  name: "list_rows",
  description:
    "List rows or records from a database table, worksheet, or view. Use search_rows when a provider-side filter is required.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_rows",
    direction: "input",
    description: "Row container and pagination selectors.",
    required: ["documentId"],
    properties: {
      documentId,
      tableId,
      pageSize: pageSizeProperty("rows"),
      pageToken: pageTokenProperty("row"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_rows",
    direction: "output",
    description: "One page of normalized rows.",
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        description: "Rows in this page.",
        items: rowSchema(),
      },
      nextPageToken: nextPageTokenProperty("rows"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createRow = defineContract({
  capability: CAPABILITY,
  name: "create_row",
  description:
    "Create one row or record with named field values. This adds externally visible data to the selected table or database.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_row",
    direction: "input",
    description: "Target container and values for the new row.",
    required: ["documentId", "values"],
    properties: {
      documentId,
      tableId,
      values: valuesSchema("Values for the new row."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_row",
    direction: "output",
    description: "The newly created row.",
    required: ["row"],
    properties: { row: rowSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getRow = defineContract({
  capability: CAPABILITY,
  name: "get_row",
  description: "Retrieve one row or record by its provider identifier.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_row",
    direction: "input",
    description: "Target container and row identifier.",
    required: ["documentId", "rowId"],
    properties: {
      documentId,
      tableId,
      rowId: identifier("Provider identifier of the row or record."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_row",
    direction: "output",
    description: "The requested row.",
    required: ["row"],
    properties: { row: rowSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateRow = defineContract({
  capability: CAPABILITY,
  name: "update_row",
  description:
    "Update named values on an existing row or record. Repeating the same values has no additional effect.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_row",
    direction: "input",
    description: "Target row and replacement field values.",
    required: ["documentId", "rowId", "values"],
    properties: {
      documentId,
      tableId,
      rowId: identifier("Provider identifier of the row or record."),
      values: valuesSchema("Fields to merge into the existing row."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_row",
    direction: "output",
    description: "The updated row.",
    required: ["row"],
    properties: { row: rowSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const deleteRow = defineContract({
  capability: CAPABILITY,
  name: "delete_row",
  description:
    "Delete or archive one row or record. This is destructive and may remove externally visible data.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_row",
    direction: "input",
    description: "Target container and row identifier.",
    required: ["documentId", "rowId"],
    properties: {
      documentId,
      tableId,
      rowId: identifier("Provider identifier of the row or record."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_row",
    direction: "output",
    description: "Deletion acknowledgement.",
    required: ["rowId", "deleted"],
    properties: {
      rowId: identifier("Provider identifier of the deleted row."),
      deleted: {
        type: "boolean",
        const: true,
        description: "Whether deletion completed.",
      },
    },
  }),
  annotations: DELETE,
  version: VERSION,
});

const searchRows = defineContract({
  capability: CAPABILITY,
  name: "search_rows",
  description:
    "Filter rows using a provider-supported structured expression or free-text query and return normalized records.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_rows",
    direction: "input",
    description: "Target container, filter, and pagination selectors.",
    required: ["documentId"],
    properties: {
      documentId,
      tableId,
      query: {
        type: "string",
        description: "Free-text row search query.",
        minLength: 1,
      },
      filter: {
        type: "object",
        description: "Provider-supported structured filter expression.",
        additionalProperties: true,
      },
      pageSize: pageSizeProperty("matching rows"),
      pageToken: pageTokenProperty("matching row"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_rows",
    direction: "output",
    description: "One page of rows matching the query.",
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        description: "Matching rows.",
        items: rowSchema(),
      },
      nextPageToken: nextPageTokenProperty("matching rows"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const appendRow = defineContract({
  capability: CAPABILITY,
  name: "append_row",
  description:
    "Append one or more ordered value rows at the end of a worksheet range. This adds externally visible spreadsheet data.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "append_row",
    direction: "input",
    description: "Spreadsheet, A1-style range, and rows to append.",
    required: ["documentId", "range", "values"],
    properties: {
      documentId,
      range: identifier("Worksheet range used to locate the append table."),
      values: matrixSchema("Rows of cell values to append."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "append_row",
    direction: "output",
    description: "Range and counts written by the append.",
    required: ["documentId", "updatedRange", "updatedRows", "updatedCells"],
    properties: {
      documentId,
      updatedRange: identifier("Range containing the appended values."),
      updatedRows: {
        type: "integer",
        minimum: 0,
        description: "Rows appended.",
      },
      updatedCells: {
        type: "integer",
        minimum: 0,
        description: "Cells appended.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getRange = defineContract({
  capability: CAPABILITY,
  name: "get_range",
  description:
    "Read values from a rectangular spreadsheet range in row-major order.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_range",
    direction: "input",
    description: "Spreadsheet and A1-style range to read.",
    required: ["documentId", "range"],
    properties: {
      documentId,
      range: identifier("A1-style spreadsheet range."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_range",
    direction: "output",
    description: "Normalized range and cell values.",
    required: ["range", "values"],
    properties: {
      range: identifier("Normalized range returned by the provider."),
      values: matrixSchema("Cell values in row-major order."),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateRange = defineContract({
  capability: CAPABILITY,
  name: "update_range",
  description:
    "Write row-major values to a rectangular spreadsheet range. Existing cells in the written area are overwritten.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_range",
    direction: "input",
    description: "Spreadsheet range and replacement cell values.",
    required: ["documentId", "range", "values"],
    properties: {
      documentId,
      range: identifier("A1-style spreadsheet range."),
      values: matrixSchema("Cell values in row-major order."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_range",
    direction: "output",
    description: "Range and counts written by the update.",
    required: ["documentId", "updatedRange", "updatedRows", "updatedCells"],
    properties: {
      documentId,
      updatedRange: identifier("Range containing the written values."),
      updatedRows: {
        type: "integer",
        minimum: 0,
        description: "Rows updated.",
      },
      updatedCells: {
        type: "integer",
        minimum: 0,
        description: "Cells updated.",
      },
    },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const listTables = defineContract({
  capability: CAPABILITY,
  name: "list_tables",
  description:
    "List worksheets, tables, collections, or database views in a spreadsheet or database document.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_tables",
    direction: "input",
    description: "Document and pagination selectors.",
    required: ["documentId"],
    properties: {
      documentId,
      pageSize: pageSizeProperty("tables"),
      pageToken: pageTokenProperty("table"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_tables",
    direction: "output",
    description: "One page of tables, worksheets, collections, or views.",
    required: ["tables"],
    properties: {
      tables: {
        type: "array",
        description: "Tables available in the selected document.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tableId", "name"],
          properties: {
            tableId: identifier(
              "Provider identifier of the table or worksheet.",
            ),
            name: identifier("Table or worksheet display name."),
            index: {
              type: "integer",
              minimum: 0,
              description: "Zero-based display position when exposed.",
            },
            rowCount: {
              type: "integer",
              minimum: 0,
              description: "Configured or observed row count.",
            },
            columnCount: {
              type: "integer",
              minimum: 0,
              description: "Configured or observed column count.",
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("tables"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const runQuery = defineContract({
  capability: CAPABILITY,
  name: "run_query",
  description:
    "Execute a provider-supported read-only query-language statement and return tabular results. Do not use this for row filtering when search_rows is available.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "run_query",
    direction: "input",
    description: "Data source, read-only statement, and bound parameters.",
    required: ["query"],
    properties: {
      documentId,
      query: {
        type: "string",
        description: "Read-only query statement.",
        minLength: 1,
      },
      parameters: {
        type: "array",
        description: "Ordered query parameters.",
        items: { type: ["null", "boolean", "number", "string"] },
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "run_query",
    direction: "output",
    description: "Columns and row values returned by the query.",
    required: ["columns", "rows"],
    properties: {
      columns: {
        type: "array",
        description: "Column names.",
        items: { type: "string" },
      },
      rows: {
        type: "array",
        description: "Tabular result rows.",
        items: valuesSchema("One query result row."),
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const spreadsheetsCapabilityContracts = deepFreeze([
  listRows,
  createRow,
  getRow,
  updateRow,
  deleteRow,
  searchRows,
  appendRow,
  getRange,
  updateRange,
  listTables,
  runQuery,
] as const satisfies readonly CapabilityToolContract[]);

type SpreadsheetContract = (typeof spreadsheetsCapabilityContracts)[number];
type SpreadsheetContractsByName = {
  readonly [Contract in SpreadsheetContract as Contract["name"]]: Contract;
};

export const spreadsheetsContractsByName = deepFreeze(
  Object.fromEntries(
    spreadsheetsCapabilityContracts.map((contract) => [
      contract.name,
      contract,
    ]),
  ) as SpreadsheetContractsByName,
);
