import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  booleanValue,
  inputString,
  jsonObject,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  queryPath,
  records,
  requiredId,
  requiredString,
  responseText,
  responseVoid,
  stringArray,
  stringValue,
  unsupported,
} from "./common.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function file(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const size = stringValue(value, "size");
  const parsedSize = size === undefined ? undefined : Number(size);
  return {
    fileId: requiredId(context, value.id, "file"),
    name: requiredString(context, value, "name"),
    mimeType: requiredString(context, value, "mimeType"),
    isFolder: value.mimeType === FOLDER_MIME_TYPE,
    parentIds: stringArray(value.parents),
    ...(parsedSize === undefined || !Number.isSafeInteger(parsedSize)
      ? {}
      : { sizeBytes: parsedSize }),
    ...(stringValue(value, "webViewLink") === undefined
      ? {}
      : { webUrl: stringValue(value, "webViewLink") }),
    createdAt: requiredString(context, value, "createdTime"),
    updatedAt: requiredString(context, value, "modifiedTime"),
  };
}

function encodedContent(content: string, encoding: string): string {
  return encoding === "base64"
    ? Buffer.from(content, "utf8").toString("base64")
    : content;
}

function decodedContent(content: string, encoding: string): string {
  return encoding === "base64"
    ? Buffer.from(content, "base64").toString("utf8")
    : content;
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export class GoogleDriveAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "google-drive";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "google-drive.list_files":
        return this.listFiles(context);
      case "google-drive.get_file":
        return this.getFile(context);
      case "google-drive.search_files":
        return this.searchFiles(context);
      case "google-drive.upload_file":
        return this.uploadFile(context, false);
      case "google-drive.download_file":
        return this.downloadFile(context);
      case "google-drive.move_file":
        return this.moveFile(context);
      case "google-drive.delete_file":
        return this.deleteFile(context);
      case "google-drive.create_folder":
        return this.uploadFile(context, true);
      case "google-drive.share_file":
        return this.shareFile(context);
      case "google-drive.export_document":
        return this.exportDocument(context);
      default:
        return unsupported(context);
    }
  }

  private async fileList(
    context: AdapterContext,
    query: string,
  ): Promise<Readonly<Record<string, unknown>>[]> {
    const body = await jsonObject(
      context,
      queryPath("drive/v3/files", { q: query }),
    );
    return records(body.files);
  }

  private pagedFiles(
    context: AdapterContext,
    values: readonly Readonly<Record<string, unknown>>[],
  ): JsonValue {
    const input = context.canonicalInput;
    const selected = page(
      values,
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      files: selected.values.map((value) => file(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async listFiles(context: AdapterContext): Promise<JsonValue> {
    const parentId = stringValue(context.canonicalInput, "parentId");
    const values = await this.fileList(context, "trashed = false");
    return this.pagedFiles(
      context,
      values.filter((value) => {
        const parents = stringArray(value.parents);
        return parentId === undefined
          ? parents.length === 0
          : parents.includes(parentId);
      }),
    );
  }

  private async getFile(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `drive/v3/files/${encodeURIComponent(inputString(context, "fileId"))}`,
    );
    return asJson({ file: file(context, result) });
  }

  private async searchFiles(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const query = inputString(context, "query");
    const mimeType = stringValue(input, "mimeType");
    const predicates = [
      `name contains '${escapeDriveQuery(query)}'`,
      ...(mimeType === undefined
        ? []
        : [`mimeType = '${escapeDriveQuery(mimeType)}'`]),
      "trashed = false",
    ];
    const parentId = stringValue(input, "parentId");
    const values = await this.fileList(context, predicates.join(" and "));
    return this.pagedFiles(
      context,
      parentId === undefined
        ? values
        : values.filter((value) =>
            stringArray(value.parents).includes(parentId),
          ),
    );
  }

  private async uploadFile(
    context: AdapterContext,
    folder: boolean,
  ): Promise<JsonValue> {
    const input = context.canonicalInput;
    const parentId = stringValue(input, "parentId");
    const content = folder
      ? ""
      : decodedContent(
          inputString(context, "content"),
          stringValue(input, "contentEncoding") ?? "utf8",
        );
    const body = await jsonObject(
      context,
      "drive/v3/files",
      jsonRequest({
        metadata: {
          name: inputString(context, "name"),
          mimeType: folder
            ? FOLDER_MIME_TYPE
            : (stringValue(input, "mimeType") ?? "application/octet-stream"),
          ...(parentId === undefined ? {} : { parents: [parentId] }),
          ...(stringValue(input, "description") === undefined
            ? {}
            : { description: stringValue(input, "description") }),
        },
        content,
      }),
    );
    return asJson(
      folder ? { folder: file(context, body) } : { file: file(context, body) },
    );
  }

  private async downloadFile(context: AdapterContext): Promise<JsonValue> {
    const fileId = inputString(context, "fileId");
    const encoding =
      stringValue(context.canonicalInput, "contentEncoding") ?? "base64";
    const response = await responseText(
      context,
      queryPath(`drive/v3/files/${encodeURIComponent(fileId)}`, {
        alt: "media",
      }),
    );
    return asJson({
      fileId,
      mimeType:
        response.contentType?.split(";", 1)[0] ?? "application/octet-stream",
      content: encodedContent(response.content, encoding),
      contentEncoding: encoding,
    });
  }

  private async moveFile(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const fileId = inputString(context, "fileId");
    const current = await jsonObject(
      context,
      `drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    const parentId = stringValue(input, "parentId");
    const currentParents = stringArray(current.parents);
    const result = await jsonObject(
      context,
      queryPath(`drive/v3/files/${encodeURIComponent(fileId)}`, {
        addParents: parentId,
        removeParents:
          parentId === undefined || currentParents.length === 0
            ? undefined
            : currentParents.join(","),
      }),
      jsonRequest(
        stringValue(input, "name") === undefined ? {} : { name: input.name },
        "PATCH",
      ),
    );
    return asJson({ file: file(context, result) });
  }

  private async deleteFile(context: AdapterContext): Promise<JsonValue> {
    const fileId = inputString(context, "fileId");
    await responseVoid(
      context,
      `drive/v3/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
    );
    return asJson({ fileId, deleted: true });
  }

  private async shareFile(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const fileId = inputString(context, "fileId");
    const result = await jsonObject(
      context,
      `drive/v3/files/${encodeURIComponent(fileId)}/permissions`,
      jsonRequest({
        type: inputString(context, "type"),
        role: inputString(context, "role"),
        ...(stringValue(input, "email") === undefined
          ? {}
          : { emailAddress: input.email }),
        ...(stringValue(input, "domain") === undefined
          ? {}
          : { domain: input.domain }),
        allowFileDiscovery: booleanValue(input, "discoverable") ?? false,
      }),
    );
    return asJson({
      permissionId: requiredId(context, result.id, "permission"),
      fileId,
      type: requiredString(context, result, "type"),
      role: requiredString(context, result, "role"),
      ...(stringValue(result, "emailAddress") === undefined
        ? {}
        : { email: stringValue(result, "emailAddress") }),
      ...(stringValue(result, "domain") === undefined
        ? {}
        : { domain: stringValue(result, "domain") }),
    });
  }

  private async exportDocument(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const fileId = inputString(context, "fileId");
    const mimeType = inputString(context, "mimeType");
    const encoding = stringValue(input, "contentEncoding") ?? "base64";
    const response = await responseText(
      context,
      queryPath(`drive/v3/files/${encodeURIComponent(fileId)}/export`, {
        mimeType,
      }),
    );
    return asJson({
      fileId,
      mimeType,
      content: encodedContent(response.content, encoding),
      contentEncoding: encoding,
    });
  }
}

export const googleDriveAdapter = new GoogleDriveAdapter();
