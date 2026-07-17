import { defineCapabilityFixtures } from "../fixtures.js";

function project(provider: string): string {
  return provider === "github"
    ? "acme-example/eyeball-fixture"
    : "linear_project_000001";
}

function issue(provider: string): string {
  return provider === "github" ? "1" : "linear_issue_000001";
}

export const projectManagementFixtures = defineCapabilityFixtures(
  "project_management_dev_tools",
  {
    add_comment: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        issueId: context.value("ISSUE_ID", issue(context.provider)),
        body: "Canonical contract fixture comment.",
      }),
    },
    create_issue: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        title: "Contract fixture issue",
        body: "Created by the canonical contract suite.",
      }),
    },
    create_pull_request_comment: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        pullRequestId: context.value("PULL_REQUEST_ID", "7"),
        body: "Canonical contract pull request comment.",
      }),
    },
    create_task: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        title: "Contract fixture task",
      }),
    },
    get_build: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        buildId: context.value("BUILD_ID", "contract-build"),
      }),
    },
    get_deployment: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        deploymentId: context.value("DEPLOYMENT_ID", "contract-deployment"),
      }),
    },
    get_issue: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        issueId: context.value("ISSUE_ID", issue(context.provider)),
      }),
    },
    get_pull_request: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        pullRequestId: context.value("PULL_REQUEST_ID", "7"),
      }),
    },
    get_task: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        taskId: context.value("TASK_ID", "contract-task"),
      }),
    },
    list_commits: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        pageSize: 10,
      }),
    },
    list_issues: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        pageSize: 10,
      }),
    },
    list_projects: { input: { pageSize: 10 } },
    update_issue: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        issueId: context.value("ISSUE_ID", issue(context.provider)),
        title: "Contract fixture issue updated",
      }),
    },
    update_task: {
      input: (context) => ({
        projectId: context.value("PROJECT_ID", project(context.provider)),
        taskId: context.value("TASK_ID", "contract-task"),
        completed: true,
      }),
    },
  },
);
