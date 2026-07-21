import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExecutorApiError, type StagedFileMetadata } from "@/src/lib/api";
import {
  classifyFileExecutorFailure,
  encodeFileBytesToBase64,
  FileLoadBanner,
  FilesScreen,
  formatFileSize,
} from "./files-screen";

const FILE_CONTENT_SENTINEL = "staged_file_bytes_must_not_render";

const stagedFile: StagedFileMetadata = {
  fileId: "file_fixture",
  name: "quarterly-report.pdf",
  mimeType: "application/pdf",
  size: 48_128,
  expiresAt: "2026-07-21T13:00:00.000Z",
};

describe("FilesScreen", () => {
  it("renders staged file metadata and never renders unknown byte fields", () => {
    const fileWithContent = {
      ...stagedFile,
      content: FILE_CONTENT_SENTINEL,
    } as unknown as StagedFileMetadata;
    const markup = renderToStaticMarkup(
      <FilesScreen initialFiles={[fileWithContent]} project="proj_fixture" />,
    );

    expect(markup).toContain("Files");
    expect(markup).toContain("Stage file");
    expect(markup).toContain(stagedFile.name);
    expect(markup).toContain(stagedFile.fileId);
    expect(markup).toContain("application/pdf");
    expect(markup).toContain("47.0 KiB");
    expect(markup).toContain("Jul 21, 2026, 13:00");
    expect(markup).not.toContain(FILE_CONTENT_SENTINEL);
  });

  it("distinguishes a true empty project from a filtered-empty search", () => {
    const emptyMarkup = renderToStaticMarkup(
      <FilesScreen initialFiles={[]} project="proj_fixture" />,
    );

    expect(emptyMarkup).toContain("No staged files");
    expect(emptyMarkup).toContain("eyeball.files.upload");
    expect(emptyMarkup).toContain("Stage a file");
    expect(emptyMarkup).not.toContain("match this search");
  });

  it("renders specific setup, authority, and offline guidance", () => {
    const markup = renderToStaticMarkup(
      <div>
        <FileLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="unconfigured"
        />
        <FileLoadBanner
          cloud
          onRetry={() => undefined}
          project="proj_fixture"
          state="forbidden"
        />
        <FileLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="offline"
        />
      </div>,
    );

    expect(markup).toContain("EYEBALL_API_KEY");
    expect(markup).toContain("Unpinned project key required");
    expect(markup).toContain("project-authority only");
    expect(markup).toContain("Open Settings");
    expect(markup).toContain("Executor offline");
    expect(markup.match(/Retry/g)).toHaveLength(3);
  });

  it("classifies executor failures without losing normalized codes", () => {
    expect(
      classifyFileExecutorFailure(new ExecutorApiError("Missing", 401)).state,
    ).toBe("unconfigured");
    expect(
      classifyFileExecutorFailure(
        new ExecutorApiError("Scope", 403, { code: "auth_insufficient_scope" }),
      ).state,
    ).toBe("forbidden");
    expect(
      classifyFileExecutorFailure(new ExecutorApiError("Offline", 502)).state,
    ).toBe("offline");
    expect(
      classifyFileExecutorFailure(
        new ExecutorApiError("Missing URL", 503, {
          code: "executor_not_configured",
        }),
      ).state,
    ).toBe("not_configured");
  });

  it("formats sizes and encodes upload bytes as padded base64", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(48_128)).toBe("47.0 KiB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MiB");
    expect(encodeFileBytesToBase64(new TextEncoder().encode("eyeball"))).toBe(
      "ZXllYmFsbA==",
    );
    expect(
      atob(encodeFileBytesToBase64(new Uint8Array([0, 255, 128, 7]))),
    ).toBe(String.fromCharCode(0, 255, 128, 7));
  });
});
