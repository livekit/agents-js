# SPDX-FileCopyrightText: 2025 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# syntax=docker/dockerfile:1
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agents/package.json agents/
COPY plugins/silero/package.json plugins/silero/
COPY examples/package.json examples/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

CMD ["node", "tests/e2e/test_agent.mjs"]
