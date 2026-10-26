Last Edit: Codex (exact runtime model identifier unavailable) - 2026-10-25 - Motive: Record remaining dependency release checks without changing policy.

# Follow-up

- Require the existing exact-head CI and release image security checks; do not reuse the published 0.6.5 tag for new content.
- After publishing 0.6.6, run the existing npm/OCI/registry smoke workflow before adopting its immutable image in production.
- Keep bounded inputs bounded: the Zod container fix is not a general memory cap for schemas with no `.max()` constraint. Broader input-limit design is outside this patch.
- Preserve legal-review warnings and mobile release holds; this dependency PR changes neither.
