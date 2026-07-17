import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const googleDriveManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "google-drive",
    displayName: "Google Drive",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: { class: "oauth2" },
  endpoint: {
    baseUrl: "https://www.googleapis.com",
    baseUrlOverrideEnv: "EYEBALL_GOOGLE_DRIVE_BASE_URL",
  },
  implements: (
    [
      ["list_files", "files.list"],
      ["get_file", "files.get"],
      ["search_files", "files.list.search"],
      ["upload_file", "files.create"],
      ["download_file", "files.get.media"],
      ["move_file", "files.update.parents"],
      ["delete_file", "files.delete"],
      ["create_folder", "files.create.folder"],
      ["share_file", "permissions.create"],
      ["export_document", "files.export"],
    ] as const
  ).map(([canonicalTool, operationId]) => ({
    capability: "file_storage_docs",
    canonicalTool,
    canonicalVersion: canonicalTool === "upload_file" ? "1.1.0" : "1.0.0",
    operationId,
  })),
} as const satisfies ProviderManifest);
