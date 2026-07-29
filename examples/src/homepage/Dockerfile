# syntax=docker/dockerfile:1
#
# SPDX-FileCopyrightText: 2026 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

ENV NODE_ENV=production

ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY agents/package.json ./agents/package.json
COPY plugins ./plugins
COPY examples/package.json examples/tsconfig.json ./examples/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter livekit-agents-examples exec livekit-agents download-files

COPY agents ./agents
COPY examples/src/homepage ./examples/src/homepage

RUN pnpm --filter livekit-agents-examples build

USER appuser

CMD ["node", "examples/dist/homepage/agent.js", "start"]
