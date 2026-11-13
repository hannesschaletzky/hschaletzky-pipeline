# ADR 0003: Single-user OAuth with GitHub as login

- Status: superseded by [ADR 0005](0005-external-authorization-server.md)
- Date: 2026-11-12

## Context

claude.ai custom connectors authenticate with OAuth 2.1 (authorization code with PKCE, dynamic
client registration). The service has exactly one user. Every request to `/mcp` must be
authenticated; auth endpoints need rate limiting.

## Options for the login step

| Option                          | For                                                  | Against                                    |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| GitHub login, allow one user id | No password handling; the owner's GitHub 2FA applies | GitHub OAuth App and one more secret       |
| Password (scrypt) + rate limit  | No external dependency                               | No second factor, own password code        |
| Passkey (WebAuthn)              | Strongest                                            | Much more code than the time budget allows |

## Decision

The service is its own authorization server, built on the MCP SDK's `mcpAuthRouter` (metadata,
registration, PKCE validation, token and revocation endpoints, rate limiting). The login step
delegates to GitHub and admits only the configured numeric user id (stable, unlike login names).
No GitHub scopes are requested; the GitHub token is discarded after reading the user id.

- Dynamic client registration is open, as claude.ai requires, but only for allow-listed redirect
  URIs (claude.ai's callback). A registered client still cannot obtain tokens without the login.
- Access tokens (1 h) and refresh tokens (30 days, rotated on use) are random strings; only their
  SHA-256 hash is stored, in Postgres, so restarts do not log Claude out and tokens can be revoked.
- Tokens are bound to the MCP endpoint URL (RFC 8707 resource) and checked on every request.
- Pending logins and authorization codes live in memory for minutes only.

## Consequences

- A GitHub outage blocks new logins; existing tokens keep working.
- One instance only (in-memory login state). Sufficient for a single user.
