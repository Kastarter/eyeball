import { type Context, Hono } from "hono";
import {
  type AuthFailure,
  createMockClock,
  createStore,
  defineProviderMock,
  type JsonValue,
  type MockClock,
  type ProviderMock,
  type SeedRecord,
  type StoredRecord,
} from "../kit/index.js";

export interface GitHubRepository {
  databaseId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  htmlUrl: string;
}

export interface GitHubIssue {
  databaseId: number;
  repository: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  user: string;
  comments: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface GitHubComment {
  databaseId: number;
  repository: string;
  issueNumber: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequest {
  databaseId: number;
  repository: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubCommit {
  repository: string;
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  branch: string;
  htmlUrl: string;
}

export interface CreateGitHubMockOptions {
  clock?: MockClock;
}

export const GITHUB_ROUTE_COUNT = 9;

/**
 * Deterministic, non-production fixtures for the public GitHub mock.
 *
 * All identifiers, accounts, and addresses are deliberately fake.
 */
export const githubFixtures = {
  default: {
    repositories: [
      {
        id: "github_repo_fixture_000001",
        databaseId: 1001,
        owner: "example-org",
        name: "github-mock-repository",
        fullName: "example-org/github-mock-repository",
        private: false,
        defaultBranch: "main",
        description: "Obviously fake repository for deterministic mock tests",
        htmlUrl: "https://github.com/example-org/github-mock-repository",
      },
    ],
    issues: [
      {
        id: "github_issue_fixture_000001",
        databaseId: 2001,
        repository: "example-org/github-mock-repository",
        number: 1,
        title: "Ship productivity mock routes",
        body: "Implement deterministic public starter fixtures.",
        state: "open",
        labels: ["enhancement", "fixtures"],
        assignees: ["fixture-assignee"],
        user: "fixture-reporter",
        comments: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        closedAt: null,
      },
      {
        id: "github_issue_fixture_000002",
        databaseId: 2002,
        repository: "example-org/github-mock-repository",
        number: 2,
        title: "Document mock adapter examples",
        body: null,
        state: "closed",
        labels: ["documentation"],
        assignees: [],
        user: "fixture-assignee",
        comments: 0,
        createdAt: "2026-01-01T00:20:00.000Z",
        updatedAt: "2026-01-01T00:30:00.000Z",
        closedAt: "2026-01-01T00:30:00.000Z",
      },
    ],
    comments: [
      {
        id: "github_comment_fixture_000001",
        databaseId: 3001,
        repository: "example-org/github-mock-repository",
        issueNumber: 1,
        body: "The deterministic route matrix is ready for review.",
        user: "fixture-assignee",
        createdAt: "2026-01-01T00:05:00.000Z",
        updatedAt: "2026-01-01T00:05:00.000Z",
      },
    ],
    pullRequests: [
      {
        id: "github_pr_fixture_000001",
        databaseId: 4001,
        repository: "example-org/github-mock-repository",
        number: 7,
        title: "Add public GitHub mock fixtures",
        body: "Adds deterministic provider routes for adapter tests.",
        state: "open",
        merged: false,
        mergeable: true,
        head: { ref: "feature/mock-fixtures", sha: "fixture-sha-head-0001" },
        base: { ref: "main", sha: "fixture-sha-main-0001" },
        user: "fixture-assignee",
        createdAt: "2026-01-01T01:00:00.000Z",
        updatedAt: "2026-01-01T01:10:00.000Z",
      },
    ],
    commits: [
      {
        id: "github_commit_fixture_000001",
        repository: "example-org/github-mock-repository",
        sha: "fixture-sha-main-0001",
        message: "Initialize deterministic mock fixtures",
        authorName: "Fixture Author",
        authorEmail: "fixture-author@example.com",
        authoredAt: "2026-01-01T00:00:00.000Z",
        branch: "main",
        htmlUrl:
          "https://github.com/example-org/github-mock-repository/commit/fixture-sha-main-0001",
      },
      {
        id: "github_commit_fixture_000002",
        repository: "example-org/github-mock-repository",
        sha: "fixture-sha-head-0001",
        message: "Add public GitHub mock routes",
        authorName: "Fixture Contributor",
        authorEmail: "fixture-contributor@example.com",
        authoredAt: "2026-01-01T01:00:00.000Z",
        branch: "feature/mock-fixtures",
        htmlUrl:
          "https://github.com/example-org/github-mock-repository/commit/fixture-sha-head-0001",
      },
    ],
  },
} as const;

function githubErrorBody(message: string) {
  return {
    message,
    documentation_url: "https://docs.github.com/rest",
  };
}

function formatGitHubAuthError(failure: AuthFailure): JsonValue {
  return githubErrorBody(failure.message);
}

function githubError(
  context: Context,
  status: 400 | 404 | 422,
  message: string,
): Response {
  return context.json(githubErrorBody(message), status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(
  context: Context,
): Promise<Record<string, unknown>> {
  const value: unknown = await context.req.json();
  if (!isObject(value)) {
    throw new Error("The request body must be a JSON object.");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return [...new Set(value as string[])];
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function apiRepository(repository: StoredRecord<GitHubRepository>) {
  return {
    id: repository.databaseId,
    node_id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
    owner: { login: repository.owner },
    html_url: repository.htmlUrl,
    description: repository.description ?? null,
    default_branch: repository.defaultBranch,
  };
}

function apiIssue(issue: StoredRecord<GitHubIssue>) {
  return {
    id: issue.databaseId,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login })),
    user: { login: issue.user },
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${issue.repository}/issues/${issue.number}`,
  };
}

function apiComment(comment: StoredRecord<GitHubComment>) {
  return {
    id: comment.databaseId,
    node_id: comment.id,
    body: comment.body,
    user: { login: comment.user },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url:
      "https://github.com/" +
      comment.repository +
      "/issues/" +
      comment.issueNumber +
      "#issuecomment-" +
      comment.databaseId,
  };
}

function apiPullRequest(pull: StoredRecord<GitHubPullRequest>) {
  return {
    id: pull.databaseId,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: pull.head,
    base: pull.base,
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${pull.repository}/pull/${pull.number}`,
  };
}

function apiCommit(commit: StoredRecord<GitHubCommit>) {
  return {
    sha: commit.sha,
    node_id: commit.id,
    commit: {
      message: commit.message,
      author: {
        name: commit.authorName,
        email: commit.authorEmail,
        date: commit.authoredAt,
      },
    },
    html_url: commit.htmlUrl,
  };
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return parsed;
}

function seedRepository(value: unknown): SeedRecord<GitHubRepository> {
  if (!isObject(value)) {
    throw new Error("GitHub seed repositories must be objects.");
  }
  const description = optionalString(
    value.description,
    "repositories[].description",
  );
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    databaseId: integer(value.databaseId, "repositories[].databaseId"),
    owner: requiredString(value.owner, "repositories[].owner"),
    name: requiredString(value.name, "repositories[].name"),
    fullName: requiredString(value.fullName, "repositories[].fullName"),
    private: value.private === true,
    defaultBranch: requiredString(
      value.defaultBranch,
      "repositories[].defaultBranch",
    ),
    ...(description === undefined ? {} : { description }),
    htmlUrl: requiredString(value.htmlUrl, "repositories[].htmlUrl"),
  };
}

function seedIssue(value: unknown): SeedRecord<GitHubIssue> {
  if (!isObject(value)) {
    throw new Error("GitHub seed issues must be objects.");
  }
  if (value.state !== "open" && value.state !== "closed") {
    throw new Error("issues[].state is invalid.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    databaseId: integer(value.databaseId, "issues[].databaseId"),
    repository: requiredString(value.repository, "issues[].repository"),
    number: integer(value.number, "issues[].number"),
    title: requiredString(value.title, "issues[].title"),
    body: typeof value.body === "string" ? value.body : null,
    state: value.state,
    labels: stringArray(value.labels, "issues[].labels"),
    assignees: stringArray(value.assignees, "issues[].assignees"),
    user: requiredString(value.user, "issues[].user"),
    comments: integer(value.comments, "issues[].comments"),
    createdAt: requiredString(value.createdAt, "issues[].createdAt"),
    updatedAt: requiredString(value.updatedAt, "issues[].updatedAt"),
    closedAt: typeof value.closedAt === "string" ? value.closedAt : null,
  };
}

function seedComment(value: unknown): SeedRecord<GitHubComment> {
  if (!isObject(value)) {
    throw new Error("GitHub seed comments must be objects.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    databaseId: integer(value.databaseId, "comments[].databaseId"),
    repository: requiredString(value.repository, "comments[].repository"),
    issueNumber: integer(value.issueNumber, "comments[].issueNumber"),
    body: requiredString(value.body, "comments[].body"),
    user: requiredString(value.user, "comments[].user"),
    createdAt: requiredString(value.createdAt, "comments[].createdAt"),
    updatedAt: requiredString(value.updatedAt, "comments[].updatedAt"),
  };
}

function seedPull(value: unknown): SeedRecord<GitHubPullRequest> {
  if (!isObject(value)) {
    throw new Error("GitHub seed pull requests must be objects.");
  }
  if (value.state !== "open" && value.state !== "closed") {
    throw new Error("pullRequests[].state is invalid.");
  }
  if (!isObject(value.head) || !isObject(value.base)) {
    throw new Error("pullRequests[] requires head and base.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    databaseId: integer(value.databaseId, "pullRequests[].databaseId"),
    repository: requiredString(value.repository, "pullRequests[].repository"),
    number: integer(value.number, "pullRequests[].number"),
    title: requiredString(value.title, "pullRequests[].title"),
    body: typeof value.body === "string" ? value.body : null,
    state: value.state,
    merged: value.merged === true,
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    head: {
      ref: requiredString(value.head.ref, "pullRequests[].head.ref"),
      sha: requiredString(value.head.sha, "pullRequests[].head.sha"),
    },
    base: {
      ref: requiredString(value.base.ref, "pullRequests[].base.ref"),
      sha: requiredString(value.base.sha, "pullRequests[].base.sha"),
    },
    user: requiredString(value.user, "pullRequests[].user"),
    createdAt: requiredString(value.createdAt, "pullRequests[].createdAt"),
    updatedAt: requiredString(value.updatedAt, "pullRequests[].updatedAt"),
  };
}

function seedCommit(value: unknown): SeedRecord<GitHubCommit> {
  if (!isObject(value)) {
    throw new Error("GitHub seed commits must be objects.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    repository: requiredString(value.repository, "commits[].repository"),
    sha: requiredString(value.sha, "commits[].sha"),
    message: requiredString(value.message, "commits[].message"),
    authorName: requiredString(value.authorName, "commits[].authorName"),
    authorEmail: requiredString(value.authorEmail, "commits[].authorEmail"),
    authoredAt: requiredString(value.authoredAt, "commits[].authoredAt"),
    branch: requiredString(value.branch, "commits[].branch"),
    htmlUrl: requiredString(value.htmlUrl, "commits[].htmlUrl"),
  };
}

/** Creates the GitHub REST mock used by canonical repository workflows. */
export function createGitHubMock(
  options: CreateGitHubMockOptions = {},
): ProviderMock {
  const clock = options.clock ?? createMockClock();
  const repositories = createStore<GitHubRepository>("github_repo");
  const issues = createStore<GitHubIssue>("github_issue");
  const comments = createStore<GitHubComment>("github_comment");
  const pullRequests = createStore<GitHubPullRequest>("github_pr");
  const commits = createStore<GitHubCommit>("github_commit");
  const app = new Hono();

  const repository = (owner: string, repo: string) =>
    repositories
      .list()
      .find((value) => value.fullName === repoKey(owner, repo));
  const issue = (repositoryName: string, issueNumber: number) =>
    issues
      .list()
      .find(
        (value) =>
          value.repository === repositoryName && value.number === issueNumber,
      );

  app.get("/user/repos", (context) =>
    context.json(repositories.list().map(apiRepository)),
  );

  app.get("/repos/:owner/:repo/issues", (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    if (
      repository(context.req.param("owner"), context.req.param("repo")) ===
      undefined
    ) {
      return githubError(context, 404, "Not Found");
    }
    const url = new URL(context.req.url);
    const state = url.searchParams.get("state") ?? "open";
    const labelFilter = (url.searchParams.get("labels") ?? "")
      .split(",")
      .filter(Boolean);
    const assignee = url.searchParams.get("assignee");
    return context.json(
      issues
        .list()
        .filter(
          (value) =>
            value.repository === key &&
            (state === "all" || value.state === state) &&
            labelFilter.every((label) => value.labels.includes(label)) &&
            (assignee === null || value.assignees.includes(assignee)),
        )
        .map(apiIssue),
    );
  });

  app.post("/repos/:owner/:repo/issues", async (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    if (
      repository(context.req.param("owner"), context.req.param("repo")) ===
      undefined
    ) {
      return githubError(context, 404, "Not Found");
    }
    try {
      const body = await readJsonObject(context);
      const title = requiredString(body.title, "title");
      const now = clock.nowIso();
      const number =
        Math.max(
          0,
          ...issues
            .list()
            .filter((value) => value.repository === key)
            .map((value) => value.number),
        ) + 1;
      const databaseId =
        Math.max(2000, ...issues.list().map((value) => value.databaseId)) + 1;
      const created = issues.create({
        databaseId,
        repository: key,
        number,
        title,
        body: typeof body.body === "string" ? body.body : null,
        state: "open",
        labels: stringArray(body.labels, "labels"),
        assignees: stringArray(body.assignees, "assignees"),
        user: "fixture-user",
        comments: 0,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });
      return context.json(apiIssue(created), 201);
    } catch (error) {
      return githubError(
        context,
        422,
        error instanceof Error ? error.message : "Validation Failed",
      );
    }
  });

  app.get("/repos/:owner/:repo/issues/:number", (context) => {
    const found = issue(
      repoKey(context.req.param("owner"), context.req.param("repo")),
      Number(context.req.param("number")),
    );
    return found === undefined
      ? githubError(context, 404, "Not Found")
      : context.json(apiIssue(found));
  });

  app.patch("/repos/:owner/:repo/issues/:number", async (context) => {
    const found = issue(
      repoKey(context.req.param("owner"), context.req.param("repo")),
      Number(context.req.param("number")),
    );
    if (found === undefined) {
      return githubError(context, 404, "Not Found");
    }
    try {
      const body = await readJsonObject(context);
      const title = optionalString(body.title, "title");
      const state = body.state;
      if (state !== undefined && state !== "open" && state !== "closed") {
        throw new Error("state must be open or closed.");
      }
      const updated = issues.update(found.id, {
        ...(title === undefined ? {} : { title }),
        ...(body.body === undefined
          ? {}
          : { body: typeof body.body === "string" ? body.body : null }),
        ...(state === undefined ? {} : { state }),
        ...(body.labels === undefined
          ? {}
          : { labels: stringArray(body.labels, "labels") }),
        ...(body.assignees === undefined
          ? {}
          : { assignees: stringArray(body.assignees, "assignees") }),
        updatedAt: clock.nowIso(),
        ...(state === "closed"
          ? { closedAt: clock.nowIso() }
          : state === "open"
            ? { closedAt: null }
            : {}),
      });
      return context.json(apiIssue(updated ?? found));
    } catch (error) {
      return githubError(
        context,
        422,
        error instanceof Error ? error.message : "Validation Failed",
      );
    }
  });

  app.get("/repos/:owner/:repo/issues/:number/comments", (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    const number = Number(context.req.param("number"));
    if (issue(key, number) === undefined) {
      return githubError(context, 404, "Not Found");
    }
    return context.json(
      comments
        .list()
        .filter(
          (value) => value.repository === key && value.issueNumber === number,
        )
        .map(apiComment),
    );
  });

  app.post("/repos/:owner/:repo/issues/:number/comments", async (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    const number = Number(context.req.param("number"));
    const parent = issue(key, number);
    if (parent === undefined) {
      return githubError(context, 404, "Not Found");
    }
    try {
      const body = await readJsonObject(context);
      const now = clock.nowIso();
      const databaseId =
        Math.max(3000, ...comments.list().map((value) => value.databaseId)) + 1;
      const created = comments.create({
        databaseId,
        repository: key,
        issueNumber: number,
        body: requiredString(body.body, "body"),
        user: "fixture-user",
        createdAt: now,
        updatedAt: now,
      });
      issues.update(parent.id, {
        comments: parent.comments + 1,
        updatedAt: now,
      });
      return context.json(apiComment(created), 201);
    } catch (error) {
      return githubError(
        context,
        422,
        error instanceof Error ? error.message : "Validation Failed",
      );
    }
  });

  app.get("/repos/:owner/:repo/pulls/:number", (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    const number = Number(context.req.param("number"));
    const found = pullRequests
      .list()
      .find((value) => value.repository === key && value.number === number);
    return found === undefined
      ? githubError(context, 404, "Not Found")
      : context.json(apiPullRequest(found));
  });

  app.get("/repos/:owner/:repo/commits", (context) => {
    const key = repoKey(context.req.param("owner"), context.req.param("repo"));
    if (
      repository(context.req.param("owner"), context.req.param("repo")) ===
      undefined
    ) {
      return githubError(context, 404, "Not Found");
    }
    const url = new URL(context.req.url);
    const branch = url.searchParams.get("sha");
    const author = url.searchParams.get("author")?.toLowerCase();
    return context.json(
      commits
        .list()
        .filter(
          (value) =>
            value.repository === key &&
            (branch === null ||
              value.branch === branch ||
              value.sha === branch) &&
            (author === undefined ||
              value.authorName.toLowerCase().includes(author) ||
              value.authorEmail.toLowerCase().includes(author)),
        )
        .sort((left, right) => right.authoredAt.localeCompare(left.authoredAt))
        .map(apiCommit),
    );
  });

  return defineProviderMock({
    slug: "github",
    app,
    clock,
    stores: { repositories, issues, comments, pullRequests, commits },
    formatErrors: formatGitHubAuthError,
    seed(data, stores) {
      if (!isObject(data)) {
        throw new Error("GitHub seed data must be an object.");
      }
      if (
        !Array.isArray(data.repositories) ||
        !Array.isArray(data.issues) ||
        !Array.isArray(data.comments) ||
        !Array.isArray(data.pullRequests) ||
        !Array.isArray(data.commits)
      ) {
        throw new Error(
          "GitHub seed data requires repositories, issues, comments, pullRequests, and commits arrays.",
        );
      }
      stores.repositories.seed(data.repositories.map(seedRepository));
      stores.issues.seed(data.issues.map(seedIssue));
      stores.comments.seed(data.comments.map(seedComment));
      stores.pullRequests.seed(data.pullRequests.map(seedPull));
      stores.commits.seed(data.commits.map(seedCommit));
    },
    seedBundles: githubFixtures,
  });
}
