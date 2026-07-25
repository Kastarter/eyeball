import { beforeAll, describe, expect, it } from "vitest";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type ProductivityMocksModule =
  typeof import("../../../../mocks/packages/mocks-productivity/dist/index.js");
type ProductivityHelpersModule = typeof import("./helpers.js");

let airtableFixtures: ProductivityMocksModule["airtableFixtures"];
let createAirtableMock: ProductivityMocksModule["createAirtableMock"];
let createGitHubMock: ProductivityMocksModule["createGitHubMock"];
let createGoogleCalendarMock: ProductivityMocksModule["createGoogleCalendarMock"];
let createGoogleDriveMock: ProductivityMocksModule["createGoogleDriveMock"];
let createGoogleSheetsMock: ProductivityMocksModule["createGoogleSheetsMock"];
let createLinearMock: ProductivityMocksModule["createLinearMock"];
let createNotionMock: ProductivityMocksModule["createNotionMock"];
let githubFixtures: ProductivityMocksModule["githubFixtures"];
let googleCalendarFixtures: ProductivityMocksModule["googleCalendarFixtures"];
let googleDriveFixtures: ProductivityMocksModule["googleDriveFixtures"];
let googleSheetsFixtures: ProductivityMocksModule["googleSheetsFixtures"];
let linearFixtures: ProductivityMocksModule["linearFixtures"];
let notionFixtures: ProductivityMocksModule["notionFixtures"];
let createProductivityMockHarness: ProductivityHelpersModule["createProductivityMockHarness"];
let executionOutput: ProductivityHelpersModule["executionOutput"];
const mocksAvailable = hasMocksCheckout();

const OAUTH_CREDENTIAL = {
  type: "oauth2",
  accessToken: "fixture:valid",
} as const;

function rows(output: Readonly<Record<string, unknown>>) {
  return output.rows as ReadonlyArray<Readonly<Record<string, unknown>>>;
}

