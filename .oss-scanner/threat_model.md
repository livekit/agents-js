<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveKit Agents for Node.js threat model

LiveKit Agents for Node.js (`@livekit/agents`) is the TypeScript port of the
LiveKit Agents framework for realtime voice and multimodal AI agents. An agent
server (worker) registers with a LiveKit server over a websocket, accepts job
assignments, and runs each job in a forked Node.js child process that joins a
LiveKit room. Inside the job, an `AgentSession` turns participant audio, text,
and data into STT, LLM, and TTS calls through provider plugins
(`@livekit/agents-plugin-*`), runs the developer's function tools, and
publishes audio and transcripts back to the room.

## Scope and trust boundaries

Audit the hand-written TypeScript on `main`. The repository has about 40
plugins, too many to cover evenly, so focus on the `agents/` core and the
representative plugins listed below. Prioritise these paths under
`agents/src/`:

- `voice/room_io/`: participant linking (`participantIdentity`,
  `participantKinds`, the `lk.publish_on_behalf` attribute), participant audio
  input, and chat text streams on the `lk.chat` topic.
- `voice/remote_session.ts`: the session-host protocol (`SessionHost`,
  `RoomSessionTransport`, `TcpSessionTransport`). Room participants send it
  `AgentSessionMessage` protobufs as byte streams on the `lk.agent.session`
  topic. Requests include `runInput`, `getChatHistory`, `getAgentInfo`,
  `getSessionState`, `getSessionUsage`, `updateIo`, and `finalizeSimulation`.
- `voice/avatar/datastream_io.ts`: avatar audio output over `lk.audio_stream`,
  and the `lk.playback_started` and `lk.playback_finished` RPCs.
- `llm/utils.ts` (`parseFunctionArguments`, `executeFunctionCall`),
  `llm/tool_context.ts`, `llm/zod-utils.ts`, `voice/generation.ts`,
  `voice/tool_executor.ts`, and `llm/provider_format/`. Together these parse
  LLM tool-call arguments and bind them to tool functions: strict
  `JSON.parse`, then `jsonrepair`, then Zod validation for Zod-schema tools.
  `llm/mcp.ts` handles MCP tool results.
- `worker.ts` and `http_server.ts`: the worker protocol (register,
  availability, assignment, termination), job-token handling, and the health
  server. The health server serves `/` and `/worker` without authentication.
  It binds to `0.0.0.0` by default, on port 8081 in production mode.
- `ipc/`: the worker forks job processes and a shared inference process (for
  example, the turn detector) with `child_process.fork` and exchanges JSON
  messages with them. The worker and its child processes are one trust domain,
  since all of them run developer code. A finding there needs participant- or
  provider-controlled data to cross into the worker or the shared inference
  process. Strings inside messages are not enough.
- `audio.ts`, `utils.ts`, `llm/utils.ts` (image encoding with `sharp`),
  `voice/recorder_io/`, and `ffmpeg.ts`: audio framing and resampling, image
  encoding, and ffmpeg invocation.
- `inference/`: websocket and HTTP clients for the LiveKit inference gateway
  (LLM, STT, TTS, realtime, end-of-turn, and interruption detection).
- `telemetry/`, `log.ts`, and `utils.ts`: redaction of credentials and PII in
  logs, traces, and exported session reports.
- Representative plugins: `plugins/openai` (LLM, realtime, responses, tools),
  `plugins/deepgram` (STT websocket), `plugins/cartesia` (TTS websocket),
  `plugins/silero` (local ONNX VAD), and `plugins/livekit` (turn detector:
  HuggingFace model download, cache lookup, and local inference).

Out of scope: `examples/`, `tests/e2e/`, `scripts/`, `patches/`, `.github/`,
`plugins/test` (a private test harness), generated protobuf code, and
`*.test.ts` files. Report a bug in another plugin when it matches a pattern
listed here.

Untrusted input:

- Anything another room participant controls: audio and video tracks, data
  packets, text and byte streams, RPC invocations and payloads, and
  participant identity, attributes, and metadata.
- User speech and text that reach LLM prompts, and therefore the tool-call
  names and arguments an LLM emits.
- Job metadata and dispatch fields the server relays. The server is trusted,
  but these values can originate from an end user's token or a dispatch
  request.

Semi-trusted: responses from third-party STT, TTS, LLM, avatar, and MCP
providers, and from the inference gateway. Treat them as authentic but possibly
malformed. A malformed response may fail the request, but it must not crash
the worker or corrupt another session.

Trusted: the agent developer's code and configuration, including tool
definitions, instructions, plugin options, MCP server URLs, and file paths
such as background audio. Also trusted: API keys and secrets, the LiveKit
server and the worker websocket (authenticated with the API key and secret;
the job assignment token is a signed JWT), the local console client that
connects over TCP, and the local machine and filesystem.

The LiveKit server (`livekit/livekit`) is enrolled separately. Report bugs in
how the server authorises participants there. Report bugs in how this
framework handles what participants send here. The Python framework
(`livekit/agents`) has its own threat model.

## Security properties

- **Participant isolation:** once a session is linked to a participant, input
  from other participants must not drive it. This covers audio, `lk.chat`
  text, avatar RPCs from an unexpected caller, and session-host requests.
  Participants that publish on the agent's behalf, or whose kind isn't
  accepted, must not become the linked participant.
- **Session host:** a session started with a room registers a session host.
  While no participant is linked, any room participant can send requests,
  and responses and events are broadcast to the room. Once a participant is
  linked, only that identity may send requests, and responses and events
  must target that identity. Bypassing this identity filter is a finding.
  Requests must not exceed their documented effect, for example by leaking
  secrets or API keys or reading another session's state.
