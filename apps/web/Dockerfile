FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

RUN apk upgrade --no-cache

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .

# NEXT_PUBLIC_* values are inlined into the browser bundle by `next build`, so
# they must be present at BUILD time — setting them only at container runtime
# would have no effect on the client. They are passed as build args here and
# default to empty; every consumer treats an empty value as "not configured"
# and falls back, so an unset arg behaves exactly as it did before.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_CHROME_EXTENSION_URL=""
ARG NEXT_PUBLIC_CHROME_EXTENSION_ID=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_CHROME_EXTENSION_URL=$NEXT_PUBLIC_CHROME_EXTENSION_URL \
    NEXT_PUBLIC_CHROME_EXTENSION_ID=$NEXT_PUBLIC_CHROME_EXTENSION_ID

RUN npm run build
# Standalone tracing copies runtime dependencies without the dev dependency graph.
FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
