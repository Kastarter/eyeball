export const HEADLINE_CANDIDATES = [
  "One API that unblocks agents.",
  "Ship agents, not integrations.",
  "Every tool your agent needs. One API.",
] as const;

export const SELECTED_HEADLINE = HEADLINE_CANDIDATES[0];

export const DX_CODE = `import { Eyeball } from "@eyeball/sdk";

const eyeball = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
});
const userId = "user_123";

// 1 — Connect an end user
await eyeball.connections.create({ userId, toolkit: "gmail" });

// 2 — Get tools for your framework
const { tools } = await eyeball.tools.get({
  toolkits: ["gmail", "slack"],
  format: "anthropic",
});

// 3 — Execute through eyeball
const result = await eyeball.tools.execute("gmail.send_email", {
  userId,
  input: {
    to: ["guest@example.com"],
    subject: "Hello",
    body: "Dinner is at 7.",
  },
});`;

export const RESTAURANT_TRANSCRIPT = [
  {
    id: "caller-request",
    kind: "turn",
    speaker: "Caller",
    text: "Tomorrow at 7, a table for four under Sam.",
  },
  {
    id: "agent-plan",
    kind: "turn",
    speaker: "Table Host",
    text: "I’ll reserve the table and send your confirmation.",
  },
  {
    id: "availability",
    kind: "tool",
    tool: "check_availability",
    detail: "tomorrow · 7:00 PM · available",
  },
  {
    id: "reservation",
    kind: "tool",
    tool: "create_reservation",
    detail: "google-calendar.create_event · succeeded",
  },
  {
    id: "caller-email",
    kind: "turn",
    speaker: "Caller",
    text: "Email sam@example.com with the confirmation.",
  },
  {
    id: "confirmation",
    kind: "tool",
    tool: "send_email",
    detail: "gmail.send_email · confirmation sent",
  },
  {
    id: "agent-confirmed",
    kind: "turn",
    speaker: "Table Host",
    text: "Your table is confirmed and the email is on its way.",
  },
] as const;
