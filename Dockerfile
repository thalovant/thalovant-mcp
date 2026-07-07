FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=3000
LABEL org.opencontainers.image.title="Thalovant MCP Server"
LABEL org.opencontainers.image.description="Stdio and Streamable HTTP MCP server for Thalovant."
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/thalovant/thalovant-mcp"
LABEL org.opencontainers.image.url="https://github.com/thalovant/thalovant-mcp"
LABEL org.opencontainers.image.version="0.1.1"
LABEL io.modelcontextprotocol.server.name="io.github.thalovant/thalovant-mcp"
RUN addgroup -S thalovant && adduser -S thalovant -G thalovant
COPY --from=build --chown=thalovant:thalovant /app/package.json ./package.json
COPY --from=build --chown=thalovant:thalovant /app/node_modules ./node_modules
COPY --from=build --chown=thalovant:thalovant /app/dist ./dist
USER thalovant
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http"]
