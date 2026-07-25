import { describe, expect, it } from "vitest";
import { MCP_DEMO_USER_ID, runScriptedMcpDemo } from "../demo/mcp.js";
import { hasMocksCheckout, mocksSuiteTitle } from "./mocks-checkout.js";

const mocksAvailable = hasMocksCheckout();

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("scripted multi-capability MCP agent loop", mocksAvailable),
  () => {
    it("discovers and executes email, issue, and announcement tools end to end", async () => {
      const result = await runScriptedMcpDemo();

      expect(result.providerEffects).toEqual({
        emailSent: true,
        issueCreated: true,
        announcementSent: true,
      });
      expect(result.issueId).toBe("3");
      expect(result.childExecutions).toEqual([
        {
          executionId: "exe_agent_loop_1",
          tool: "gmail.send_email",
          userId: MCP_DEMO_USER_ID,
        },
        {
          executionId: "exe_agent_loop_2",
          tool: "github.create_issue",
          userId: MCP_DEMO_USER_ID,
        },
        {
          executionId: "exe_agent_loop_3",
          tool: "slack.send_message",
          userId: MCP_DEMO_USER_ID,
        },
      ]);
      expect(result.calls).toEqual([
        "eyeball.search_tools",
        "gmail.send_email",
        "eyeball.search_tools",
        "github.create_issue",
        "slack.send_message",
      ]);
      expect(
        result.calls.every(
          (name) => name.includes(".") && !name.includes("__"),
        ),
      ).toBe(true);
    });
  },
);
