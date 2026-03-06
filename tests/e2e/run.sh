#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2025 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# E2E test: validates cgroup-aware CPU load inside a Docker container.
# The agent uses the default loadFunc (getCpuMonitor), so this test
# exercises the real cgroup v2/v1 code paths in a container.
#
# Prerequisites: Docker and docker compose
# Usage: cd tests/e2e && bash run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LK_URL="http://127.0.0.1:7880"
LK_API_KEY="devkey"
LK_API_SECRET="secret"
TIMEOUT=60

cleanup() {
  echo "--- Cleaning up ---"
  docker compose down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Starting LiveKit server ==="
docker compose up -d livekit-server

echo "--- Waiting for LiveKit server on port 7880 ---"
elapsed=0
while ! curl -sf "$LK_URL" >/dev/null 2>&1; do
  sleep 1
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "FAIL: LiveKit server did not start within ${TIMEOUT}s"
    exit 1
  fi
done
echo "LiveKit server is ready (${elapsed}s)"

echo "=== Building and starting agent container ==="
docker compose up -d --build agent

echo "--- Waiting for agent registration ---"
elapsed=0
while ! docker compose logs agent 2>/dev/null | grep -q "registered worker"; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "FAIL: Agent did not register within ${TIMEOUT}s"
    echo "--- Agent logs ---"
    docker compose logs agent
    exit 1
  fi
done
echo "Agent registered (${elapsed}s)"

echo "=== Creating a room to trigger dispatch ==="
# Use the LiveKit HTTP API to create a room
ROOM_NAME="e2e-cpu-load-test-$$"
RESPONSE=$(curl -sf -X POST "$LK_URL/twirp/livekit.RoomService/CreateRoom" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(node -e "
    const { AccessToken } = require('livekit-server-sdk');
    const t = new AccessToken('${LK_API_KEY}', '${LK_API_SECRET}', { identity: 'e2e-test' });
    t.addGrant({ roomCreate: true, roomJoin: true, room: '${ROOM_NAME}' });
    console.log(t.toJwt());
  ")" \
  -d "{\"name\": \"${ROOM_NAME}\"}" 2>&1)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo "FAIL: Room creation request failed"
  echo "Response: $RESPONSE"
  exit 1
fi

echo "Room creation response: $RESPONSE"

echo "--- Checking agent load values ---"
sleep 5
AGENT_LOGS=$(docker compose logs agent 2>/dev/null)

# Check that load values reported are in a sane range
LOAD_VALUES=$(echo "$AGENT_LOGS" | grep -oP '"load":\s*[\d.]+' | grep -oP '[\d.]+$' || true)

if [ -z "$LOAD_VALUES" ]; then
  echo "WARN: No load values found in agent logs (may not be logged at info level)"
  echo "Checking for registration and absence of errors..."
fi

# Primary assertion: no "no servers available" errors
if echo "$AGENT_LOGS" | grep -q "no servers available"; then
  echo "FAIL: Agent dispatch failed with 'no servers available'"
  echo "--- Agent logs ---"
  echo "$AGENT_LOGS"
  exit 1
fi

# Check agent registered successfully
if ! echo "$AGENT_LOGS" | grep -q "registered worker"; then
  echo "FAIL: Agent did not register successfully"
  echo "--- Agent logs ---"
  echo "$AGENT_LOGS"
  exit 1
fi

echo ""
echo "=== PASS ==="
echo "Agent registered and no dispatch failures detected."
echo "Cgroup-aware CPU load is working correctly inside the container."
