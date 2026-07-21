import { defaultCatalog } from "@eyeball/catalog";
import { createFileId, type JsonValue } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import { executionAttachmentSummary } from "../src/execution-provenance.js";

function summarize(
  toolName: string,
  input: Readonly<Record<string, JsonValue>>,
) {
  const tool = defaultCatalog.getTool(toolName);
  if (tool === undefined) throw new Error(`Missing test tool ${toolName}.`);
  return executionAttachmentSummary(tool, input);
}

describe("executionAttachmentSummary", () => {
  it("collects preferred and legacy email references once in first-seen order", () => {
    const first = createFileId("email_first");
    const second = createFileId("email_second");
    expect(
      summarize("gmail.send_email", {
        to: ["buyer@example.com"],
        subject: "Files",
        body: "Attached",
        attachments: [
          {
            fileId: first,
            name: "private-name.pdf",
            mimeType: "application/pdf",
          },
          {
            fileId: second,
            fileName: "legacy-private.csv",
            contentType: "text/csv",
          },
          { fileId: first },
        ],
      }),
    ).toEqual({ count: 2, fileIds: [first, second] });
  });

  it("collects messaging attachments and the storage upload staged reference", () => {
    const messageFile = createFileId("message_attachment");
    const uploadFile = createFileId("storage_upload");
    expect(
      summarize("slack.reply_to_message", {
        channelId: "channel_1",
        messageId: "message_1",
        text: "Attached",
        attachments: [{ fileId: messageFile }],
      }),
    ).toEqual({ count: 1, fileIds: [messageFile] });
    expect(
      summarize("google-drive.upload_file", {
        fileId: uploadFile,
        name: "private-name.bin",
        parentId: "provider-folder",
      }),
    ).toEqual({ count: 1, fileIds: [uploadFile] });
  });

  it("ignores invalid lookalikes, missing arrays, and unrelated nested fileId values", () => {
    expect(
      summarize("gmail.create_draft", {
        to: ["buyer@example.com"],
        subject: "No staged files",
        body: "Body",
        attachments: [
          { fileId: "file_" },
          { fileId: "file_not valid" },
          { nested: { fileId: createFileId("hidden_nested") } },
        ],
        metadata: { fileId: createFileId("random_nested") },
      }),
    ).toBeUndefined();
    expect(
      summarize("gmail.reply_to_email", {
        messageId: "provider-message",
        body: "No attachments property",
      }),
    ).toBeUndefined();
  });

  it("never classifies provider resource IDs on non-upload storage operations", () => {
    expect(
      summarize("google-drive.download_file", {
        fileId: createFileId("provider_resource_looks_staged"),
      }),
    ).toBeUndefined();
    expect(
      summarize("google-drive.move_file", {
        fileId: createFileId("provider_move_resource"),
        destinationFolderId: "provider-destination",
      }),
    ).toBeUndefined();
  });

  it("returns IDs and count only, without file metadata, paths, contents, or bytes", () => {
    const fileId = createFileId("privacy_boundary");
    const summary = summarize("gmail.send_email", {
      to: ["buyer@example.com"],
      subject: "Private canonical input",
      body: "Private body",
      attachments: [
        {
          fileId,
          name: "secret.pdf",
          mimeType: "application/pdf",
          size: 123,
          path: "/private/secret.pdf",
          content: "base64-secret",
          bytes: [1, 2, 3],
        },
      ],
    });
    expect(summary).toEqual({ count: 1, fileIds: [fileId] });
    expect(JSON.stringify(summary)).not.toMatch(
      /secret|application\/pdf|private|base64|bytes|content|path|size/u,
    );
  });
});
