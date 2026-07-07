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

## Local Stdio

Public hub discovery does not need Thalovant credentials. Private control-plane tools and runtime hub tools read credentials only from the MCP server environment or server-side principal credential files. Do not pass API tokens or passwords through chat or tool arguments.

```bash
export THALOVANT_ACCESS_TOKEN="..."
# or
export THALOVANT_EMAIL="you@example.com"
export THALOVANT_PASSWORD="..."

export THALOVANT_PROFILE="prod"
export THALOVANT_API_URL="https://api.thalovant.com"

npm start
```

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

```json
{
  "mcpServers": {
    "thalovant": {
      "command": "node",
      "args": ["/home/goldyfruit/Development/Thalovant/mcp/dist/index.js"],
      "env": {
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

Writes or hub events:

- `thalovant_create_client_identity`
- `thalovant_ask`
- `thalovant_send_action`
- `thalovant_send_code`
- `thalovant_emit_event`
- `thalovant_create_memory_item`
- `thalovant_update_memory_item`
- `thalovant_delete_memory_item`

Tool outputs redact credential-shaped fields. `thalovant_create_client_identity` does not return secret identity material; pass `savePath` when you want the full identity written to a local file with mode `0600`.

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
