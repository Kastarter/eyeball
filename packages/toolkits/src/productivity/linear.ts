import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  inputString,
  jsonObject,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

type LinearSelection = { teamId: string; projectId?: string };

const ISSUE_SELECTION = `
  id
  identifier
  title
  description
  state { id name }
  priority
  assignee { id }
  team { id }
  project { id }
  comments { totalCount }
  createdAt
  updatedAt
`;

const COMMENT_SELECTION = `
  id
  body
  user { id }
  issue { id }
  createdAt
  updatedAt
`;

async function linearData(
  context: AdapterContext,
  operationName: string,
  query: string,
  variables: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  const body = await jsonObject(
    context,
    "graphql",
    jsonRequest({ operationName, query, variables }),
  );
  const firstError = records(body.errors)[0];
  if (firstError !== undefined) {
    const extensions = recordValue(firstError, "extensions") ?? {};
    const code = stringValue(extensions, "code");
    throw providerError(
      context,
      stringValue(firstError, "message") ?? "Linear returned an error.",
      {
        ...(code === undefined ? {} : { code }),
        detail: asJson(body),
      },
    );
  }
  const data = recordValue(body, "data");
  if (data === undefined) {
    throw providerError(context, "Linear returned an invalid GraphQL payload.");
  }
  return data;
}

async function teams(
  context: AdapterContext,
): Promise<Readonly<Record<string, unknown>>[]> {
  const data = await linearData(
    context,
    "Teams",
    "query Teams { teams { nodes { id name key description } } }",
  );
  return records(recordValue(data, "teams")?.nodes);
}

async function projects(
  context: AdapterContext,
): Promise<Readonly<Record<string, unknown>>[]> {
  const data = await linearData(
    context,
    "Projects",
    "query Projects { projects { nodes { id name description state teams @include(if: true) { nodes { id } } createdAt updatedAt } } }",
  );
  return records(recordValue(data, "projects")?.nodes);
}

async function selection(context: AdapterContext): Promise<LinearSelection> {
  const projectId = inputString(context, "projectId");
  const [teamValues, projectValues] = await Promise.all([
    teams(context),
    projects(context),
  ]);
  if (teamValues.some((team) => team.id === projectId)) {
    return { teamId: projectId };
  }
  const project = projectValues.find((value) => value.id === projectId);
  const teamId = requiredId(
    context,
    records(recordValue(project ?? {}, "teams")?.nodes)[0]?.id,
    "project team",
  );
  return { teamId, projectId };
}

function teamProject(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    projectId: requiredId(context, value.id, "team"),
    name: requiredString(context, value, "name"),
    kind: "team",
    ...(stringValue(value, "description") === undefined
      ? {}
      : { description: stringValue(value, "description") }),
  };
}

function linearProject(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    projectId: requiredId(context, value.id, "project"),
    name: requiredString(context, value, "name"),
    kind: "project",
    ...(stringValue(value, "description") === undefined
      ? {}
      : { description: stringValue(value, "description") }),
    ...(stringValue(value, "state") === undefined
      ? {}
      : { state: stringValue(value, "state") }),
    teamIds: records(recordValue(value, "teams")?.nodes).flatMap((team) => {
      const id = requiredId(context, team.id, "team");
      return [id];
    }),
    ...(stringValue(value, "createdAt") === undefined
      ? {}
      : { createdAt: stringValue(value, "createdAt") }),
    ...(stringValue(value, "updatedAt") === undefined
      ? {}
      : { updatedAt: stringValue(value, "updatedAt") }),
  };
}

function issue(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const state = recordValue(value, "state") ?? {};
  const team = recordValue(value, "team") ?? {};
  const project = recordValue(value, "project");
  const assignee = recordValue(value, "assignee");
  const comments = recordValue(value, "comments") ?? {};
  return {
    issueId: requiredId(context, value.id, "issue"),
    issueKey: requiredString(context, value, "identifier"),
    projectId: requiredId(context, project?.id ?? team.id, "issue project"),
    title: requiredString(context, value, "title"),
    ...(stringValue(value, "description") === undefined
      ? {}
      : { body: stringValue(value, "description") }),
    state: stringValue(state, "name") ?? requiredString(context, state, "id"),
    labels: [],
    assigneeIds:
      assignee === undefined
        ? []
        : [requiredId(context, assignee.id, "assignee")],
    ...(numberValue(value, "priority") === undefined
      ? {}
      : { priority: numberValue(value, "priority") }),
    commentCount: numberValue(comments, "totalCount") ?? 0,
    createdAt: requiredString(context, value, "createdAt"),
    updatedAt: requiredString(context, value, "updatedAt"),
  };
}

function comment(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const user = recordValue(value, "user") ?? {};
  const parent = recordValue(value, "issue") ?? {};
  const authorId = requiredId(context, user.id, "comment author");
  return {
    commentId: requiredId(context, value.id, "comment"),
    issueId: requiredId(context, parent.id, "issue"),
    body: requiredString(context, value, "body"),
    authorId,
    createdAt: requiredString(context, value, "createdAt"),
    updatedAt: requiredString(context, value, "updatedAt"),
  };
}

