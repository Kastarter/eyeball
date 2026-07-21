import {
  type ExecutionAttachmentSummary,
  type FileId,
  isFileId,
  type JsonValue,
  type ToolDefinition,
} from "@eyeball/core";

const ATTACHMENT_ARRAY_OPERATIONS = new Set([
  "send_email",
  "reply_to_email",
  "create_draft",
  "send_message",
  "reply_to_message",
]);

function canonicalOperation(tool: ToolDefinition): string {
  const separator = tool.name.indexOf(".");
  return separator === -1 ? tool.name : tool.name.slice(separator + 1);
}

function fileIdFromReference(value: JsonValue): FileId | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const fileId = (value as Readonly<Record<string, JsonValue>>).fileId;
  return typeof fileId === "string" && isFileId(fileId) ? fileId : undefined;
}

/**
 * Derives the bounded staged-file summary from schema-known canonical input
 * positions. Provider resource IDs and unrelated nested `fileId` properties
 * are intentionally ignored.
 */
export function executionAttachmentSummary(
  tool: ToolDefinition,
  input: Readonly<Record<string, JsonValue>>,
): ExecutionAttachmentSummary | undefined {
  const operation = canonicalOperation(tool);
  const candidates: FileId[] = [];

  if (
    ((tool.capability === "email" &&
      ATTACHMENT_ARRAY_OPERATIONS.has(operation)) ||
      (tool.capability === "messaging_chat" &&
        ATTACHMENT_ARRAY_OPERATIONS.has(operation))) &&
    Array.isArray(input.attachments)
  ) {
    for (const reference of input.attachments) {
      const fileId = fileIdFromReference(reference);
      if (fileId !== undefined) candidates.push(fileId);
    }
  } else if (
    tool.capability === "file_storage_docs" &&
    operation === "upload_file"
  ) {
    const fileId =
      typeof input.fileId === "string" && isFileId(input.fileId)
        ? input.fileId
        : undefined;
    if (fileId !== undefined) candidates.push(fileId);
  }

  const fileIds = [...new Set(candidates)];
  return fileIds.length === 0 ? undefined : { count: fileIds.length, fileIds };
}
