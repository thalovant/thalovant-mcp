# Thalovant MCP Server

Public-ready MCP server for Thalovant control-plane and hub runtime APIs.

It uses the official Thalovant Node.js SDK and the production MCP TypeScript SDK over stdio and Streamable HTTP, so it works with local MCP hosts such as Claude Desktop, Codex, Cursor, and remote MCP clients.

## What It Includes

- stdio transport for local agents.
- Streamable HTTP transport at `/mcp` for remote agents.
- OAuth-style protected resource metadata at `/.well-known/oauth-protected-resource`.
- Static bearer tokens for simple/private deployments.
- JWT/JWKS and OAuth token introspection for production remote deployments.
- Per-principal Thalovant credentials and tool policy.
- Host/origin validation, CORS, rate limiting, body limits, secure headers, and session binding.
- Optional resumability event storage and JSONL audit logs.
- Docker, Compose, Kubernetes, CI, npm package metadata, and MCP registry `server.json`.

## Why TypeScript

Thalovant publishes SDKs for Python, Node.js, Go, and Rust. This server uses Node.js because `@thalovant/sdk` directly exposes the Thalovant control plane, identity loading, WSS/HTTPS/MQTT runtime clients, memory, analytics, and context helpers, while `@modelcontextprotocol/sdk` is the best-supported path for cross-agent stdio and Streamable HTTP servers.

## Install

```bash
npm install
npm run build
```

Node.js 20 or newer is required.

## Control-Plane Auth

Public hub discovery does not need Thalovant credentials. Private control-plane tools and runtime hub tools read credentials only from the MCP server environment or server-side principal credential files. Do not pass API tokens or passwords through chat or tool arguments.

The server selects control-plane auth in this order:

1. `THALOVANT_API_TOKEN` — a scoped Thalovant API token. Recommended.
2. `THALOVANT_ACCESS_TOKEN` — a pre-issued session access token.
3. `THALOVANT_EMAIL` + `THALOVANT_PASSWORD` — interactive-account login fallback.

When a token is set, the server never calls the login endpoint. `thalovant_config_status` reports the active mode as `controlPlaneAuthMode` without revealing token values.

### API Tokens (Recommended For AI Agents And CI)

Scoped API tokens are the right credential for AI and automation use: they are minted from the Thalovant dashboard (or through the device flow), carry only the scopes you grant, can be revoked individually, and never involve your account password or MFA. Tokens start with `tvpat_`.

```bash
export THALOVANT_API_TOKEN="tvpat_..."
export THALOVANT_API_URL="https://api.thalovant.com"

npm start
```

Minimum scopes for the full control-plane tool surface:

| Scope | Used by |
|-------|---------|
| `hubs:read` | `thalovant_list_hubs`, `thalovant_get_hub`, `thalovant_get_analytics_overview`, `thalovant_list_marketplace_skills`, `thalovant_list_runtime_groups`, `thalovant_get_runtime_group`, `thalovant_get_runtime_group_config`, and the hub lookup inside `thalovant_create_client_identity` |
| `hubs:inspect` | `thalovant_get_hub_runtime_capabilities`, `thalovant_list_runtime_group_marketplace`, `thalovant_list_runtime_group_inventory` |
| `hubs:write` | All hub and runtime-group provisioning: `thalovant_create_hub`, `thalovant_update_hub`, `thalovant_release_hub`, `thalovant_create_runtime_group`, `thalovant_update_runtime_group`, `thalovant_update_runtime_group_config`, `thalovant_release_runtime_group`, `thalovant_install_runtime_group_skill`, `thalovant_uninstall_runtime_group_skill`, the hub rating tools, and the opt-in delete tools |
| `clients:write` | `thalovant_create_client_identity` (`POST /v1/clients`) |
| `memory:read` | `thalovant_list_memory_items`, `thalovant_get_memory_summary`, `thalovant_get_memory_item` |
| `memory:write` | `thalovant_create_memory_item`, `thalovant_update_memory_item`, `thalovant_delete_memory_item` |

The hub scopes imply one another: `hubs:write` grants `hubs:read`, which grants `hubs:inspect` and `hubs:preview`. Minting a token with `hubs:read` is therefore enough for every discovery tool in the table above.

Scope is not the whole story for provisioning. Every hub and runtime-group write also requires a **paid plan**, and the API checks scope *before* the plan, so the two failure modes are ordered:

- A token missing the scope fails `403 Insufficient scopes`. Free-plan API tokens are capped at `hubs:read`, `clients:read`, and `clients:write`, so on the free tier provisioning fails with this 403 and never reaches the 402.
- A correctly scoped token on a free plan fails `402 API access requires a paid plan.`
- `thalovant_install_runtime_group_skill` can fail with a **second, distinct** 402, `This skill requires paid marketplace access for the tenant plan.`, when the plan is paid but does not include `access_tier: paid` catalog entries.

