import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  asJson,
  booleanValue,
  inputString,
  jsonObject,
  jsonRecords,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  queryPath,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

type RepositoryCoordinates = { owner: string; repo: string };

function repositoryCoordinates(context: AdapterContext): RepositoryCoordinates {
  const projectId = inputString(context, "projectId");
  const separator = projectId.indexOf("/");
  if (
    separator < 1 ||
    separator === projectId.length - 1 ||
    projectId.indexOf("/", separator + 1) >= 0
  ) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: projectId must be an owner/repository name.`,
    });
  }
  return {
    owner: projectId.slice(0, separator),
    repo: projectId.slice(separator + 1),
  };
}

function repositoryPath(context: AdapterContext): string {
  const { owner, repo } = repositoryCoordinates(context);
  return `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function numericIdentifier(context: AdapterContext, key: string): string {
  const value = inputString(context, key);
  if (!/^\d+$/u.test(value)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: ${key} must be a numeric GitHub identifier.`,
    });
  }
  return value;
}

function repository(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    projectId: requiredString(context, value, "full_name"),
    name: requiredString(context, value, "name"),
    kind: "repository",
    ...(stringValue(value, "description") === undefined
      ? {}
      : { description: stringValue(value, "description") }),
    private: booleanValue(value, "private") ?? false,
    ...(stringValue(value, "default_branch") === undefined
      ? {}
      : { defaultBranch: stringValue(value, "default_branch") }),
    ...(stringValue(value, "html_url") === undefined
      ? {}
      : { webUrl: stringValue(value, "html_url") }),
  };
}

function issue(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  projectId: string,
): Readonly<Record<string, unknown>> {
  const number = requiredId(context, value.number, "issue");
  const user = recordValue(value, "user") ?? {};
  return {
    issueId: number,
    issueKey: number,
    projectId,
    title: requiredString(context, value, "title"),
    ...(stringValue(value, "body") === undefined
      ? {}
      : { body: stringValue(value, "body") }),
    state: requiredString(context, value, "state"),
    labels: records(value.labels).flatMap((label) => {
      const name = stringValue(label, "name");
      return name === undefined ? [] : [name];
    }),
    assigneeIds: records(value.assignees).flatMap((assignee) => {
      const login = stringValue(assignee, "login");
      return login === undefined ? [] : [login];
    }),
    ...(stringValue(user, "login") === undefined
      ? {}
      : { authorId: stringValue(user, "login") }),
    commentCount: numberValue(value, "comments") ?? 0,
    ...(stringValue(value, "html_url") === undefined
      ? {}
      : { webUrl: stringValue(value, "html_url") }),
    createdAt: requiredString(context, value, "created_at"),
    updatedAt: requiredString(context, value, "updated_at"),
    ...(stringValue(value, "closed_at") === undefined
      ? {}
      : { closedAt: stringValue(value, "closed_at") }),
  };
}

function comment(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  issueId: string,
): Readonly<Record<string, unknown>> {
  const user = recordValue(value, "user") ?? {};
  return {
    commentId: requiredId(context, value.id, "comment"),
    issueId,
    body: requiredString(context, value, "body"),
    ...(stringValue(user, "login") === undefined
      ? {}
      : { authorId: stringValue(user, "login") }),
    ...(stringValue(value, "html_url") === undefined
      ? {}
      : { webUrl: stringValue(value, "html_url") }),
    createdAt: requiredString(context, value, "created_at"),
    updatedAt: requiredString(context, value, "updated_at"),
  };
}

function pullRequest(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  projectId: string,
): Readonly<Record<string, unknown>> {
  const head = recordValue(value, "head") ?? {};
  const base = recordValue(value, "base") ?? {};
  const user = recordValue(value, "user") ?? {};
  return {
    pullRequestId: requiredId(context, value.number, "pull request"),
    projectId,
    title: requiredString(context, value, "title"),
    ...(stringValue(value, "body") === undefined
      ? {}
      : { body: stringValue(value, "body") }),
    state: requiredString(context, value, "state"),
    merged: booleanValue(value, "merged") ?? false,
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    headBranch: requiredString(context, head, "ref"),
    headSha: requiredString(context, head, "sha"),
    baseBranch: requiredString(context, base, "ref"),
    baseSha: requiredString(context, base, "sha"),
    ...(stringValue(user, "login") === undefined
      ? {}
      : { authorId: stringValue(user, "login") }),
    ...(stringValue(value, "html_url") === undefined
      ? {}
      : { webUrl: stringValue(value, "html_url") }),
    createdAt: requiredString(context, value, "created_at"),
    updatedAt: requiredString(context, value, "updated_at"),
  };
}

function commit(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const details = recordValue(value, "commit") ?? {};
  const author = recordValue(details, "author") ?? {};
  return {
    sha: requiredString(context, value, "sha"),
    message: requiredString(context, details, "message"),
    ...(stringValue(author, "name") === undefined
      ? {}
      : { authorName: stringValue(author, "name") }),
    ...(stringValue(author, "email") === undefined
      ? {}
      : { authorEmail: stringValue(author, "email") }),
    authoredAt: requiredString(context, author, "date"),
    ...(stringValue(value, "html_url") === undefined
      ? {}
      : { webUrl: stringValue(value, "html_url") }),
  };
}

export class GitHubAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "github";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "github.list_projects":
        return this.listProjects(context);
      case "github.create_issue":
        return this.createIssue(context);
      case "github.get_issue":
        return this.getIssue(context);
      case "github.list_issues":
        return this.listIssues(context);
      case "github.update_issue":
        return this.updateIssue(context);
      case "github.add_comment":
        return this.addComment(context);
      case "github.get_pull_request":
        return this.getPullRequest(context);
      case "github.list_commits":
        return this.listCommits(context);
      default:
        return unsupported(context);
    }
  }

  private async listProjects(context: AdapterContext): Promise<JsonValue> {
    const values = await jsonRecords(context, "user/repos");
    const selected = page(
      values,
      parseOffsetToken(
        context,
        stringValue(context.canonicalInput, "pageToken"),
      ),
      numberValue(context.canonicalInput, "pageSize") ?? 50,
    );
    return asJson({
      projects: selected.values.map((value) => repository(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async createIssue(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const projectId = inputString(context, "projectId");
    const value = await jsonObject(
      context,
      `${repositoryPath(context)}/issues`,
      jsonRequest({
        title: inputString(context, "title"),
        ...(stringValue(input, "body") === undefined
          ? {}
          : { body: input.body }),
        ...(Array.isArray(input.labels) ? { labels: input.labels } : {}),
        ...(Array.isArray(input.assigneeIds)
          ? { assignees: input.assigneeIds }
          : {}),
      }),
    );
    return asJson({ issue: issue(context, value, projectId) });
  }

  private async getIssue(context: AdapterContext): Promise<JsonValue> {
    const projectId = inputString(context, "projectId");
    const issueId = numericIdentifier(context, "issueId");
    const value = await jsonObject(
      context,
      `${repositoryPath(context)}/issues/${issueId}`,
    );
    return asJson({ issue: issue(context, value, projectId) });
  }

  private async listIssues(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const projectId = inputString(context, "projectId");
    const values = await jsonRecords(
      context,
      queryPath(`${repositoryPath(context)}/issues`, {
        state: stringValue(input, "state"),
        assignee: stringValue(input, "assigneeId"),
        labels: Array.isArray(input.labels)
          ? input.labels.filter((value) => typeof value === "string").join(",")
          : undefined,
      }),
    );
    const selected = page(
      values,
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      issues: selected.values.map((value) => issue(context, value, projectId)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async updateIssue(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const projectId = inputString(context, "projectId");
    const issueId = numericIdentifier(context, "issueId");
    const value = await jsonObject(
      context,
      `${repositoryPath(context)}/issues/${issueId}`,
      jsonRequest(
        {
          ...(stringValue(input, "title") === undefined
            ? {}
            : { title: input.title }),
          ...(stringValue(input, "body") === undefined
            ? {}
            : { body: input.body }),
          ...(stringValue(input, "state") === undefined
            ? {}
            : { state: input.state }),
          ...(Array.isArray(input.labels) ? { labels: input.labels } : {}),
          ...(Array.isArray(input.assigneeIds)
            ? { assignees: input.assigneeIds }
            : {}),
        },
        "PATCH",
      ),
    );
    return asJson({ issue: issue(context, value, projectId) });
  }

  private async addComment(context: AdapterContext): Promise<JsonValue> {
    const issueId = numericIdentifier(context, "issueId");
    const value = await jsonObject(
      context,
      `${repositoryPath(context)}/issues/${issueId}/comments`,
      jsonRequest({ body: inputString(context, "body") }),
    );
    return asJson({ comment: comment(context, value, issueId) });
  }

  private async getPullRequest(context: AdapterContext): Promise<JsonValue> {
    const projectId = inputString(context, "projectId");
    const pullRequestId = numericIdentifier(context, "pullRequestId");
    const value = await jsonObject(
      context,
      `${repositoryPath(context)}/pulls/${pullRequestId}`,
    );
    return asJson({
      pullRequest: pullRequest(context, value, projectId),
    });
  }

  private async listCommits(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const values = await jsonRecords(
      context,
      queryPath(`${repositoryPath(context)}/commits`, {
        sha: stringValue(input, "branch"),
        author: stringValue(input, "author"),
      }),
    );
    const selected = page(
      values,
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      commits: selected.values.map((value) => commit(context, value)),
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }
}

export const gitHubAdapter = new GitHubAdapter();
