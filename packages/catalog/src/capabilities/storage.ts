import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "file_storage_docs" as const;
const VERSION = "1.0.0" as const;
const STAGED_UPLOAD_VERSION = "1.1.0" as const;
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

const id = (description: string): JSONSchema202012 => ({
  type: "string",
  description,
  minLength: 1,
});
const timestamp = (description: string): JSONSchema202012 => ({
  type: "string",
  format: "date-time",
  description,
});
const fileSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "Normalized file or folder metadata.",
  additionalProperties: false,
  required: [
    "fileId",
    "name",
    "mimeType",
    "isFolder",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    fileId: id("Provider identifier of the file or folder."),
    name: id("File or folder name."),
    mimeType: id("Provider MIME type."),
    isFolder: {
      type: "boolean",
      description: "Whether this item is a folder.",
    },
    parentIds: {
      type: "array",
      description: "Parent folder identifiers.",
      items: { type: "string" },
    },
    sizeBytes: {
      type: "integer",
      minimum: 0,
      description: "Content size in bytes when exposed.",
    },
    webUrl: {
      type: "string",
      format: "uri",
      description: "Provider web URL for the item.",
    },
    createdAt: timestamp("Creation timestamp."),
    updatedAt: timestamp("Most recent update timestamp."),
  },
});