function issues(output: Readonly<Record<string, unknown>>) {
  return output.issues as ReadonlyArray<Readonly<Record<string, unknown>>>;
}

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("productivity adapters", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<ProductivityMocksModule>("mocks-productivity"),
        import("./helpers.js") as Promise<ProductivityHelpersModule>,
      ]);
      ({
        airtableFixtures,
        createAirtableMock,
        createGitHubMock,
        createGoogleCalendarMock,
        createGoogleDriveMock,
        createGoogleSheetsMock,
        createLinearMock,
        createNotionMock,
        githubFixtures,
        googleCalendarFixtures,
        googleDriveFixtures,
        googleSheetsFixtures,
        linearFixtures,
        notionFixtures,
      } = mocks);
      ({ createProductivityMockHarness, executionOutput } = helpers);
    });

    it("creates a Notion page, retrieves it, and finds it by query and filter", async () => {
      const provider = createNotionMock();
      await provider.seed(notionFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const created = executionOutput(
        await harness.execute("notion.create_row", {
          documentId: "db_tasks_000001",
          values: {
            Name: "Integration launch page",
            Status: "Ready",
            Owner: "Casey Fixture",
          },
        }),
      );
      const createdRow = created.row as Readonly<Record<string, unknown>>;
      expect(createdRow).toMatchObject({
        values: { Name: "Integration launch page", Status: "Ready" },
      });

      const retrieved = executionOutput(
        await harness.execute("notion.get_row", {
          documentId: "db_tasks_000001",
          rowId: createdRow.rowId as string,
        }),
      );
      expect(retrieved.row).toMatchObject({ rowId: createdRow.rowId });

      const searched = executionOutput(
        await harness.execute("notion.search_rows", {
          documentId: "db_tasks_000001",
          query: "Integration launch",
          filter: { Status: "Ready" },
        }),
      );
      expect(rows(searched)).toEqual([
        expect.objectContaining({ rowId: createdRow.rowId }),
      ]);
    });

    it("lists Notion databases through the canonical table contract", async () => {
      const provider = createNotionMock();
      await provider.seed(notionFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const output = executionOutput(
        await harness.execute("notion.list_tables", {
          documentId: "db_tasks_000001",
        }),
      );
      expect(output.tables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tableId: "db_tasks_000001" }),
        ]),
      );
    });

    it("creates, updates, and filters an Airtable record", async () => {
      const provider = createAirtableMock();
      await provider.seed(airtableFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const created = executionOutput(
        await harness.execute("airtable.create_row", {
          documentId: "app_fixture_000001",
          tableId: "Tasks",
          values: { Name: "Integration task", Status: "Draft" },
        }),
      );
      const createdRow = created.row as Readonly<Record<string, unknown>>;

      const updated = executionOutput(
        await harness.execute("airtable.update_row", {
          documentId: "app_fixture_000001",
          tableId: "Tasks",
          rowId: createdRow.rowId as string,
          values: { Status: "Ready", Owner: "Casey Fixture" },
        }),
      );
      expect(updated.row).toMatchObject({
        rowId: createdRow.rowId,
        values: { Name: "Integration task", Status: "Ready" },
      });

      const filtered = executionOutput(
        await harness.execute("airtable.search_rows", {
          documentId: "app_fixture_000001",
          tableId: "Tasks",
          filter: { Status: "Ready" },
        }),
      );
      expect(rows(filtered)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rowId: createdRow.rowId }),
        ]),
      );
    });

    it("paginates Airtable records with the provider offset token", async () => {
      const provider = createAirtableMock();
      await provider.seed(airtableFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const first = executionOutput(
        await harness.execute("airtable.list_rows", {
          documentId: "app_fixture_000001",
          tableId: "Tasks",
          pageSize: 1,
        }),
      );
      expect(rows(first)).toHaveLength(1);
      expect(first.nextPageToken).toEqual(expect.any(String));

      const second = executionOutput(
        await harness.execute("airtable.list_rows", {
          documentId: "app_fixture_000001",
          tableId: "Tasks",
          pageSize: 1,
          pageToken: first.nextPageToken as string,
        }),
      );
      expect(rows(second)).toHaveLength(1);
      expect(rows(second)[0]?.rowId).not.toBe(rows(first)[0]?.rowId);
    });

    it("updates and reads a Google Sheets range", async () => {
      const provider = createGoogleSheetsMock();
      await provider.seed(googleSheetsFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const updated = executionOutput(
        await harness.execute("google-sheets.update_range", {
          documentId: "sheet_tasks_000001",
          range: "Tasks!B2:B2",
          values: [["Done"]],
        }),
      );
      expect(updated).toMatchObject({
        documentId: "sheet_tasks_000001",
        updatedRows: 1,
        updatedCells: 1,
      });

      const read = executionOutput(
        await harness.execute("google-sheets.get_range", {
          documentId: "sheet_tasks_000001",
          range: "Tasks!B2:B2",
        }),
      );
      expect(read.values).toEqual([["Done"]]);
    });

    it("appends a Google Sheets row and reads the appended range", async () => {
      const provider = createGoogleSheetsMock();
      await provider.seed(googleSheetsFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const appended = executionOutput(
        await harness.execute("google-sheets.append_row", {
          documentId: "sheet_tasks_000001",
          range: "Tasks!A:C",
          values: [["Integration task", "Ready", "Casey Fixture"]],
        }),
      );
      expect(appended).toMatchObject({ updatedRows: 1, updatedCells: 3 });

      const read = executionOutput(
        await harness.execute("google-sheets.get_range", {
          documentId: "sheet_tasks_000001",
          range: appended.updatedRange as string,
        }),
      );
      expect(read.values).toEqual([
        ["Integration task", "Ready", "Casey Fixture"],
      ]);
    });

    it("uploads, downloads, shares, and searches for a Google Drive file", async () => {
      const provider = createGoogleDriveMock();
      await provider.seed(googleDriveFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);
      const staged = await harness.stageFile({
        name: "integration-notes.txt",
        mimeType: "text/plain",
        content: "deterministic integration payload",
      });

      const uploaded = executionOutput(
        await harness.execute("google-drive.upload_file", {
          name: "integration-notes.txt",
          mimeType: "text/plain",
          fileId: staged.fileId,
          parentId: "drive_folder_000001",
        }),
      );
      const file = uploaded.file as Readonly<Record<string, unknown>>;

      const downloaded = executionOutput(
        await harness.execute("google-drive.download_file", {
          fileId: file.fileId as string,
          contentEncoding: "utf8",
        }),
      );
      expect(downloaded).toMatchObject({
        fileId: file.fileId,
        mimeType: "text/plain",
        content: "deterministic integration payload",
        contentEncoding: "utf8",
      });

      const permission = executionOutput(
        await harness.execute("google-drive.share_file", {
          fileId: file.fileId as string,
          type: "user",
          role: "reader",
          email: "casey@example.com",
        }),
      );
      expect(permission).toMatchObject({
        fileId: file.fileId,
        type: "user",
        role: "reader",
        email: "casey@example.com",
      });

      const searched = executionOutput(
        await harness.execute("google-drive.search_files", {
          query: "integration-notes",
        }),
      );
      expect(searched.files).toEqual([
        expect.objectContaining({ fileId: file.fileId }),
      ]);
    });

    it("preserves staged binary bytes in a Google Drive multipart upload", async () => {
      const provider = createGoogleDriveMock();
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);
      const content = Uint8Array.from([0, 255, 1, 254, 2, 253]);
      const staged = await harness.stageFile({
        name: "binary-fixture.bin",
        mimeType: "application/octet-stream",
        content,
      });

      const uploaded = executionOutput(
        await harness.execute("google-drive.upload_file", {
          fileId: staged.fileId,
        }),
      );
      expect(uploaded.file).toMatchObject({
        name: "binary-fixture.bin",
        mimeType: "application/octet-stream",
      });

      const request = harness
        .providerRequests()
        .find(({ url }) => url.includes("/upload/drive/v3/files"));
      expect(request).toMatchObject({ method: "POST" });
      expect(request?.contentType).toMatch(/^multipart\/related; boundary=/u);
      const body = Buffer.from(request?.bodyBase64 ?? "", "base64");
      expect(body.indexOf(Buffer.from(content))).toBeGreaterThanOrEqual(0);
      expect(body.toString("utf8")).toContain('"name":"binary-fixture.bin"');
    });

    it("lists and retrieves seeded Google Drive metadata", async () => {
      const provider = createGoogleDriveMock();
      await provider.seed(googleDriveFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const listed = executionOutput(
        await harness.execute("google-drive.list_files", {}),
      );
      expect(listed.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fileId: "drive_folder_000001" }),
        ]),
      );

      const retrieved = executionOutput(
        await harness.execute("google-drive.get_file", {
          fileId: "drive_file_000001",
        }),
      );
      expect(retrieved.file).toMatchObject({ fileId: "drive_file_000001" });
    });

    it("creates and lists a Google Calendar event and computes free time around it", async () => {
      const provider = createGoogleCalendarMock();
      await provider.seed(googleCalendarFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const created = executionOutput(
        await harness.execute("google-calendar.create_event", {
          calendarId: "primary",
          title: "Integration review",
          startTime: "2026-01-05T11:00:00.000Z",
          endTime: "2026-01-05T12:00:00.000Z",
          timeZone: "UTC",
        }),
      );
      const event = created.event as Readonly<Record<string, unknown>>;

      const listed = executionOutput(
        await harness.execute("google-calendar.list_events", {
          calendarId: "primary",
          startTime: "2026-01-05T08:00:00.000Z",
          endTime: "2026-01-05T13:00:00.000Z",
        }),
      );
      expect(listed.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: event.eventId }),
        ]),
      );

      const availability = executionOutput(
        await harness.execute("google-calendar.find_available_times", {
          calendarIds: ["primary"],
          startTime: "2026-01-05T08:00:00.000Z",
          endTime: "2026-01-05T13:00:00.000Z",
          durationMinutes: 30,
        }),
      );
      expect(availability.busyTimes).toEqual([
        {
          startTime: "2026-01-05T09:00:00.000Z",
          endTime: "2026-01-05T10:00:00.000Z",
        },
        {
          startTime: "2026-01-05T11:00:00.000Z",
          endTime: "2026-01-05T12:00:00.000Z",
        },
      ]);
      expect(availability.availableTimes).toEqual(
        expect.arrayContaining([
          {
            startTime: "2026-01-05T10:00:00.000Z",
            endTime: "2026-01-05T11:00:00.000Z",
          },
        ]),
      );
    });

    it("responds to a seeded Google Calendar invitation", async () => {
      const provider = createGoogleCalendarMock();
      await provider.seed(googleCalendarFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const output = executionOutput(
        await harness.execute("google-calendar.respond_to_event", {
          calendarId: "primary",
          eventId: "event_launch_000001",
          attendeeEmail: "jordan@acme.example",
          response: "accepted",
        }),
      );
      expect(output.event).toMatchObject({
        eventId: "event_launch_000001",
        attendees: expect.arrayContaining([
          expect.objectContaining({
            email: "jordan@acme.example",
            response: "accepted",
          }),
        ]),
      });
    });

    it("creates, comments on, and lists a GitHub issue", async () => {
      const provider = createGitHubMock();
      await provider.seed(githubFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);
      const projectId = "acme-example/eyeball-fixture";

      const created = executionOutput(
        await harness.execute("github.create_issue", {
          projectId,
          title: "Integration issue",
          body: "Created through the canonical executor flow.",
          labels: ["bug"],
        }),
      );
      const issue = created.issue as Readonly<Record<string, unknown>>;

      const comment = executionOutput(
        await harness.execute("github.add_comment", {
          projectId,
          issueId: issue.issueId as string,
          body: "Integration comment",
        }),
      );
      expect(comment.comment).toMatchObject({
        issueId: issue.issueId,
        body: "Integration comment",
      });

      const listed = executionOutput(
        await harness.execute("github.list_issues", {
          projectId,
          state: "open",
        }),
      );
      expect(issues(listed)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issueId: issue.issueId }),
        ]),
      );
    });

    it("retrieves a GitHub pull request and lists repository commits", async () => {
      const provider = createGitHubMock();
      await provider.seed(githubFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);
      const projectId = "acme-example/eyeball-fixture";

      const pullRequest = executionOutput(
        await harness.execute("github.get_pull_request", {
          projectId,
          pullRequestId: "7",
        }),
      );
      expect(pullRequest.pullRequest).toMatchObject({
        pullRequestId: "7",
        projectId,
      });

      const commits = executionOutput(
        await harness.execute("github.list_commits", { projectId }),
      );
      expect(commits.commits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sha: expect.any(String),
            message: expect.any(String),
          }),
        ]),
      );
    });

    it("creates, retrieves, and updates a Linear issue", async () => {
      const provider = createLinearMock();
      await provider.seed(linearFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);
      const projectId = "linear_project_000001";

      const created = executionOutput(
        await harness.execute("linear.create_issue", {
          projectId,
          title: "Integration issue",
          body: "Exercise the GraphQL adapter.",
          priority: 2,
        }),
      );
      const issue = created.issue as Readonly<Record<string, unknown>>;
      expect(issue).toMatchObject({ title: "Integration issue", projectId });

      const retrieved = executionOutput(
        await harness.execute("linear.get_issue", {
          projectId,
          issueId: issue.issueId as string,
        }),
      );
      expect(retrieved.issue).toMatchObject({ issueId: issue.issueId });

      const updated = executionOutput(
        await harness.execute("linear.update_issue", {
          projectId,
          issueId: issue.issueId as string,
          title: "Integration issue updated",
          priority: 1,
        }),
      );
      expect(updated.issue).toMatchObject({
        issueId: issue.issueId,
        title: "Integration issue updated",
        priority: 1,
      });

      const commented = executionOutput(
        await harness.execute("linear.add_comment", {
          projectId,
          issueId: issue.issueId as string,
          body: "Integration comment",
        }),
      );
      expect(commented.comment).toMatchObject({
        issueId: issue.issueId,
        body: "Integration comment",
      });
    });

    it("lists Linear projects and issues through canonical contracts", async () => {
      const provider = createLinearMock();
      await provider.seed(linearFixtures.default);
      const harness = createProductivityMockHarness(provider, OAUTH_CREDENTIAL);

      const projects = executionOutput(
        await harness.execute("linear.list_projects", {}),
      );
      expect(projects.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ projectId: "linear_project_000001" }),
        ]),
      );

      const listed = executionOutput(
        await harness.execute("linear.list_issues", {
          projectId: "linear_project_000001",
        }),
      );
      expect(issues(listed)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issueId: "linear_issue_000001" }),
        ]),
      );
    });
  },
);
