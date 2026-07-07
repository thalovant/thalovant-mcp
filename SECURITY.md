# Security Policy

## Supported Versions

Security fixes are applied to the current `0.x` line until a stable `1.0.0` release policy is published.

## Reporting A Vulnerability

Do not open public issues for vulnerabilities. Email security reports to `hello@thalovant.com` with:

- affected version or commit
- reproduction steps
- impact
- suggested fix, if available

## Operational Notes

- Use `MCP_HTTP_AUTH_MODE=jwt` or `MCP_HTTP_AUTH_MODE=introspection` for multi-user remote deployments.
- Use per-principal Thalovant credentials through `THALOVANT_PRINCIPAL_CREDENTIALS_FILE` or `THALOVANT_PRINCIPAL_CREDENTIALS_DIR`.
- Keep `THALOVANT_ALLOW_SHARED_CREDENTIALS=false` for multi-user deployments.
- Set exact `MCP_HTTP_ALLOWED_HOSTS` and `MCP_HTTP_ALLOWED_ORIGINS`.
- Send audit logs to your log pipeline with `MCP_AUDIT_LOG=stderr` or `MCP_AUDIT_LOG_FILE`.
