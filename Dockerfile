FROM node:24.18.0-alpine3.23 AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/fake-external/package.json apps/fake-external/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/platform/package.json packages/platform/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24.18.0-alpine3.23 AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY --from=build --chown=node:node /app /app
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
