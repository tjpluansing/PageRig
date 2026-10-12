# The PageRig server, with the web app built in. Build from the repository root:
#   docker build -f server/Dockerfile -t pagerig .

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
# "/" makes the app talk to the server it's served from.
RUN VITE_SERVER_URL=/ npx vite build

FROM node:22-bookworm-slim

# LibreOffice for the conversions, Chromium for saving web pages, plus common
# fonts so documents keep their look.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw chromium \
      fonts-dejavu fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/*.mjs ./
COPY server/sign ./sign
COPY --from=web /src/dist ./public
RUN mkdir -p /data && chown node /data
USER node
# Chromium's sandbox needs privileges containers don't usually have.
ENV PORT=8080 DATA_DIR=/data NODE_NO_WARNINGS=1 CHROMIUM=/usr/bin/chromium CHROMIUM_NO_SANDBOX=1
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
