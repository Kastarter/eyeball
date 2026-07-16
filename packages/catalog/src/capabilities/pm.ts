import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "project_management_dev_tools" as const;
const VERSION = "1.0.0" as const;
const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const CREATE = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
} as const;
const UPDATE = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  async: false,
} as const;

const id = (description: string): JSONSchema202012 => ({
  type: "string",
  description,
  minLength: 1,
});
const timestamp = (description: string): JSONSchema202012 => ({
  type: "string",
  format: "date-time",
  description,
});
const strings = (description: string): JSONSchema202012 => ({
  type: "array",
  description,
  items: { type: "string", minLength: 1 },
});

const projectSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized repository, project, board, or workspace.",
  additionalProperties: false,
  required: ["projectId", "name", "kind"],
  properties: {
    projectId: id("Provider identifier of the project or repository."),
    name: id("Project display name."),
    kind: {
      type: "string",
      enum: ["project", "repository", "board", "workspace", "team"],
      description: "Normalized project container kind.",
    },
    description: { type: "string", description: "Project description." },
    state: { type: "string", description: "Provider project state." },
    private: { type: "boolean", description: "Whether access is private." },
    defaultBranch: {
      type: "string",
      description: "Default repository branch.",
    },
    webUrl: { type: "string", format: "uri", description: "Provider web URL." },
    teamIds: strings("Provider team identifiers associated with the project."),
    createdAt: timestamp("Project creation timestamp."),
    updatedAt: timestamp("Most recent project update timestamp."),
  },
});

const issueSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized issue, work item, or defect.",
  additionalProperties: false,
  required: [
    "issueId",
    "projectId",
    "title",
    "state",
    "labels",
    "assigneeIds",
    "commentCount",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    issueId: id("Provider identifier or stable issue key."),
    issueKey: {
      type: "string",
      description: "Human-readable issue number or identifier.",
    },
    projectId: id("Containing project or repository identifier."),
    title: id("Issue title."),
    body: { type: "string", description: "Issue body or description." },
    state: id("Provider issue state."),
    labels: strings("Issue labels."),
    assigneeIds: strings("Assigned user identifiers."),
    authorId: { type: "string", description: "Issue author identifier." },
    priority: {
      type: "integer",
      minimum: 0,
      description: "Provider priority value.",
    },
    commentCount: {
      type: "integer",
      minimum: 0,
      description: "Number of issue comments.",
    },
    webUrl: {
      type: "string",
      format: "uri",
      description: "Provider web URL for the issue.",
    },
    createdAt: timestamp("Issue creation timestamp."),
    updatedAt: timestamp("Most recent issue update timestamp."),
    closedAt: timestamp("Issue close timestamp."),
  },
});

const commentSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized issue comment.",
  additionalProperties: false,
  required: ["commentId", "issueId", "body", "createdAt", "updatedAt"],
  properties: {
    commentId: id("Provider identifier of the comment."),
    issueId: id("Provider identifier of the parent issue."),
    body: id("Comment content."),
    authorId: { type: "string", description: "Comment author identifier." },
    webUrl: {
      type: "string",
      format: "uri",
      description: "Provider web URL for the comment.",
    },
    createdAt: timestamp("Comment creation timestamp."),
    updatedAt: timestamp("Most recent comment update timestamp."),
  },
});

const pullRequestSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized pull or merge request.",
  additionalProperties: false,
  required: [
    "pullRequestId",
    "projectId",
    "title",
    "state",
    "merged",
    "headBranch",
    "headSha",
    "baseBranch",
    "baseSha",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    pullRequestId: id("Provider identifier or number of the pull request."),
    projectId: id("Containing repository identifier."),
    title: id("Pull-request title."),
    body: { type: "string", description: "Pull-request body." },
    state: id("Provider pull-request state."),
    merged: {
      type: "boolean",
      description: "Whether the pull request was merged.",
    },
    mergeable: {
      type: ["boolean", "null"],
      description: "Provider mergeability result when known.",
    },
    headBranch: id("Source branch."),
    headSha: id("Source commit SHA."),
    baseBranch: id("Target branch."),
    baseSha: id("Target commit SHA."),
    authorId: {
      type: "string",
      description: "Pull-request author identifier.",
    },
    webUrl: { type: "string", format: "uri", description: "Provider web URL." },
    createdAt: timestamp("Pull-request creation timestamp."),
    updatedAt: timestamp("Most recent pull-request update timestamp."),
  },
});

const commitSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized repository commit.",
  additionalProperties: false,
  required: ["sha", "message", "authoredAt"],
  properties: {
    sha: id("Commit SHA."),
    message: id("Commit message."),
    authorName: { type: "string", description: "Commit author name." },
    authorEmail: {
      type: "string",
      format: "email",
      description: "Commit author email.",
    },
    authoredAt: timestamp("Commit author timestamp."),
    webUrl: {
      type: "string",
      format: "uri",
      description: "Provider web URL for the commit.",
    },
  },
});

const listProjects = defineContract({
  capability: CAPABILITY,
  name: "list_projects",
  description:
    "List projects, repositories, boards, workspaces, or teams visible to the connection.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_projects",
    direction: "input",
    description: "Project pagination selectors.",
    properties: {
      pageSize: pageSizeProperty("projects"),
      pageToken: pageTokenProperty("project"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_projects",
    direction: "output",
    description: "One page of projects.",
    required: ["projects"],
    properties: {
      projects: {
        type: "array",
        description: "Visible projects.",
        items: projectSchema(),
      },
      nextPageToken: nextPageTokenProperty("projects"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createIssue = defineContract({
  capability: CAPABILITY,
  name: "create_issue",
  description:
    "Create an issue, work item, or defect with optional ownership and priority metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_issue",
    direction: "input",
    description: "Project and new issue fields.",
    required: ["projectId", "title"],
    properties: {
      projectId: id("Target project, repository, or team identifier."),
      title: id("Issue title."),
      body: { type: "string", description: "Issue body or description." },
      assigneeIds: strings("User identifiers to assign."),
      labels: strings("Labels to apply."),
      priority: {
        type: "integer",
        minimum: 0,
        maximum: 4,
        description: "Provider-normalized priority.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_issue",
    direction: "output",
    description: "Newly created issue.",
    required: ["issue"],
    properties: { issue: issueSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getIssue = defineContract({
  capability: CAPABILITY,
  name: "get_issue",
  description:
    "Retrieve one issue or work item by provider identifier or stable issue key.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_issue",
    direction: "input",
    description: "Project and issue identifiers.",
    required: ["projectId", "issueId"],
    properties: {
      projectId: id("Containing project or repository identifier."),
      issueId: id("Provider identifier or stable issue key."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_issue",
    direction: "output",
    description: "Requested issue.",
    required: ["issue"],
    properties: { issue: issueSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const listIssues = defineContract({
  capability: CAPABILITY,
  name: "list_issues",
  description:
    "List issues in a project or repository using state, assignee, and label filters where supported.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_issues",
    direction: "input",
    description: "Project, issue filters, and pagination.",
    required: ["projectId"],
    properties: {
      projectId: id("Project, repository, or team identifier."),
      state: { type: "string", description: "Provider issue state." },
      assigneeId: id("Assigned user identifier."),
      labels: strings("Labels every result must contain."),
      pageSize: pageSizeProperty("issues"),
      pageToken: pageTokenProperty("issue"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_issues",
    direction: "output",
    description: "One page of issues.",
    required: ["issues"],
    properties: {
      issues: {
        type: "array",
        description: "Matching issues.",
        items: issueSchema(),
      },
      nextPageToken: nextPageTokenProperty("issues"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateIssue = defineContract({
  capability: CAPABILITY,
  name: "update_issue",
  description:
    "Update issue fields, state, assignment, labels, or priority. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_issue",
      direction: "input",
      description: "Issue identifiers and fields to update.",
      required: ["projectId", "issueId"],
      properties: {
        projectId: id("Containing project or repository identifier."),
        issueId: id("Provider identifier or stable issue key."),
        title: id("Replacement issue title."),
        body: { type: "string", description: "Replacement issue body." },
        state: id("Replacement provider issue state."),
        assigneeIds: strings("Replacement assignee identifiers."),
        labels: strings("Replacement issue labels."),
        priority: {
          type: "integer",
          minimum: 0,
          maximum: 4,
          description: "Replacement priority.",
        },
      },
    }),
    minProperties: 3,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_issue",
    direction: "output",
    description: "Updated issue.",
    required: ["issue"],
    properties: { issue: issueSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const addComment = defineContract({
  capability: CAPABILITY,
  name: "add_comment",
  description:
    "Add an externally visible comment or discussion update to an issue.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_comment",
    direction: "input",
    description: "Issue identifiers and comment body.",
    required: ["projectId", "issueId", "body"],
    properties: {
      projectId: id("Containing project or repository identifier."),
      issueId: id("Provider identifier of the issue."),
      body: id("Comment content."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_comment",
    direction: "output",
    description: "Newly created comment.",
    required: ["comment"],
    properties: { comment: commentSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const taskSchema = (): JSONSchema202012 => ({
  type: "object",
  description: "A normalized task, card, or to-do.",
  additionalProperties: false,
  required: ["taskId", "projectId", "title", "completed"],
  properties: {
    taskId: id("Provider identifier of the task."),
    projectId: id("Containing project or board identifier."),
    title: id("Task title."),
    description: { type: "string", description: "Task description." },
    completed: {
      type: "boolean",
      description: "Whether the task is complete.",
    },
    state: { type: "string", description: "Provider task state." },
    assigneeIds: strings("Assigned user identifiers."),
    dueAt: timestamp("Task due timestamp."),
    createdAt: timestamp("Task creation timestamp."),
    updatedAt: timestamp("Most recent task update timestamp."),
    webUrl: { type: "string", format: "uri", description: "Provider web URL." },
  },
});

const createTask = defineContract({
  capability: CAPABILITY,
  name: "create_task",
  description: "Create a task, card, or to-do in a project container.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_task",
    direction: "input",
    description: "Project and new task fields.",
    required: ["projectId", "title"],
    properties: {
      projectId: id("Target project or board identifier."),
      title: id("Task title."),
      description: { type: "string", description: "Task description." },
      assigneeIds: strings("User identifiers to assign."),
      dueAt: timestamp("Task due timestamp."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_task",
    direction: "output",
    description: "Newly created task.",
    required: ["task"],
    properties: { task: taskSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getTask = defineContract({
  capability: CAPABILITY,
  name: "get_task",
  description: "Retrieve one task, card, or to-do and its metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_task",
    direction: "input",
    description: "Project and task identifiers.",
    required: ["projectId", "taskId"],
    properties: {
      projectId: id("Containing project or board identifier."),
      taskId: id("Provider identifier of the task."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_task",
    direction: "output",
    description: "Requested task.",
    required: ["task"],
    properties: { task: taskSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateTask = defineContract({
  capability: CAPABILITY,
  name: "update_task",
  description:
    "Update task fields, completion state, dates, or assignment. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_task",
      direction: "input",
      description: "Task identifiers and fields to update.",
      required: ["projectId", "taskId"],
      properties: {
        projectId: id("Containing project or board identifier."),
        taskId: id("Provider identifier of the task."),
        title: id("Replacement task title."),
        description: {
          type: "string",
          description: "Replacement task description.",
        },
        completed: {
          type: "boolean",
          description: "Replacement completion state.",
        },
        state: id("Replacement provider task state."),
        assigneeIds: strings("Replacement assignee identifiers."),
        dueAt: timestamp("Replacement due timestamp."),
      },
    }),
    minProperties: 3,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_task",
    direction: "output",
    description: "Updated task.",
    required: ["task"],
    properties: { task: taskSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const getPullRequest = defineContract({
  capability: CAPABILITY,
  name: "get_pull_request",
  description:
    "Retrieve one pull or merge request with review and change metadata exposed by the provider.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_pull_request",
    direction: "input",
    description: "Repository and pull-request identifiers.",
    required: ["projectId", "pullRequestId"],
    properties: {
      projectId: id("Containing repository identifier."),
      pullRequestId: id("Provider pull-request number or identifier."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_pull_request",
    direction: "output",
    description: "Requested pull request.",
    required: ["pullRequest"],
    properties: { pullRequest: pullRequestSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createPullRequestComment = defineContract({
  capability: CAPABILITY,
  name: "create_pull_request_comment",
  description:
    "Add a general or provider-supported review comment to a pull or merge request.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_pull_request_comment",
    direction: "input",
    description: "Repository, pull-request identifier, and comment body.",
    required: ["projectId", "pullRequestId", "body"],
    properties: {
      projectId: id("Containing repository identifier."),
      pullRequestId: id("Provider pull-request number or identifier."),
      body: id("Comment content."),
      path: id("Repository-relative file path for an inline comment."),
      line: {
        type: "integer",
        minimum: 1,
        description: "One-based line for an inline review comment.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_pull_request_comment",
    direction: "output",
    description: "Newly created pull-request comment.",
    required: ["comment"],
    properties: { comment: commentSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const listCommits = defineContract({
  capability: CAPABILITY,
  name: "list_commits",
  description:
    "List repository commits, optionally filtered by branch or author.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_commits",
    direction: "input",
    description: "Repository, commit filters, and pagination.",
    required: ["projectId"],
    properties: {
      projectId: id("Containing repository identifier."),
      branch: id("Branch name or commit SHA."),
      author: id("Author name, email, or provider identifier."),
      pageSize: pageSizeProperty("commits"),
      pageToken: pageTokenProperty("commit"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_commits",
    direction: "output",
    description: "One page of commits.",
    required: ["commits"],
    properties: {
      commits: {
        type: "array",
        description: "Repository commits.",
        items: commitSchema(),
      },
      nextPageToken: nextPageTokenProperty("commits"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getBuild = defineContract({
  capability: CAPABILITY,
  name: "get_build",
  description:
    "Retrieve a CI build or pipeline run and its jobs, status, and result.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_build",
    direction: "input",
    description: "Project and build identifiers.",
    required: ["projectId", "buildId"],
    properties: {
      projectId: id("Containing project or repository identifier."),
      buildId: id("Provider identifier of the build or pipeline run."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_build",
    direction: "output",
    description: "Requested build and job summary.",
    required: ["build"],
    properties: {
      build: {
        type: "object",
        additionalProperties: false,
        required: ["buildId", "projectId", "status"],
        properties: {
          buildId: id("Provider identifier of the build."),
          projectId: id("Containing project or repository identifier."),
          status: id("Provider build status."),
          result: { type: "string", description: "Terminal build result." },
          branch: { type: "string", description: "Source branch." },
          commitSha: { type: "string", description: "Source commit SHA." },
          webUrl: {
            type: "string",
            format: "uri",
            description: "Provider web URL.",
          },
          createdAt: timestamp("Build creation timestamp."),
          updatedAt: timestamp("Most recent build update timestamp."),
        },
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getDeployment = defineContract({
  capability: CAPABILITY,
  name: "get_deployment",
  description: "Retrieve a deployment or release and its environment status.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_deployment",
    direction: "input",
    description: "Project and deployment identifiers.",
    required: ["projectId", "deploymentId"],
    properties: {
      projectId: id("Containing project or repository identifier."),
      deploymentId: id("Provider identifier of the deployment or release."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_deployment",
    direction: "output",
    description: "Requested deployment and environment status.",
    required: ["deployment"],
    properties: {
      deployment: {
        type: "object",
        additionalProperties: false,
        required: ["deploymentId", "projectId", "environment", "status"],
        properties: {
          deploymentId: id("Provider identifier of the deployment."),
          projectId: id("Containing project or repository identifier."),
          environment: id("Target environment name."),
          status: id("Provider deployment status."),
          reference: {
            type: "string",
            description: "Deployed branch, tag, or commit.",
          },
          webUrl: {
            type: "string",
            format: "uri",
            description: "Provider web URL.",
          },
          createdAt: timestamp("Deployment creation timestamp."),
          updatedAt: timestamp("Most recent deployment update timestamp."),
        },
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const pmCapabilityContracts = deepFreeze([
  listProjects,
  createIssue,
  getIssue,
  listIssues,
  updateIssue,
  addComment,
  createTask,
  getTask,
  updateTask,
  getPullRequest,
  createPullRequestComment,
  listCommits,
  getBuild,
  getDeployment,
] as const satisfies readonly CapabilityToolContract[]);

type PmContract = (typeof pmCapabilityContracts)[number];
type PmContractsByName = {
  readonly [Contract in PmContract as Contract["name"]]: Contract;
};
export const pmContractsByName = deepFreeze(
  Object.fromEntries(
    pmCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as PmContractsByName,
);