Discovery is deliberately not paid-gated: **a free-tier token can browse the marketplace catalog and set hub ratings, but cannot install skills or provision hubs.** Use `thalovant_list_runtime_group_marketplace` before installing — it reports `installable`, `purchase_required`, and `access_message` per skill, which turns an opaque 402 into a decision you can make up front.

Grant fewer scopes for narrower deployments: a read-only assistant needs only `hubs:read` and `memory:read`, and a discovery-only agent that browses skills but never provisions needs `hubs:read` alone. `thalovant_get_analytics_overview` with `admin: true` additionally requires an admin account with `admin:analytics`, which API tokens for regular use should not carry. Runtime hub tools (`thalovant_ask`, `thalovant_send_action`, and friends) use Thalovant client identities, not control-plane tokens.

### Hub Etags

`thalovant_update_hub` and `thalovant_delete_hub` use optimistic locking and require the hub's current etag, sent as `If-Match`. The etag is only available in the **body** of the hub resource — the API sends no `ETag` response header — so an agent must call `thalovant_get_hub` first and pass the `etag` field from that response. A missing or stale value fails `412 ETag mismatch` and changes nothing; re-fetch and retry. `name`, `namespace`, and `domain` are immutable after creation, so `thalovant_update_hub` does not accept them at all; send only the fields you are changing rather than round-tripping a whole hub resource. Runtime-group writes do not use etags.

### Login Fallback

```bash
export THALOVANT_EMAIL="you@example.com"
export THALOVANT_PASSWORD="..."

export THALOVANT_PROFILE="prod"
export THALOVANT_API_URL="https://api.thalovant.com"

npm start
```

If neither a token nor email/password is configured, authenticated control-plane tools fail with a clear error naming the supported options.

## Local Stdio

The server speaks MCP over stdio and does not write logs to stdout.

Runtime hub tools load local identities in this order:

1. `identityFile` tool argument.
2. `configPath` or `profile` tool argument.
3. Thalovant SDK environment identity variables.
4. The default Thalovant SDK config profile.

Keep Thalovant identity files secret. The SDK expects protected config files such as `~/.config/thalovant/config.yaml` with mode `0600`.

## Streamable HTTP

Remote mode uses MCP Streamable HTTP at `/mcp` and requires bearer authentication by default.

```bash
export MCP_TRANSPORT="http"
export MCP_HTTP_HOST="127.0.0.1"
export MCP_HTTP_PORT="3000"
export MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_HTTP_ALLOWED_HOSTS="127.0.0.1:3000,localhost:3000"

npm run start:http
```

Clients connect to:

```text
http://127.0.0.1:3000/mcp
Authorization: Bearer <token>
```

Health checks are available at `/healthz` and `/readyz`.

For public deployments, set the public URL and exact host/origin allowlists:

```bash
export MCP_HTTP_HOST="0.0.0.0"
export MCP_HTTP_PORT="3000"
export MCP_PUBLIC_URL="https://mcp.example.com"
export MCP_HTTP_ALLOWED_HOSTS="mcp.example.com"
export MCP_HTTP_ALLOWED_ORIGINS="https://agent.example.com"
```

## Remote Auth

Use static bearer tokens only for local, private, or single-tenant deployments:

```bash
export MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
# or
export MCP_HTTP_AUTH_TOKENS="token-a,token-b"
```

Use JWT/JWKS for production resource-server validation:

```bash
export MCP_HTTP_AUTH_MODE="jwt"
export MCP_OAUTH_ISSUER="https://auth.example.com/"
export MCP_OAUTH_JWKS_URL="https://auth.example.com/.well-known/jwks.json"
export MCP_OAUTH_AUDIENCE="https://mcp.example.com/mcp"
export MCP_OAUTH_AUTHORIZATION_SERVERS="https://auth.example.com/"
export MCP_OAUTH_REQUIRED_SCOPES="mcp:thalovant"
```

Use introspection when your authorization server issues opaque tokens:

```bash
export MCP_HTTP_AUTH_MODE="introspection"
export MCP_OAUTH_INTROSPECTION_URL="https://auth.example.com/oauth2/introspect"
export MCP_OAUTH_CLIENT_ID="mcp-server-client"
export MCP_OAUTH_CLIENT_SECRET="..."
export MCP_OAUTH_AUDIENCE="https://mcp.example.com/mcp"
export MCP_OAUTH_AUTHORIZATION_SERVERS="https://auth.example.com/"
export MCP_OAUTH_REQUIRED_SCOPES="mcp:thalovant"
```

