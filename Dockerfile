# FlickSync relay — a single Node process, no database.
FROM node:22-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY web ./web

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/src/index.js"]
