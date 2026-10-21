FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json ./packages/engine/package.json
COPY apps/engine/package.json ./apps/engine/package.json
RUN npm ci
COPY . .
ARG APP_BUILD_ID
ENV APP_BUILD_ID=${APP_BUILD_ID}
# NEXT_PUBLIC_ values must exist while Next builds the browser bundle.
ARG NEXT_PUBLIC_MAPTILER_KEY=
ENV NEXT_PUBLIC_MAPTILER_KEY=${NEXT_PUBLIC_MAPTILER_KEY}
RUN npm run build:vps

FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# COPY preserves modes from the checkout, including files created with umask 077.
# The unprivileged runtime must be able to read files and traverse directories.
RUN chmod --recursive u=rwX,go=rX /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