- **Tool boundaries:** the LLM can call only the tools registered on the
  current agent. For Zod-schema tools, arguments must pass Zod validation.
  Tools defined with raw JSON schemas, including MCP tools, receive parsed
  arguments without framework schema validation by design. The developer's
  tool handler or the MCP server is responsible for validating those arguments.
  Repaired or malformed arguments must not bypass Zod validation or select
  an unregistered tool. Framework context such as `RunContext` is passed outside
  the LLM arguments, and the arguments must not be able to replace it.
- **Parsing:** protobuf, JSON, audio, and image input from participants or
  providers must not crash the worker, block the event loop, or allocate
  without bound. Watch byte and text streams that are buffered in full before
  parsing. Keys in untrusted JSON must not pollute prototypes.
- **Worker:** a job's crash, uncaught exception, unhandled rejection, or hang
  must not take down the worker, the shared inference process, or other jobs.
  The health endpoints must not expose secrets or allow any state change.
- **Secrets:** API keys, API secrets, worker tokens, and provider credentials
  must not appear in logs, traces, exception messages, health output, session
  reports, or data sent to the room. With redaction enabled, user PII must not
  reach telemetry. Tests that encode part of this include
  `agents/src/utils.test.ts` (websocket handshake credential redaction),
  `agents/src/telemetry/pii.test.ts`, `agents/src/telemetry/traces.test.ts`,
  and `agents/src/log.test.ts`.
- **Files and URLs:** participant-supplied values must not choose local file
  paths, ffmpeg inputs, or model cache paths, or make the agent fetch local
  files or internal addresses.

## Severity guidance

Prompt injection is inherent to LLMs. "The LLM can be talked into calling a
tool or saying something" is not a finding. It becomes one when the framework
itself mishandles the boundary: running a tool that isn't registered, bypassing
Zod-schema argument validation, leaking secrets into the prompt or the
room, or treating LLM output as trusted code or paths.

- **Critical:** remote code execution or arbitrary file read/write in the
  worker or a child process from a room participant or provider response.
- **High:** a room participant drives or reads a session the framework says it
  can't (an identity-filter bypass); tool-call handling that runs an
  unregistered tool or skips Zod-schema validation; prototype pollution reachable
  from participant or provider input; API secrets or provider keys leaked to
  the room, logs, or health output; a crash or hang of the worker or the shared
  inference process (not just one job) reachable from a participant or
  provider; SSRF to internal addresses or local files from participant input.
- **Medium:** a crash, hang, or unbounded memory in one job process from a
  participant or a malformed provider response; PII that escapes redaction
  while redaction is on; unauthenticated health endpoints exposing more than
  status and worker info.
- **Low / not a finding:** prompt injection that stays within the registered
  tools and their schemas; raw JSON-schema/MCP tools receiving arguments without
  framework schema validation; information the session host returns to
  permitted participants by design; issues that need the developer's code,
  config, or secrets; malformed messages only the LiveKit server can send;
  examples and tests; provider-side bugs.

## Testing

The checkout is at `/src`. Node 24 and pnpm 11.13.1 are installed.
`pnpm install --frozen-lockfile --ignore-scripts` and `pnpm build` ran during
the image build, so every package has a `dist/`. `npm_config_offline` and
`pnpm_config_offline` are set. For both turn-detector revisions, the ONNX model
and `languages.json` are in
`/root/.cache/huggingface/hub/models--livekit--turn-detector`, and the
tokenizers are in the transformers.js default cache. The default-revision
tokenizer metadata is also cached because transformers.js 4.2 probes it even
when loading a pinned revision. The image build verifies that both turn
detectors and their language files load with networking disabled. Native addons
(`@livekit/rtc-node`, `@livekit/local-inference`, `@livekit/blingfire`,
`@livekit/av` with its bundled ffmpeg, `sharp`, `onnxruntime-node`) use
prebuilt binaries. No provider API keys are present.

```sh
cd /src
# the CI gate (.github/workflows/test.yml, minus the credentialed inference step)
pnpm test agents/src plugins/openai/src/realtime plugins/xai/src/realtime --silent
pnpm test agents/src/llm/utils.test.ts agents/src/llm/tool_context.test.ts agents/src/voice/generation_tools.test.ts agents/src/voice/tool_executor.test.ts
pnpm test agents/src/voice/remote_session.test.ts agents/src/voice/room_session_transport.test.ts agents/src/voice/tcp_session_transport.test.ts agents/src/voice/session_host_lifecycle.test.ts
pnpm test agents/src/voice/room_io agents/src/voice/avatar
pnpm test agents/src -t "chat context"
```

Vitest runs the TypeScript sources directly, but plugins import
`@livekit/agents` from `agents/dist`. After editing the core, run
`pnpm build:agents` before running plugin tests. Tests in
`agents/src/inference/{llm,realtime,stt,tts}.test.ts` skip unless
`LIVEKIT_INFERENCE_TESTS=1` and credentials are set. Most other plugin tests
need provider keys or network access and are not part of the CI gate.

Fakes for driving an `AgentSession` without providers:
`agents/src/voice/testing/fake_llm.ts` (`FakeLLM`),
`agents/src/stt/testing/fake_stt.ts`, the remote-session helpers in
`agents/src/voice/testing/`, and `agents/src/llm/mcp_test_helpers.ts`.

The build runs `git lfs pull`. If that failed, `plugins/silero/src/silero_vad.onnx`
and `plugins/test/src/long.wav` are LFS pointer files. The CI test subset does
not read them.

## Reports

State the attacker's position: room participant (and with which
permissions), provider response, LLM output from injected input, or server.
Give the entry point (a topic, RPC method, or message type) and the
demonstrated impact. Provide a minimal reproducer, preferably a Vitest file
next to the affected module (`*.test.ts`) that uses the existing fakes.
