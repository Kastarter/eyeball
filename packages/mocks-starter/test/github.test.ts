import { describe, expect, it } from "vitest";
import { createGitHubMock } from "../src/providers/github.js";

const authorization = { authorization: "Bearer fixture:valid" };
const repositoryPath = "/repos/example-org/github-mock-repository";

async function seedDefault(
  provider: ReturnType<typeof createGitHubMock>,
): Promise<void> {
  const response = await provider.app.request("/_mock/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle: "default" }),
  });

  expect(response.status).toBe(200);
}

function jsonRequest(method: "PATCH" | "POST", body: unknown): RequestInit {
  return {
    method,
    headers: {
      ...authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("GitHub starter provider", () => {
  it("requires bearer authentication and lists seeded repositories", async () => {
    const provider = createGitHubMock();

    const missingAuth = await provider.app.request("/user/repos");
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toEqual({
      message: "A bearer token is required.",
      documentation_url: "https://docs.github.com/rest",
    });

    await seedDefault(provider);
    const response = await provider.app.request("/user/repos", {
      headers: authorization,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject([
      {
        id: 1001,
        full_name: "example-org/github-mock-repository",
        default_branch: "main",
      },
    ]);
  });

  it("creates and updates issues with canonical GitHub response fields", async () => {
    const provider = createGitHubMock();
    await seedDefault(provider);

    const createdResponse = await provider.app.request(
      `${repositoryPath}/issues`,
      jsonRequest("POST", {
        title: "Verify public GitHub adapter",
        body: "Exercise issue lifecycle through the starter mock.",
        labels: ["fixtures"],
        assignees: ["fixture-assignee"],
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      number: number;
      state: string;
      labels: Array<{ name: string }>;
    };
    expect(created).toMatchObject({
      number: 3,
      state: "open",
      labels: [{ name: "fixtures" }],
    });

    const updatedResponse = await provider.app.request(
      `${repositoryPath}/issues/${created.number}`,
      jsonRequest("PATCH", {
        state: "closed",
        title: "Verified public GitHub adapter",
      }),
    );

    expect(updatedResponse.status).toBe(200);
    await expect(updatedResponse.json()).resolves.toMatchObject({
      number: 3,
      title: "Verified public GitHub adapter",
      state: "closed",
      closed_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("filters commits by branch and returns pull-request branch metadata", async () => {
    const provider = createGitHubMock();
    await seedDefault(provider);

    const pullResponse = await provider.app.request(
      `${repositoryPath}/pulls/7`,
      { headers: authorization },
    );
    expect(pullResponse.status).toBe(200);
    await expect(pullResponse.json()).resolves.toMatchObject({
      number: 7,
      head: { ref: "feature/mock-fixtures" },
      base: { ref: "main" },
    });

    const commitsResponse = await provider.app.request(
      `${repositoryPath}/commits?sha=main`,
      { headers: authorization },
    );
    expect(commitsResponse.status).toBe(200);
    await expect(commitsResponse.json()).resolves.toMatchObject([
      {
        sha: "fixture-sha-main-0001",
        commit: {
          message: "Initialize deterministic mock fixtures",
          author: { email: "fixture-author@example.com" },
        },
      },
    ]);
  });
});
