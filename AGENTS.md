# Repository instructions

This repository is a first-class consumer of the Thalovant control-plane and hub runtime APIs. Read the platform contracts in `../infra-manifests/docs/thalovant-platform/` when available.

Rules:

- Use only supported public API/protocol contracts; do not bypass them with direct Kubernetes or database access.
- For every affected API/protocol change, update tool input/output schemas, validation, handlers, examples, tests, README, changelog, and compatibility metadata together.
- Keep `package.json`, `server.json`, npm package, OCI image, and configured MCP registry metadata on the same release version.
- Consume a compatible published `@thalovant/sdk` version and preserve backward compatibility through the API migration window.
- Update affected `docs.thalovant.com` MCP setup, tool reference, examples, and compatibility pages in the same release train.
- Prefer explicit, narrowly scoped tools and shared helpers only where reuse is demonstrated. Do not mirror the entire API mechanically or add speculative dependencies.

Validate with `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:smoke`, and `npm run test:http`. Build before the transport tests because they execute `dist/index.js`. An affected release is complete only after clean-install stdio and Streamable HTTP smoke tests pass against the published npm/OCI artifacts.
