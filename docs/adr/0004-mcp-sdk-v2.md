# ADR 0004: MCP SDK v2 and protocol 2026-07-28

- Status: accepted
- Date: 2026-11-13

## Context

claude.ai started probing connectors with `server/discover`, the version negotiation of MCP
protocol revision 2026-07-28. SDK v1 (`@modelcontextprotocol/sdk` 1.32, the latest v1) only knows
revisions up to 2025-11-25 and answered the probe with `400 Unsupported protocol version`.
claude.ai then sometimes stopped instead of falling back to `initialize`: the connector stayed
"connected" but showed no tools.

SDK v2 serves both eras from one endpoint. It also removed the OAuth authorization server
helpers (`mcpAuthRouter`, `OAuthServerProvider`): an MCP server is meant to be a pure resource
server, with tokens issued by a dedicated identity provider.

## Decision

- MCP: SDK v2. `createMcpHandler` (`@modelcontextprotocol/server`) with the default
  `legacy: 'stateless'`, mounted in Express through `toNodeHandler` (`@modelcontextprotocol/node`).
  A fresh server instance per request, as before; 2026-07-28 and 2025-era clients are both served.
- OAuth: the frozen `@modelcontextprotocol/server-legacy/auth` was considered as a stopgap and
  rejected in favour of a separate authorization server, see
  [ADR 0005](0005-external-authorization-server.md).

## Consequences

- Integration tests connect with both protocol eras and check the `server/discover` answer.
- This service no longer contains OAuth server code; it only verifies tokens.
