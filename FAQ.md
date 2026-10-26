Last Edit: Codex (exact runtime model identifier unavailable) - 2026-10-25 - Motive: Explain compatibility for the Zod security migration.

# Dependency FAQ

## Why move to Zod 4?

The patched bounded-container checks are in 4.6.6 and later. The installed MCP SDK supports Zod 4; five `z.record` calls now state their string key schema explicitly rather than using the removed Zod 3 shorthand.

## Are tool schemas byte-for-byte unchanged?

No. Record schemas are inlined and name string properties. Stripping objects no longer emit `additionalProperties: false`, but unknown properties are still stripped before handlers. UUIDs enforce standard version/variant bits (plus nil/max UUIDs), and the memory-list offset is limited to safe integers. Names, defaults, record value types and the 50-tool default catalog remain intact.

## Is the release deployed?

Not by this PR. npm/OCI publication, registry consistency, published-artifact smoke tests and production image adoption remain separate gated steps.
