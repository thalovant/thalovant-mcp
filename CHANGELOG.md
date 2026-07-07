# Changelog

## 0.1.3

- Removed the generic remote URL from registry metadata; publish concrete remote entries only after a real hosted URL exists.

## 0.1.2

- Updated the server runtime version constant.
- Published MCP Registry metadata with the public npm package only; GHCR remains available but must be made public in GitHub package settings before registry inclusion.

## 0.1.1

- Normalized npm bin metadata.
- Added OCI package transport URL for MCP Registry validation.
- Updated container tags and metadata to match the registry release.

## 0.1.0

- Initial public MCP server for Thalovant.
- Added stdio transport for local MCP hosts.
- Added Streamable HTTP transport for remote MCP clients.
- Added static bearer, JWT/JWKS, and OAuth introspection auth modes.
- Added protected resource metadata discovery.
- Added per-principal Thalovant credential isolation.
- Added tool allow/deny policy.
- Added structured audit logging.
- Added in-memory and file-backed event storage.
- Added Docker, Compose, Kubernetes, CI, registry metadata, smoke tests, and benchmarks.
