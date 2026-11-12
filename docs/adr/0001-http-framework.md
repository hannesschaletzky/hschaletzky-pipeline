# ADR 0001: Express 5 as HTTP framework

- Status: accepted
- Date: 2026-11-12

## Context

The service exposes a small HTTP surface: a health check, OAuth endpoints and an MCP endpoint
(`/mcp`, Streamable HTTP). claude.ai custom connectors require OAuth, so the service has to act as
an OAuth 2.1 authorization server (metadata discovery, dynamic client registration, PKCE) for a
single user. Auth endpoints need rate limiting.

## Options

| Option      | For                                                                                                                                                                 | Against                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Express 5   | The official MCP TypeScript SDK ships an Express auth router (metadata, registration, PKCE validation, rate limiting) and uses Express as its reference integration | Older API, not built on web standards                                                      |
| Hono        | Small, typed, web-standard Request/Response                                                                                                                         | OAuth endpoints would have to be implemented by hand — security-critical code we would own |
| Fastify     | Fast, built-in schema validation                                                                                                                                    | No SDK auth helpers, more setup                                                            |
| `node:http` | No dependency                                                                                                                                                       | Too much hand-written plumbing                                                             |

## Decision

Express 5. The deciding factor is OAuth: reusing the SDK's maintained implementation is less code
and less risk than writing an authorization server ourselves. Performance is irrelevant at the
expected load (one user).

## Consequences

- HTTP concerns stay in `src/http/`; domain logic does not depend on Express, so switching later
  only touches that layer.
- We follow the SDK's Express integration; its version is pinned and updated via Dependabot.
