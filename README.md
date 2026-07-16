# eyeball

eyeball is one API that gives AI agents authenticated tools.

Status: pre-alpha, under active development.

## Monorepo layout

| Path | Purpose |
| --- | --- |
| `packages/core` | Shared core primitives |
| `packages/sdk` | TypeScript SDK |
| `packages/bridge` | Provider bridge layer |
| `packages/catalog` | Tool and provider catalog |
| `apps/executor` | Tool execution service |
| `apps/mcp-gateway` | MCP gateway service |

See the [product specification](./SPEC.md) and [project documentation](./docs/).
