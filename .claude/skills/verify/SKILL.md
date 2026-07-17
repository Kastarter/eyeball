# Verify Eyeball runtime surfaces

Run from the repository root with Node.js 24+ and pnpm 11.

## Deterministic demos

```sh
pnpm demo:mcp
pnpm demo:restaurant
env -u ANTHROPIC_API_KEY pnpm demo:anthropic
```

Confirm the MCP demo reports successful Gmail, GitHub, and Slack provider effects. Confirm the restaurant demo completes the voice session and reports successful Calendar and Gmail child executions. The no-key Anthropic probe must exit successfully with a skip message.

## Integrated local stack

```sh
EYEBALL_MOCKHOUSE_PORT=0 \
EYEBALL_EXECUTOR_PORT=0 \
EYEBALL_MCP_GATEWAY_PORT=0 \
pnpm dev:stack
```

From the printed URLs, request Mockhouse `GET /_mock/status`, executor `GET /health`, and MCP gateway `GET /health`; then execute one Gmail tool through the executor and list tools through `POST /mcp`. Stop the stack with Ctrl-C and confirm clean shutdown.

Managed sandboxes can reject TCP listeners with `listen EPERM`. That blocks socket-level verification; it is not an Eyeball runtime response. Re-run the stack step in an environment that permits loopback binding.

## Optional live-model episode

```sh
ANTHROPIC_API_KEY=... pnpm demo:anthropic
```

This uses a live model while keeping all Eyeball services and provider effects deterministic.
