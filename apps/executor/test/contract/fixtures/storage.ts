import { defineCapabilityFixtures } from "../fixtures.js";

export const storageFixtures = defineCapabilityFixtures("file_storage_docs", {
  create_folder: {
    input: { name: "Contract Fixture Folder", parentId: "drive_folder_000001" },
  },
  delete_file: {
    input: (context) => ({
      fileId: context.value("DELETE_FILE_ID", "drive_file_000001"),
    }),
  },
  download_file: {
    input: (context) => ({
      fileId: context.value("FILE_ID", "drive_file_000001"),
      contentEncoding: "utf8",
    }),
  },
  export_document: {
    input: (context) => ({
      fileId: context.value("DOCUMENT_ID", "drive_doc_000001"),
      mimeType: "text/plain",
      contentEncoding: "utf8",
    }),
  },
  get_file: {
    input: (context) => ({
      fileId: context.value("FILE_ID", "drive_file_000001"),
    }),
  },
  list_files: { input: { pageSize: 10 } },
  move_file: {
    input: (context) => ({
      fileId: context.value("MOVE_FILE_ID", "drive_file_000001"),
      parentId: context.value("FOLDER_ID", "drive_folder_000001"),
      name: "contract-moved.csv",
    }),
  },
  search_files: { input: { query: "Launch", pageSize: 10 } },
  share_file: {
    input: (context) => ({
      fileId: context.value("FILE_ID", "drive_file_000001"),
      type: "user",
      role: "reader",
      email: "contract-reader@example.com",
    }),
  },
  upload_file: {
    input: {
      name: "contract-fixture.txt",
      mimeType: "text/plain",
      content: "Canonical contract fixture content.",
      contentEncoding: "utf8",
    },
  },
});
