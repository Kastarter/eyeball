import { defineCapabilityFixtures } from "../fixtures.js";

const TICKET = "2001";

export const supportFixtures = defineCapabilityFixtures("customer_support", {
  add_ticket_reply: {
    input: (context) => ({
      ticketId: context.value("TICKET_ID", TICKET),
      body: "Contract fixture public reply.",
      public: true,
    }),
  },
  assign_ticket: {
    input: (context) => ({
      ticketId: context.value("TICKET_ID", TICKET),
      assigneeId: context.value("ASSIGNEE_ID", "1002"),
    }),
  },
  create_ticket: {
    input: {
      requesterEmail: "contract-requester@example.com",
      requesterName: "Contract Requester",
      subject: "Contract fixture ticket",
      description: "Created by the canonical contract suite.",
    },
  },
  get_conversation: {
    input: (context) => ({
      conversationId: context.value("CONVERSATION_ID", TICKET),
    }),
  },
  get_ticket: {
    input: (context) => ({ ticketId: context.value("TICKET_ID", TICKET) }),
  },
  list_conversations: { input: { pageSize: 10 } },
  list_tickets: { input: { status: "open", pageSize: 10 } },
  send_conversation_reply: {
    input: (context) => ({
      conversationId: context.value("CONVERSATION_ID", TICKET),
      body: "Contract fixture conversation reply.",
      public: true,
    }),
  },
  update_ticket: {
    input: (context) => ({
      ticketId: context.value("TICKET_ID", TICKET),
      priority: "high",
    }),
  },
});