function inputAssignee(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  return Array.isArray(input.assigneeIds) &&
    typeof input.assigneeIds[0] === "string"
    ? input.assigneeIds[0]
    : undefined;
}

export class LinearAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "linear";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "linear.list_projects":
        return this.listProjects(context);
      case "linear.create_issue":
        return this.createIssue(context);
      case "linear.get_issue":
        return this.getIssue(context);
      case "linear.list_issues":
        return this.listIssues(context);
      case "linear.update_issue":
        return this.updateIssue(context);
      case "linear.add_comment":
        return this.addComment(context);
      default:
        return unsupported(context);
    }
  }

  private async listProjects(context: AdapterContext): Promise<JsonValue> {
    const [teamValues, projectValues] = await Promise.all([
      teams(context),
      projects(context),
    ]);
    const values = [
      ...teamValues.map((value) => teamProject(context, value)),
      ...projectValues.map((value) => linearProject(context, value)),
    ];
    const selected = page(
      values,
      parseOffsetToken(
        context,
        stringValue(context.canonicalInput, "pageToken"),
      ),
      numberValue(context.canonicalInput, "pageSize") ?? 50,
    );
    return asJson({
      projects: selected.values,
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async createIssue(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const target = await selection(context);
    const data = await linearData(
      context,
      "IssueCreate",
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_SELECTION} } }
      }`,
      {
        input: {
          teamId: target.teamId,
          ...(target.projectId === undefined
            ? {}
            : { projectId: target.projectId }),
          title: inputString(context, "title"),
          ...(stringValue(input, "body") === undefined
            ? {}
            : { description: input.body }),
          ...(numberValue(input, "priority") === undefined
            ? {}
            : { priority: input.priority }),
          ...(inputAssignee(input) === undefined
            ? {}
            : { assigneeId: inputAssignee(input) }),
        },
      },
    );
    const payload = recordValue(data, "issueCreate") ?? {};
    return asJson({
      issue: issue(context, recordValue(payload, "issue") ?? {}),
    });
  }

  private async getIssue(context: AdapterContext): Promise<JsonValue> {
    const data = await linearData(
      context,
      "Issue",
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_SELECTION} } }`,
      { id: inputString(context, "issueId") },
    );
    return asJson({ issue: issue(context, recordValue(data, "issue") ?? {}) });
  }

  private async listIssues(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const target = await selection(context);
    const data = await linearData(
      context,
      "Issues",
      `query Issues($filter: IssueFilter) {
        issues(filter: $filter) { nodes { ${ISSUE_SELECTION} } }
      }`,
      { filter: target },
    );
    const values = records(recordValue(data, "issues")?.nodes)
      .map((value) => issue(context, value))
      .filter((value) => {
        const state = stringValue(input, "state");
        const assigneeId = stringValue(input, "assigneeId");
        const requestedLabels = Array.isArray(input.labels)
          ? input.labels.filter((entry) => typeof entry === "string")
          : [];
        return (
          (state === undefined || value.state === state) &&
          (assigneeId === undefined ||
            (Array.isArray(value.assigneeIds) &&
              value.assigneeIds.includes(assigneeId))) &&
          requestedLabels.length === 0
        );
      });
    const selected = page(
      values,
      parseOffsetToken(context, stringValue(input, "pageToken")),
      numberValue(input, "pageSize") ?? 50,
    );
    return asJson({
      issues: selected.values,
      ...(selected.nextPageToken === undefined
        ? {}
        : { nextPageToken: selected.nextPageToken }),
    });
  }

  private async updateIssue(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const data = await linearData(
      context,
      "IssueUpdate",
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { ${ISSUE_SELECTION} }
        }
      }`,
      {
        id: inputString(context, "issueId"),
        input: {
          ...(stringValue(input, "title") === undefined
            ? {}
            : { title: input.title }),
          ...(stringValue(input, "body") === undefined
            ? {}
            : { description: input.body }),
          ...(stringValue(input, "state") === undefined
            ? {}
            : { stateId: input.state }),
          ...(numberValue(input, "priority") === undefined
            ? {}
            : { priority: input.priority }),
          ...(inputAssignee(input) === undefined
            ? {}
            : { assigneeId: inputAssignee(input) }),
        },
      },
    );
    const payload = recordValue(data, "issueUpdate") ?? {};
    return asJson({
      issue: issue(context, recordValue(payload, "issue") ?? {}),
    });
  }

  private async addComment(context: AdapterContext): Promise<JsonValue> {
    const data = await linearData(
      context,
      "CommentCreate",
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { ${COMMENT_SELECTION} }
        }
      }`,
      {
        input: {
          issueId: inputString(context, "issueId"),
          body: inputString(context, "body"),
        },
      },
    );
    const payload = recordValue(data, "commentCreate") ?? {};
    return asJson({
      comment: comment(context, recordValue(payload, "comment") ?? {}),
    });
  }
}

export const linearAdapter = new LinearAdapter();
