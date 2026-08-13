# Changelog

## 0.1.9

- Added first-class scoped API token auth for the control plane: set `THALOVANT_API_TOKEN` and the server authenticates with the token directly and never calls the login endpoint. Precedence is `THALOVANT_API_TOKEN`, then `THALOVANT_ACCESS_TOKEN`, then the `THALOVANT_EMAIL`/`THALOVANT_PASSWORD` login fallback.
- `thalovant_config_status` now reports the active control-plane auth mode (`controlPlaneAuthMode`: `api-token`, `access-token`, `email-password`, or `none`) and `hasApiToken`, without revealing token values.
- Documented API tokens as the recommended auth mode for AI and CI use, including the minimum token scopes for the full control-plane tool surface: `hubs:read`, `clients:write`, `memory:read`, `memory:write`.
- Clarified the unauthenticated-tool error to name `THALOVANT_API_TOKEN` as the recommended option.

## 0.1.8

- Tightened memory tool input validation to match the control-plane API exactly: `title` max 160, `content` max 4096, `source` max 64, `consentScope` max 128, `consentVersion` max 64, `retentionPolicy` max 64 on create/update, and list `query` max 240, so invalid values fail with a clear client-side error instead of an opaque API 422.
- Capped `thalovant_list_public_hubs` `limit` at 48 to match the public hubs endpoint, which silently clamps larger page sizes; authenticated `thalovant_list_hubs` keeps its limit of 100.
- Corrected `thalovant_get_hub` and `thalovant_create_client_identity` descriptions: the authenticated hub routes require a hub UUID; slugs are only accepted by the public hub tools.

## 0.1.7

- Updated the MCP transport SDK to 1.30.0, removing the affected Hono adapter dependency range.
- Updated the Thalovant Node SDK compatibility floor to 0.2.21 and refreshed the JOSE runtime dependency.
- Included the dependency and transitive security updates merged after 0.1.6.

## 0.1.6

- Publish the exact npm tarball with a durable CycloneDX SBOM and GitHub provenance and SBOM attestations.
- Publish the OCI image with SBOM and maximum provenance and verify the pinned MCP Registry publisher before execution.

## 0.1.5

- Added the public GHCR OCI package to MCP Registry metadata.
- Switched deployment image references to the repo-aligned GHCR package.

## 0.1.4

- Fixed npm bin execution when the package manager launches the server through a symlink.
- Added a symlink-based stdio smoke test for published package behavior.

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
