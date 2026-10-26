Last Edit: Codex (exact runtime model identifier unavailable) - 2026-10-25 - Motive: Record the scoped MCP dependency security patch.

# Quick Facts

- Prepared release: 0.6.6, based on upstream `74f70dc`; publication is separate.
- Runtime dependency fixes: body-parser 2.4.0, Zod 4.6.7, fast-uri 3.1.9.
- Thalovant SDK remains `^0.9.9`; the MCP SDK already accepts Zod 4.
- Default catalog remains 50 tools. Protocols, permissions and API destinations are unchanged.
- Validation: `npm run typecheck`, `npm run build`, `npm test -- --maxWorkers=1`, `npm run test:smoke`, `npm run test:http`, `npm audit`.
- Schema differences and release boundaries: [AUDIT.md](AUDIT.md).
