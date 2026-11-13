# ADR 0005: Tokens from a separate authorization server

- Status: accepted
- Date: 2026-11-13
- Supersedes: [ADR 0003](0003-single-user-oauth-via-github.md)

## Context

Until now this service was its own OAuth authorization server (ADR 0003), built on the MCP SDK's
`mcpAuthRouter`. SDK v2 removed those helpers (ADR 0004). More connectors are planned that need the
same login.

## Decision

- [hschaletzky-auth](https://github.com/hannesschaletzky/hschaletzky-auth) issues tokens for all
  services (Better Auth, GitHub login with an id allowlist).
- This service is a resource server only:
  - `/.well-known/oauth-protected-resource[/mcp]` names the authorization server (RFC 9728);
    unauthenticated requests get a `401` with that location, which is how claude.ai finds it.
  - Access tokens are JWTs verified locally with `jose` against the issuer's JWKS: signature,
    `iss`, `aud` = `<PUBLIC_BASE_URL>/mcp`, `typ` = `at+jwt`, `exp`. Keys are cached.
- The `oauth_clients` and `oauth_tokens` tables and the GitHub OAuth App settings are removed.

## Consequences

- No OAuth server code, GitHub credentials or token storage here anymore.
- `/mcp` depends on the authorization server only for key fetches (cached), not per request.
- A stolen access token cannot be revoked here before it expires (≤ 1 h); see the token ADR in
  hschaletzky-auth.
