# Changelog

## Unreleased

### Fixed

- The `thalovant_ask` tool surfaces an unrecovered intent miss promptly instead of waiting out the full timeout, and still lets a fallback reply win, via `@thalovant/sdk` 0.2.35's soft-failure ask path (thalovant-python-sdk#22). Bumped the dependency floor to `^0.2.35` and refreshed the lockfile.

### Fixed

- The `thalovant_ask` tool recognises `ovos.intent.unmatched` on the bus ask path. `@thalovant/sdk` 0.2.33 fixed only the query path; the bus path (which `ask()` uses) registered handlers per event name and dropped the current OVOS intent-miss name. Bumped the dependency floor to `@thalovant/sdk ^0.2.34` and refreshed the lockfile so the npm package and OCI image ship it (thalovant-python-sdk#22).

### Fixed

- The `thalovant_ask` tool now fails fast when an utterance matches no intent. It depends on `@thalovant/sdk`, whose ask loop previously only recognised the legacy `complete_intent_failure` event and missed the current OVOS `ovos.intent.unmatched` name, so an unmatched utterance waited out the full timeout. Bumped the dependency floor to `@thalovant/sdk ^0.2.33` (which carries the fix) and refreshed the lockfile, so the published npm package and OCI image both ship it (thalovant-python-sdk#22).

### Security

- `thalovant_install_runtime_group_skill` now refuses non-catalog install sources by default. A `sourceType` other than `catalog` (notably `git` with an arbitrary `sourceRef`) can pull unvetted code into a production runtime, and the control-plane validator is format-only with no host allowlist, so it is rejected before any control-plane request unless the operator sets `THALOVANT_ENABLE_GIT_SKILL_SOURCES` (accepting `1`/`true`/`yes`/`on`), mirroring the `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` gate. `sourceType` is trimmed and case-folded before it is both checked and forwarded, so a variant such as `" Catalog "` or `"CATALOG"` cannot pass the local gate yet reach the control plane — which special-cases only the exact string `"catalog"` — as an unrecognized non-catalog source. The tool is now annotated `destructiveHint: true`, and `thalovant_config_status` reports `gitSkillSourcesEnabled`.
- `thalovant_create_client_identity` now confines the optional `savePath` to a configurable identity directory (`THALOVANT_MCP_IDENTITY_DIR`, default `<config-dir>/thalovant/identities`). Absolute paths outside the directory and `..` traversal are rejected, and the destination is validated before the identity is created in the control plane, so a model can no longer drop a `0600` credential file into a git working tree or synced folder. `thalovant_config_status` reports `identityDir`.
- `thalovant_healthcheck` output is now passed through `redactSecrets`, matching every other tool output.
- `thalovant_get_analytics_overview` no longer advertises the `admin` and (admin-only) `ownerId` arguments to the model, so it no longer teaches an admin mode that only ever 403s for non-admin callers; only the plain overview call remains. Injected `admin`/`ownerId` values are stripped and never reach the control plane.
- Extended output redaction to additional secret-ish keys: `device_code`, `user_code`, `psk`, `cert`, and `jwt`.
- Added an opt-in read-only mode (`THALOVANT_MCP_READONLY`): only tools annotated `readOnlyHint: true` are registered, so an observe-only agent needs no hand-written denylist. `thalovant_config_status` reports `readOnly`.

## 0.1.10

- Added hub-provisioning and skill-discovery tools so an agent can discover skills and provision hubs conversationally, all delegating to `@thalovant/sdk` (now `^0.2.28`).
- Discovery tools: `thalovant_list_marketplace_skills`, `thalovant_list_runtime_group_marketplace`, `thalovant_list_runtime_group_inventory`, `thalovant_list_runtime_groups`, `thalovant_get_runtime_group`, `thalovant_get_runtime_group_config`, `thalovant_get_hub_runtime_capabilities`.
- Provisioning tools: `thalovant_create_hub`, `thalovant_update_hub`, `thalovant_release_hub`, `thalovant_set_hub_rating`, `thalovant_clear_hub_rating`, `thalovant_create_runtime_group`, `thalovant_update_runtime_group`, `thalovant_update_runtime_group_config`, `thalovant_release_runtime_group`, `thalovant_install_runtime_group_skill`, `thalovant_uninstall_runtime_group_skill`.
- `thalovant_delete_hub` and `thalovant_delete_runtime_group` are **disabled by default**: they are not registered at all unless the operator sets `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`, so they never appear in `tools/list`. The existing allow/deny tool policy is a call-time filter that cannot express a default-off tool, so this is a separate registration-time gate; once enabled, the delete tools remain subject to that policy. `thalovant_config_status` now reports `destructiveToolsEnabled`.
- Mirrored the control-plane API's exact constraints in the new input schemas so invalid values fail client-side instead of as an opaque 422: hub `spec.version` required, `name` max 128, `slug` 1-191 matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, `namespace` max 128, `domain` max 255, `visibility` max 32, `capacity_profile` restricted to `standard`/`autoscaling`, hub rating 1-5, runtime group `name` max 128 and `description` max 255, runtime group `spec.replicas` 1-20, skill `skill_id` max 191, `source_ref` max 255, `version_pin` max 64, and `marketplace_skill_id` a UUID. `source_type` is intentionally left a free-form 1-32 string because the API does not constrain it to an enum.
- `thalovant_update_hub` requires an `etag` and no longer accepts `name`, `namespace`, or `domain`, which are immutable after creation; the description directs agents to read the etag from the hub resource body, since the API sends no `ETag` response header. `thalovant_delete_hub` requires an `etag` for the same reason.
- Control-plane failures on the new tools now carry actionable guidance that distinguishes `403 Insufficient scopes` (checked before the plan gate, so it can mask a plan problem), the `402 API access requires a paid plan.` gate, the distinct `402 This skill requires paid marketplace access for the tenant plan.` at skill install, `412 ETag mismatch`, and `409` idempotency-key reuse.
- Documented the scope map for the new surface — `hubs:read` for the catalog, `hubs:inspect` for runtime-group and hub runtime views, `hubs:write` plus a paid plan for provisioning — and noted that catalog browsing is not paid-gated, so a free-tier token can browse the marketplace but cannot install.

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