const listFiles = defineContract({
  capability: CAPABILITY,
  name: "list_files",
  description:
    "List files and folders within a parent location, excluding trashed items by default.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_files",
    direction: "input",
    description: "Folder and pagination selectors.",
    properties: {
      parentId: id("Parent folder identifier; omit for the provider root."),
      pageSize: pageSizeProperty("files"),
      pageToken: pageTokenProperty("file"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_files",
    direction: "output",
    description: "One page of files and folders.",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        description: "Files and folders in the location.",
        items: fileSchema(),
      },
      nextPageToken: nextPageTokenProperty("files"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getFile = defineContract({
  capability: CAPABILITY,
  name: "get_file",
  description: "Retrieve metadata for one file or folder.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_file",
    direction: "input",
    description: "File identifier.",
    required: ["fileId"],
    properties: { fileId: id("Provider identifier of the file or folder.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_file",
    direction: "output",
    description: "Requested file metadata.",
    required: ["file"],
    properties: { file: fileSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const searchFiles = defineContract({
  capability: CAPABILITY,
  name: "search_files",
  description:
    "Search provider-indexed file names or metadata and return matching files and folders.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_files",
    direction: "input",
    description: "File query and optional parent scope.",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Free-text file search query.",
        minLength: 1,
      },
      parentId: id("Parent folder scope when supported."),
      mimeType: id("Exact MIME type filter."),
      pageSize: pageSizeProperty("matching files"),
      pageToken: pageTokenProperty("matching file"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_files",
    direction: "output",
    description: "One page of matching files.",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        description: "Matching files and folders.",
        items: fileSchema(),
      },
      nextPageToken: nextPageTokenProperty("matching files"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const uploadFile = defineContract({
  capability: CAPABILITY,
  name: "upload_file",
  description:
    "Upload a new file from inline content or a staged Eyeball file. This creates externally visible stored data.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "upload_file",
      direction: "input",
      version: STAGED_UPLOAD_VERSION,
      description:
        "File metadata and exactly one inline or staged content source.",
      properties: {
        name: id("File name."),
        mimeType: {
          type: "string",
          description:
            "Content MIME type; staged uploads default to staged metadata and inline uploads default to application/octet-stream.",
          minLength: 1,
        },
        content: {
          type: "string",
          description: "File content using the selected encoding.",
        },
        contentEncoding: {
          type: "string",
          description: "Serialization used for inline content.",
          enum: ["utf8", "base64"],
          default: "utf8",
        },
        fileId: {
          type: "string",
          description: "Eyeball file_* identifier returned by POST /v1/files.",
          pattern: "^file_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
        },
        parentId: id("Parent folder identifier."),
        description: {
          type: "string",
          description: "Optional file description.",
        },
      },
    }),
    oneOf: [
      {
        description: "Use inline content.",
        required: ["name", "content"],
        properties: { name: true, content: true, fileId: false },
      },
      {
        description: "Use content from a staged Eyeball file.",
        required: ["fileId"],
        properties: { content: false, fileId: true },
      },
    ],
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "upload_file",
    direction: "output",
    version: STAGED_UPLOAD_VERSION,
    description: "Newly uploaded file metadata.",
    required: ["file"],
    properties: { file: fileSchema() },
  }),
  annotations: CREATE,
  version: STAGED_UPLOAD_VERSION,
});

const downloadFile = defineContract({
  capability: CAPABILITY,
  name: "download_file",
  description:
    "Download file content through the executor's encoded binary transport.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "download_file",
    direction: "input",
    description: "File identifier and desired encoding.",
    required: ["fileId"],
    properties: {
      fileId: id("Provider identifier of the file."),
      contentEncoding: {
        type: "string",
        description: "Encoding for returned content.",
        enum: ["utf8", "base64"],
        default: "base64",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "download_file",
    direction: "output",
    description: "Encoded file content and MIME type.",
    required: ["fileId", "mimeType", "content", "contentEncoding"],
    properties: {
      fileId: id("Provider identifier of the file."),
      mimeType: id("Content MIME type."),
      content: { type: "string", description: "Encoded file content." },
      contentEncoding: {
        type: "string",
        enum: ["utf8", "base64"],
        description: "Encoding used for content.",
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const moveFile = defineContract({
  capability: CAPABILITY,
  name: "move_file",
  description:
    "Move a file to a new parent, rename it, or do both. Repeating the same target has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "move_file",
      direction: "input",
      description: "File and new location or name.",
      required: ["fileId"],
      properties: {
        fileId: id("Provider identifier of the file."),
        parentId: id("New parent folder identifier."),
        name: id("New file name."),
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "move_file",
    direction: "output",
    description: "Updated file metadata.",
    required: ["file"],
    properties: { file: fileSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const deleteFile = defineContract({
  capability: CAPABILITY,
  name: "delete_file",
  description:
    "Delete or trash one file or folder. This is destructive and can remove stored content and permissions.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_file",
    direction: "input",
    description: "File identifier.",
    required: ["fileId"],
    properties: { fileId: id("Provider identifier of the file or folder.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "delete_file",
    direction: "output",
    description: "Deletion acknowledgement.",
    required: ["fileId", "deleted"],
    properties: {
      fileId: id("Provider identifier of the deleted item."),
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

const createFolder = defineContract({
  capability: CAPABILITY,
  name: "create_folder",
  description:
    "Create a folder in the provider root or below a selected parent.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_folder",
    direction: "input",
    description: "Folder name and parent.",
    required: ["name"],
    properties: {
      name: id("Folder name."),
      parentId: id("Parent folder identifier."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_folder",
    direction: "output",
    description: "Newly created folder metadata.",
    required: ["folder"],
    properties: { folder: fileSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const shareFile = defineContract({
  capability: CAPABILITY,
  name: "share_file",
  description:
    "Create a file permission for a user, group, domain, or anyone. This changes external access to stored content.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "share_file",
    direction: "input",
    description: "File and permission grant.",
    required: ["fileId", "type", "role"],
    properties: {
      fileId: id("Provider identifier of the file."),
      type: {
        type: "string",
        enum: ["user", "group", "domain", "anyone"],
        description: "Permission principal type.",
      },
      role: {
        type: "string",
        enum: [
          "owner",
          "organizer",
          "fileOrganizer",
          "writer",
          "commenter",
          "reader",
        ],
        description: "Granted access role.",
      },
      email: {
        type: "string",
        format: "email",
        description: "User or group email address.",
      },
      domain: id("Domain receiving access."),
      discoverable: {
        type: "boolean",
        description: "Whether link discovery is allowed.",
        default: false,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "share_file",
    direction: "output",
    description: "Created permission metadata.",
    required: ["permissionId", "fileId", "type", "role"],
    properties: {
      permissionId: id("Provider identifier of the permission."),
      fileId: id("Provider identifier of the file."),
      type: {
        type: "string",
        enum: ["user", "group", "domain", "anyone"],
        description: "Permission principal type.",
      },
      role: {
        type: "string",
        enum: [
          "owner",
          "organizer",
          "fileOrganizer",
          "writer",
          "commenter",
          "reader",
        ],
        description: "Granted access role.",
      },
      email: {
        type: "string",
        format: "email",
        description: "User or group email address.",
      },
      domain: id("Granted domain."),
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const exportDocument = defineContract({
  capability: CAPABILITY,
  name: "export_document",
  description:
    "Export a provider-native document to a requested MIME type and return encoded content.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "export_document",
    direction: "input",
    description: "Native document and target format.",
    required: ["fileId", "mimeType"],
    properties: {
      fileId: id("Provider identifier of the native document."),
      mimeType: id("Target export MIME type."),
      contentEncoding: {
        type: "string",
        enum: ["utf8", "base64"],
        default: "base64",
        description: "Encoding for returned content.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "export_document",
    direction: "output",
    description: "Encoded exported content.",
    required: ["fileId", "mimeType", "content", "contentEncoding"],
    properties: {
      fileId: id("Provider identifier of the source document."),
      mimeType: id("Export MIME type."),
      content: { type: "string", description: "Encoded exported content." },
      contentEncoding: {
        type: "string",
        enum: ["utf8", "base64"],
        description: "Encoding used for content.",
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const storageCapabilityContracts = deepFreeze([
  listFiles,
  getFile,
  searchFiles,
  uploadFile,
  downloadFile,
  moveFile,
  deleteFile,
  createFolder,
  shareFile,
  exportDocument,
] as const satisfies readonly CapabilityToolContract[]);

type StorageContract = (typeof storageCapabilityContracts)[number];
type StorageContractsByName = {
  readonly [Contract in StorageContract as Contract["name"]]: Contract;
};
export const storageContractsByName = deepFreeze(
  Object.fromEntries(
    storageCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as StorageContractsByName,
);
