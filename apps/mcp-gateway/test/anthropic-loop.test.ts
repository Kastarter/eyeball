import { describe, expect, it } from "vitest";
import {
  type AnthropicMessageRequest,
  type AnthropicMessageResponse,
  runAnthropicMcpLoop,
  runLiveAnthropicMcpDemo,
} from "../demo/anthropic.js";
import { createMcpDemoEnvironment } from "../demo/mcp.js";

describe("optional Anthropic MCP loop", () => {
  it("maps restricted model names to canonical MCP calls and returns canonical output", async () => {
    const environment = await createMcpDemoEnvironment("catalog");
    const requests: AnthropicMessageRequest[] = [];
    const replies: AnthropicMessageResponse[] = [
      {
        id: "msg_fixture_1",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_email",
            name: "gmail__send_email",
            input: {
              to: ["owner@acme.example"],
              subject: "Agent-loop kickoff",
              body: "The Anthropic Eyeball agent started the workflow.",
            },
          },
        ],
      },
      {
        id: "msg_fixture_2",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_issue",
            name: "github__create_issue",
            input: {
              projectId: "acme-example/eyeball-fixture",
              title: "Follow up on the Anthropic demo",
              body: "Created by the optional Anthropic MCP episode.",
              labels: ["enhancement"],
            },
          },
        ],
      },
      {
        id: "msg_fixture_3",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_slack",
            name: "slack__send_message",
            input: {
              conversationId: "C_GENERAL",
              text: "Created GitHub issue #3 after sending the kickoff email.",
            },
          },
        ],
      },
      {
        id: "msg_fixture_4",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The fixture workflow is complete." }],
      },
    ];

    const result = await runAnthropicMcpLoop({
      client: environment.client,
      anthropic: {
        async create(request) {
          requests.push(structuredClone(request));
          const reply = replies[requests.length - 1];
          if (reply === undefined) {
            throw new Error(
              "The Anthropic loop requested an extra model step.",
            );
          }
          return reply;
        },
      },
      model: "claude-fixture-model",
    });

    expect(result).toEqual({
      finalText: "The fixture workflow is complete.",
      steps: 4,
      calls: [
        {
          toolUseId: "toolu_email",
          wireName: "gmail__send_email",
          canonicalName: "gmail.send_email",
          executionId: "exe_agent_loop_1",
          isError: false,
        },
        {
          toolUseId: "toolu_issue",
          wireName: "github__create_issue",
          canonicalName: "github.create_issue",
          executionId: "exe_agent_loop_2",
          isError: false,
        },
        {
          toolUseId: "toolu_slack",
          wireName: "slack__send_message",
          canonicalName: "slack.send_message",
          executionId: "exe_agent_loop_3",
          isError: false,
        },
      ],
    });
    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      model: "claude-fixture-model",
      tools: [
        { name: "gmail__send_email" },
        { name: "github__create_issue" },
        { name: "slack__send_message" },
      ],
    });
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const emailResultMessage = secondRequest?.messages.at(-1);
    expect(emailResultMessage).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_email",
        },
      ],
    });
    const emailResult = Array.isArray(emailResultMessage?.content)
      ? emailResultMessage.content[0]
      : undefined;
    expect(JSON.parse(emailResult?.content ?? "null")).toEqual({
      messageId: "gmail_msg_000001",
      threadId: "gmail_thread_000001",
      acceptedRecipients: ["owner@acme.example"],
    });
    expect(emailResult?.content).not.toContain("executionId");
  });

  it("rejects truncated model output instead of treating it as completion", async () => {
    const environment = await createMcpDemoEnvironment("catalog");

    await expect(
      runAnthropicMcpLoop({
        client: environment.client,
        anthropic: {
          async create() {
            return {
              id: "msg_truncated",
              stop_reason: "max_tokens",
              content: [{ type: "text", text: "The workflow is not" }],
            };
          },
        },
        model: "claude-fixture-model",
      }),
    ).rejects.toThrow(
      "Anthropic stopped with max_tokens before completing the workflow.",
    );
  });
});

const liveApiKey = process.env.ANTHROPIC_API_KEY?.trim();

describe.skipIf(liveApiKey === undefined || liveApiKey.length === 0)(
  "live Anthropic MCP loop",
  () => {
    it("lets a real model complete the bounded three-tool mock workflow", async () => {
      if (liveApiKey === undefined || liveApiKey.length === 0) {
        throw new Error(
          "ANTHROPIC_API_KEY is required for the live agent test.",
        );
      }
      const result = await runLiveAnthropicMcpDemo({ apiKey: liveApiKey });

      expect(result.finalText.length).toBeGreaterThan(0);
      expect(result.calls.map(({ canonicalName }) => canonicalName)).toEqual([
        "gmail.send_email",
        "github.create_issue",
        "slack.send_message",
      ]);
      expect(result.calls.every(({ isError }) => !isError)).toBe(true);
      expect(
        result.calls.every(({ executionId }) =>
          executionId?.startsWith("exe_"),
        ),
      ).toBe(true);
    });
  },
);
