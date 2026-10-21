FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    CLOUD_PUZZLE_DB=/app/data/cloud-puzzle.sqlite

RUN mkdir -p /app/data && chown -R node:node /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

VOLUME ["/app/data"]

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