The server publishes protected resource metadata at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource
```

401 responses include `WWW-Authenticate` with a `resource_metadata` pointer for MCP clients that support OAuth discovery.

## Principal Credentials

For multi-user remote deployments, do not share one Thalovant access token across all MCP users. Map each authenticated MCP principal to its own Thalovant control-plane token, runtime identity, and tool policy.

Single file:

```bash
export THALOVANT_PRINCIPAL_CREDENTIALS_FILE="/run/secrets/thalovant-principals.json"
```

Directory mode:

```bash
export THALOVANT_PRINCIPAL_CREDENTIALS_DIR="/run/secrets/thalovant-principals"
```

Directory files are named `<sha256(principal-id)>.json`. The server checks the OAuth subject, principal id, and client id. See [examples/principal-credentials.sample.json](examples/principal-credentials.sample.json).

Keep this disabled for multi-user deployments unless you intentionally want every remote principal to use the server environment's Thalovant credentials:

```bash
export THALOVANT_ALLOW_SHARED_CREDENTIALS="false"
```

Runtime `identityFile`, `configPath`, `profile`, and `fromEnv` tool arguments are disabled for remote principals by default. Set `MCP_HTTP_ALLOW_CLIENT_CREDENTIAL_PATHS=true` only for trusted private deployments.

## Policy, Audit, And Resumability

Global tool policy:

```bash
export MCP_TOOL_ALLOWLIST="thalovant_*"
export MCP_TOOL_DENYLIST="thalovant_delete_memory_item"
```

Per-principal credential files may also include `allowedTools` and `deniedTools`.

Both are call-time filters, and an empty allowlist means "allow everything". They cannot make a tool default-off or hide it from `tools/list`, which is why the two destructive control-plane tools are gated separately by `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`. See [Destructive Tools](#destructive-tools).

Audit logs:

```bash
export MCP_AUDIT_LOG="stderr" # off, stderr, file, or both
export MCP_AUDIT_LOG_FILE="/var/log/thalovant-mcp/audit.jsonl"
export MCP_AUDIT_INCLUDE_ARGS="false"
```

Audit entries are JSONL and credential-shaped fields are redacted.

Streamable HTTP resumability defaults to an in-memory event store. Use a file-backed store for single-instance restarts:

```bash
export MCP_EVENT_STORE_FILE="/var/lib/thalovant-mcp/events.jsonl"
```

## HTTP Hardening

- Bearer auth is required unless `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is explicitly set.
- Host headers are allowlisted to reduce DNS rebinding risk.
- Browser `Origin` headers are rejected unless they exactly match `MCP_HTTP_ALLOWED_ORIGINS`.
- CORS exposes only MCP session/protocol headers.
- Sessions use cryptographically random ids and are bound to the authenticated principal.
- Request bodies are capped by `MCP_HTTP_MAX_BODY_BYTES`, defaulting to 1 MiB.
- Fixed-window rate limiting defaults to 120 MCP requests per minute per client address.
- Security headers include `nosniff`, `DENY` framing, no referrer, and a restrictive CSP.

Useful HTTP environment variables:

```bash
MCP_HTTP_PATH=/mcp
MCP_HTTP_RATE_LIMIT_MAX=120
MCP_HTTP_RATE_LIMIT_WINDOW_MS=60000
MCP_HTTP_SESSION_TTL_MS=3600000
MCP_HTTP_MAX_BODY_BYTES=1048576
MCP_HTTP_ENABLE_JSON_RESPONSE=false
MCP_HTTP_TRUST_PROXY=false
```

## Claude Desktop

Recommended: authenticate with a scoped API token so the MCP config never contains your account password.

```json
{
  "mcpServers": {
    "thalovant": {
      "command": "node",
      "args": ["/home/goldyfruit/Development/Thalovant/mcp/dist/index.js"],
      "env": {
        "THALOVANT_API_TOKEN": "tvpat_...",
        "THALOVANT_PROFILE": "prod"
      }
    }
  }
}
```

## Codex

Use the same stdio command in your MCP client config:

```json
{
  "mcpServers": {
    "thalovant": {
      "command": "node",
      "args": ["/home/goldyfruit/Development/Thalovant/mcp/dist/index.js"],
      "env": {
        "THALOVANT_API_TOKEN": "tvpat_...",
        "THALOVANT_PROFILE": "prod"
      }
    }
  }
}
```

## Tools

Read-only:

- `thalovant_config_status`
- `thalovant_list_public_hubs`
- `thalovant_get_public_hub`
- `thalovant_list_hubs`
- `thalovant_get_hub`
- `thalovant_identity_status`
- `thalovant_healthcheck`
- `thalovant_wait_for_event`
- `thalovant_get_analytics_overview`
- `thalovant_list_memory_items`
- `thalovant_get_memory_summary`
- `thalovant_get_memory_item`

Skill and runtime-group discovery (read-only):

- `thalovant_list_marketplace_skills`
- `thalovant_list_runtime_group_marketplace`
- `thalovant_list_runtime_group_inventory`
- `thalovant_list_runtime_groups`
- `thalovant_get_runtime_group`
- `thalovant_get_runtime_group_config`
- `thalovant_get_hub_runtime_capabilities`

