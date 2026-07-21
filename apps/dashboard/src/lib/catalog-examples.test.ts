import { defaultCatalog } from "@eyeball/catalog";
import { validateInput } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import { overviewQuickstart } from "@/src/components/pages/overview-page";
import {
  createCatalogExampleInput,
  executionEmptySnippet,
  gmailSendEmailExampleInput,
} from "./catalog-examples";
import { routeContent } from "./route-content";

function requiredTool(name: string) {
  const tool = defaultCatalog.getTool(name);
  if (tool === undefined) throw new Error(`Missing catalog tool ${name}`);
  return tool;
}

describe("dashboard catalog examples", () => {
  it("builds the displayed Gmail input from every canonical required field", () => {
    const tool = requiredTool("gmail.send_email");
    const validation = validateInput(tool, gmailSendEmailExampleInput);

    expect(validation.ok).toBe(true);
    for (const required of tool.inputSchema.required ?? []) {
      expect(gmailSendEmailExampleInput).toHaveProperty(required);
    }
    expect(gmailSendEmailExampleInput).not.toHaveProperty("text");
    expect(gmailSendEmailExampleInput).toHaveProperty("body");
  });

  it("uses the same validated input in every advertised Gmail execution", () => {
    for (const snippet of [
      overviewQuickstart,
      routeContent.executions.snippet,
      executionEmptySnippet,
    ]) {
      expect(snippet).toContain('"body"');
      expect(snippet).not.toMatch(/^\s*"text"\s*:/m);
    }
  });

  it("builds arbitrary examples from the resolved tool schema", () => {
    const tool = requiredTool("gmail.send_email");
    const input = createCatalogExampleInput(tool.name);

    expect(validateInput(tool, input).ok).toBe(true);
  });

  it("keeps the voice-agent scaffold validated against its canonical tool", () => {
    const snippet = routeContent["voice-agents"].snippet;
    const prefix = "const draft = ";
    const suffix =
      ';\n\nawait eb.tools.execute("voice-agents.create_voice_agent"';
    const start = snippet.indexOf(prefix) + prefix.length;
    const end = snippet.indexOf(suffix);
    const draft = JSON.parse(snippet.slice(start, end)) as unknown;

    expect(
      validateInput(requiredTool("voice-agents.create_voice_agent"), {
        agent: draft,
      }).ok,
    ).toBe(true);
  });
});
