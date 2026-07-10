# Releasing Thalovant MCP

The npm package, OCI image, `server.json`, and MCP Registry entry use one version. A release is incomplete until both published transports pass the clean-install smoke workflow.

## Publish

1. Update `package.json`, `package-lock.json`, `server.json`, `CHANGELOG.md`, examples, and compatibility documentation to the same version.
2. Consume a compatible published `@thalovant/sdk` version.
3. Run `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:smoke`, and `npm run test:http` in that order; the transport tests execute `dist/index.js`.
4. Tag the aligned commit. The release workflow publishes npm, GHCR, and MCP Registry metadata using `NPM_TOKEN`, `GITHUB_TOKEN`, and GitHub OIDC respectively.
5. Run **Published artifacts smoke** for the released version. It installs the npm package in a clean prefix, lists tools over stdio, starts the published image, lists tools over Streamable HTTP, and verifies the latest registry entry contains both artifacts.

## Rollback

Published versions are immutable. Do not overwrite npm, OCI, or MCP Registry artifacts.

1. Deprecate a broken npm version and move `latest` to the last compatible version when necessary.
2. Pin deployments to the prior immutable OCI digest; do not rely on moving `latest` for rollback.
3. Publish a corrected patch with aligned npm, OCI, `server.json`, and MCP Registry metadata.
4. Update `docs.thalovant.com` and compatibility notes to name the replacement version.
