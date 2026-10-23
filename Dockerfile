FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Keep dump/restore tools on PostgreSQL's major version. Node uses the same Debian ABI.
FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 miracle && useradd --uid 1000 --gid 1000 --no-create-home miracle
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY scripts/container-entrypoint.mjs scripts/local-state.mjs ./scripts/
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=build /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
EXPOSE 3001
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
CMD []
