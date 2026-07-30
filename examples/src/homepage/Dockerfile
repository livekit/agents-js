# syntax=docker/dockerfile:1
#
# SPDX-FileCopyrightText: 2026 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable
RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY . .
# No download-files step: this agent reaches every model through inference, and krisp
# ships its own weights, so no plugin here implements downloadFiles. The source example
# needs it for the local silero VAD and turn detector.
RUN pnpm install --frozen-lockfile \
  && pnpm --filter livekit-agents-examples... build \
  && pnpm store prune

ENV NODE_ENV=production

ARG UID=10001
RUN useradd --create-home --uid "${UID}" --shell /usr/sbin/nologin appuser \
  && chown -R appuser:appuser /app
USER appuser

CMD ["node", "examples/dist/homepage/agent.js", "start"]