Writes or hub events:

- `thalovant_create_client_identity`
- `thalovant_ask`
- `thalovant_send_action`
- `thalovant_send_code`
- `thalovant_emit_event`
- `thalovant_create_memory_item`
- `thalovant_update_memory_item`
- `thalovant_delete_memory_item`

Hub and runtime-group provisioning:

- `thalovant_create_hub`
- `thalovant_update_hub`
- `thalovant_release_hub`
- `thalovant_set_hub_rating`
- `thalovant_clear_hub_rating`
- `thalovant_create_runtime_group`
- `thalovant_update_runtime_group`
- `thalovant_update_runtime_group_config`
- `thalovant_release_runtime_group`
- `thalovant_install_runtime_group_skill`
- `thalovant_uninstall_runtime_group_skill`

Destructive, **not registered unless explicitly enabled** (see [Destructive Tools](#destructive-tools)):

- `thalovant_delete_hub`
- `thalovant_delete_runtime_group`

Tool outputs redact credential-shaped fields. `thalovant_create_client_identity` does not return secret identity material; pass `savePath` when you want the full identity written to a local file with mode `0600`. `savePath` is confined to the server's identity directory (`THALOVANT_MCP_IDENTITY_DIR`, default `<config-dir>/thalovant/identities`): pass a plain filename, since absolute paths outside that directory and `..` traversal are rejected, so a model cannot drop a credential file into a git working tree or synced folder. `thalovant_config_status` reports the active `identityDir`.

## Destructive Tools

`thalovant_delete_hub` and `thalovant_delete_runtime_group` are **disabled by default**. They are not merely blocked when called — they are never registered, so they do not appear in `tools/list` and a model cannot see or attempt them.

A long-lived control-plane token combined with an always-available delete tool is a categorically different risk from a read or update tool: deleting a hub also deletes its dependent clients and ACLs, and none of it is reversible. So these two are opt-in:

```bash
export THALOVANT_ENABLE_DESTRUCTIVE_TOOLS="true"
```

Accepted true values are `1`, `true`, `yes`, and `on`; anything else, including unset, leaves the tools off. The flag is read when a server instance is created, so restart the server (or, in Streamable HTTP mode, start a new session) after changing it. `thalovant_config_status` reports the current state as `destructiveToolsEnabled` and lists the tools the flag controls.

This is a separate mechanism from the existing tool policy, deliberately. `MCP_TOOL_ALLOWLIST` / `MCP_TOOL_DENYLIST` and the per-principal `allowedTools` / `deniedTools` are call-time filters where an empty allowlist means "allow everything"; they cannot express a tool that is off until an operator turns it on, and they cannot hide a tool from `tools/list`. Once `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` is set the delete tools are ordinary tools again and remain subject to that policy, so the two layers compose:

```bash
# Enable deletes server-wide, but deny them to everyone except trusted principals.
export THALOVANT_ENABLE_DESTRUCTIVE_TOOLS="true"
export MCP_TOOL_DENYLIST="thalovant_delete_hub,thalovant_delete_runtime_group"
```

with the trusted principal's credential file granting them back via `allowedTools`.

Deleting a hub still requires a current etag (`412` otherwise), and deleting a runtime group fails with `409` while it is the workspace default or still has hubs attached.

## Non-Catalog Skill Sources

`thalovant_install_runtime_group_skill` installs from the vetted marketplace catalog by default. Any other source — notably `sourceType: "git"` with an arbitrary `sourceRef` repository URL — pulls code the marketplace never reviewed straight into a production runtime, and the control-plane validator is format-only with no host allowlist. Because the tools are driven by a model holding a long-lived token, non-catalog sources are refused unless an operator opts in:

```bash
export THALOVANT_ENABLE_GIT_SKILL_SOURCES="true"
```

With the flag unset, a call with any `sourceType` other than `catalog` fails before any control-plane request is made. Accepted true values are `1`, `true`, `yes`, and `on`. `thalovant_config_status` reports the state as `gitSkillSourcesEnabled`. The tool is annotated `destructiveHint: true`.

## Read-Only Mode

Set `THALOVANT_MCP_READONLY=1` to register only tools annotated `readOnlyHint: true`. Write and destructive tools are then never registered and never appear in `tools/list`, so an operator can run an observe-only agent without hand-writing a denylist. Like the other registration-time gates it is read when a server instance is created; `thalovant_config_status` reports the state as `readOnly`.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run test:http
npm run bench
npm run bench:http
npm pack --dry-run
```

## License

MIT. This is the right default for a public integration server: it is permissive, compatible with the MIT Thalovant Node SDK and MCP TypeScript SDK, and does not force downstream agent or enterprise users into a reciprocal licensing model.
