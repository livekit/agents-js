# Multi-turn AMD

AMD classifies the call participant at client-side end of turn (EOT). It can
handle several screening, voicemail, and IVR turns before it completes.
The SDK owns classification, stage changes, turn hooks, and deadlines.
`AgentSession` owns the customer hook, interruption, and playback.

AMD consumes the `user_state_changed` and `user_input_transcribed` session events.
At each accepted EOT, `AgentSession` notifies AMD internally before
`onUserTurnCompleted` runs. AMD owns its turn IDs and returns turn hooks
bound to that turn. Preemptive generation prepares reply tools but only commits
an agent turn if its reply is accepted for output.
While AMD is active, `AgentSession` commits every turn. It skips the
`minWords` interruption filter, so a short transcript during agent speech
still reaches AMD. False-interruption pause and resume stay unchanged.
State events carry the accepted speech-boundary time in `speechTimestamp`,
including the STT timestamp when STT controls turn detection.

This replaces the one-shot AMD API. `execute()` now returns `AMDCompletedEvent`,
not the first `AMDPredictionEvent`: the final `category` and `reason`, whether the
voicemail message played (`voicemailMessagePlayed`), and the last classified
prediction (`lastPrediction`). Use `amd_prediction` to observe each prediction.
The application still decides whether to continue or end the call.

The example hides `end_call` while AMD is active. After voicemail playback, it
waits up to 10 seconds for another prompt (`voicemailIdleTimeout: 10_000`). AMD
handles any post-message menu before it completes. Once the message has played,
a goodbye from the box does not make the result `machine-unavailable`: AMD
completes with the stage before it, `machine-vm` or, after a menu, `machine-ivr`.
If the final result reports a played voicemail and no human, the application
shuts down the job. Human conversations can use `end_call` after AMD finishes.
The shutdown callback deletes the room and disconnects the SIP participant.

The example uses `BackgroundVoiceCancellation` from `@livekit/noise-cancellation-node`
to reduce background voices and noise before audio reaches session STT and AMD STT.
(The Python example uses ai-coustics, which has no Node plugin.) Keep SIP
`krisp_enabled` off to avoid filtering the same audio twice.

Voice isolation does not provide acoustic echo cancellation (AEC). It may reduce
echoed speech, but echo removal must be verified on a call. The session's
`aecWarmupDuration` only suppresses input briefly while client AEC starts.

## Speech timestamps

`UserStateChangedEvent.createdAt` records event-creation time. For speech timing or
response latency, use `speechTimestamp`, and fall back to `createdAt` when the speech
boundary is unknown:

```ts
const speechTime = event.speechTimestamp ?? event.createdAt;
```

Both fields use Unix time in milliseconds. A speech boundary can precede event
creation because speech detection takes time.

## Start AMD

Start `AgentSession` first. Start AMD before creating the SIP participant.
Do not generate an `onEnter` greeting before AMD starts.
Let `AgentSession` generate replies during AMD. Direct calls to `session.say()`
or `session.generateReply()` during detection are not supported.

```ts
import { log, voice } from '@livekit/agents';

const detector = new voice.AMD(session, {
  participantIdentity: calleeIdentity,
  // llm: null, // Use the active Agent's LLM instead of auto-selection.
  // stt: null, // Use only the session transcript instead of auto-selection.
});

detector.on('amd_prediction', (event) => {
  log().info(
    { turnId: event.turnId, category: event.category, reason: event.reason },
    'amd prediction',
  );
});

detector.on('amd_menu_observed', (event) => {
  recordMenu(event); // Informational. This event does not authorize an action.
});

await detector.start();
try {
  // Create the SIP participant here.
  const result = await detector.execute();
  // Choose the next call action from result.category and result.reason.
} finally {
  await detector.aclose();
}
```

`start()` and `aclose()` are the JS form of Python's `async with AMD(...)`.

By default, AMD and the Agent discard SIP pre-answer audio. Set
`waitUntilAnswered: false` to use subscribed early media. This does not cause
the SIP provider to supply early media.

`detector.lifecycle` uses `AMDLifecycle`: `INITIALIZED` before `start()`, `PENDING`
while awaiting the participant, `ACTIVE` during detection, and `FINISHED`
after detection ends.

AMD allows five seconds for the participant's audio track to be published and
subscribed. If that fails, it completes with `participant_missing` and releases
the session. A participant or room disconnect during setup completes with
`participant_disconnected`. Set the SIP answer timeout when placing the call.
The detection `timeout` starts when listening begins.

## Model selection and transcripts

- `llm` accepts `string | LLM | null | undefined`. If omitted, AMD auto-selects
  `google/gemma-4-31b-it`. Pass `null` to use the active Agent's pipeline
  LLM. A model instance or string selects a different classification and menu model.
- `stt` accepts `string | STT | null | undefined`. If omitted, AMD auto-selects
  `cartesia/ink-whisper`. Pass `null` to use only the session transcript.
  A model instance or string selects an STT for AMD only.
- Model strings use LiveKit Inference. Provider plugins can use the caller's
  own provider credentials.
- AMD creates models from strings in `start()`, after validating the session.
  It closes these models on completion or partial setup failure. It does not close
  supplied model instances. It closes its requests and STT streams in either case.

Auto-selection requires a LiveKit Cloud `LIVEKIT_URL` and an API key and secret.
AMD checks `LIVEKIT_INFERENCE_API_KEY` and `LIVEKIT_INFERENCE_API_SECRET`, with
`LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` as fallbacks. Without these settings,
omitted values inherit the Agent's LLM and session transcript. Explicit `null`
always inherits. AMD resolves `llm` and `stt` independently.

The LLM must support required function calls. AMD uses a `record_result` tool
for each prediction or menu result. It validates the tool arguments against the
result schema. This tool is not added to the active Agent.

When session STT is configured, AMD keeps both transcripts of each turn, and the
classifier sees both as JSON: `transcript_1` (session) and `transcript_2` (AMD STT).
Neither source has to win a race, so a late or missing transcript from one STT does
not empty the turn. Without session STT, AMD uses its own STT alone. Interim results
are ignored. The Agent's transcript, history, hooks, and EOT stay unchanged, and
events and the Agent use the session transcript when it is not empty.

At EOT, AMD commits each source's available transcript immediately, even if it is
empty. Finals received after EOT accumulate for the next turn. The AMD STT
must support streaming. It uses a single stream without flushing at EOT,
matching session STT. AMD receives the unsuppressed participant audio during AEC
warmup, while session STT receives silence. `AgentSession` disables AEC warmup by
default for outbound SIP calls; an explicit `aecWarmupDuration` takes precedence.
The classifier prompt treats the transcript as untrusted evidence, so echoed
agent speech cannot instruct it.

If the AMD stream fails, the open turn and subsequent turns use the session
transcript alone, even if it is empty. Committed turns stay unchanged.

Each classification uses up to 20 recent chat items, including tool calls and results.
Late transcripts become part of the next committed turn. They do not change an
in-flight request or a reply that already started.
A new turn can cancel classification work without discarding its transcript.
AMD keeps its transcripts in an independent chat context. The next request
includes those transcripts and successful DTMF tool calls and results.
An empty EOT keeps useful pending classification for the latest turn. Older AMD
reply waits exit immediately. Reusing a prediction emits an `amd_prediction`
event with `reason: 'reused'`. AMD emits one `amd_prediction` event for each
committed turn, except a turn whose classification a newer non-empty turn cancels.
The cancelled turn's transcript stays in AMD's context, so the next prediction
covers it. `turnId` values can therefore skip numbers.

## Realtime models

OpenAI Realtime can generate AMD replies when `AgentSession` controls turn detection.
Configure this before starting the session. AMD rejects server-side turn detection,
automatic tool replies, and models without per-response tool selection.

Native user transcription is optional. While AMD is active and native
transcription is disabled, committed turns use session STT for text history,
or AMD STT if session STT is not configured.

Supply a separate text LLM for classification and either session STT or AMD STT.
Realtime input transcription alone arrives after the audio commit, too late for
AMD's current turn. STT supplies the transcript; EOT commits the turn. The realtime
model still receives audio for its replies.

With session STT configured, AMD's classifier sees both its own STT's transcript
and the session's. Pass `stt: null` to AMD to use session STT alone.

```ts
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

const session = new voice.AgentSession({
  llm: new openai.realtime.RealtimeModel({ turnDetection: null }),
  vad: await silero.VAD.load(),
  turnHandling: { turnDetection: 'vad' },
});
await session.start({
  agent: new voice.Agent({ instructions: 'Call about an appointment.' }),
  room: ctx.room,
});

const detector = new voice.AMD(session, {
  llm: 'google/gemma-4-31b-it',
  stt: 'cartesia/ink-whisper',
  participantIdentity: calleeIdentity,
});
await detector.start();
try {
  // Create the SIP participant here, as in the example above.
  const result = await detector.execute();
} finally {
  await detector.aclose();
}
```

AMD sends stage instructions with each authorized response and its tool follow-ups.
These instructions do not change the realtime session's base instructions or saved
history. The DTMF tool is available only to IVR replies and their tool follow-ups.

## Stage behavior

| Prediction            | Reply behavior                                                                                          | AMD lifecycle                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `uncertain`           | Before a machine stage, permit normal reply handling. In a machine stage, keep that stage's reply rule. | Keep the current stage.                          |
| `wait`                | Skip the reply to an advertisement, promotion, or request to keep waiting.                              | Keep the current stage and pause the idle timer. |
| `machine-screening`   | Answer the screener's latest question briefly.                                                          | Continue listening for the next turn.            |
| `machine-vm`          | Deliver one complete, uninterrupted message.                                                            | Keep listening during and after playback.        |
| `machine-ivr`         | Use the actual prompt to choose DTMF or a spoken response.                                              | Continue listening for the next turn.            |
| `human`               | After a machine stage, supply temporary human instructions. Otherwise use normal Agent instructions.    | Complete AMD.                                    |
| `machine-unavailable` | Cancel held replies; do not generate a machine reply.                                                   | Complete AMD.                                    |

`uncertain` and `wait` are per-turn predictions, not stages. Each
`amd_prediction` event carries both the `category` predicted for the turn and the
`stage` AMD keeps after it; the stage changed when it differs from the previous
event's `stage`. Use `isHumanPrediction(event)` and `isMachinePrediction(event)` to
test the category.
The stage recommends the predictions for the next turn. An uncertain turn in
voicemail keeps the voicemail stage; a later screening prediction corrects it.

Each classification request includes the retained `stage`, the last accepted
prediction's turn ID, category, and reason, and `recommended_next_categories`:
the usual next predictions from the retained stage. The list guides the classifier
but does not restrict it. The model returns only a `category`.

The last accepted prediction can be `wait` or `uncertain` while the retained stage
is still voicemail, screening, or IVR. Empty-turn reuse does not replace this
prediction snapshot.

| Retained stage      | Categories outside the recommendations |
| ------------------- | -------------------------------------- |
| `machine-screening` | `machine-ivr`                          |
| `machine-vm`        | `machine-screening`                    |
| `machine-ivr`       | `machine-screening`                    |

A prediction outside the recommendations corrects an earlier machine
classification. For example, after a mistaken voicemail classification, the model
can return `machine-screening` for "Please state your name and why you are calling."
AMD accepts it and sets `correctsStage` on the `amd_prediction` event. The initial
stage recommends every category, so the first classification never corrects a stage.
Only output that does not parse as a category uses the inference-error fallback.

Corrections apply to the current accepted turn and persist into later requests.
They use the same inference deadline, silence wait, and stale-result checks as
normal predictions. They do not create another turn, wait for late transcripts,
rewrite earlier events, or reset delivered voicemail and sent DTMF.
Reused predictions keep the corrected stage without repeating `correctsStage`.

`wait` skips the current reply without a silence wait or menu extraction. While
the latest prediction is `wait`, the idle timer is paused; the overall `timeout`
still applies. Empty turns and inference failures reuse `wait`; the next
transcribed turn gets a fresh classification. A valid `wait` prediction resets
the inference-timeout and consecutive-uncertain counters. AMD completes on a
human prediction, so it does not classify later advertisements after that handoff.

Stage instructions are temporary. They do not enter the Agent's saved history.
Use `screeningInstructions`, `voicemailInstructions`, `ivrInstructions`, and
`humanInstructions` to customize them. `humanInstructions` applies to the first
human turn after a machine stage. It is skipped if no machine stage preceded the
human, including when earlier predictions were only `uncertain`.
The customer hook runs before AMD adds its instructions.
`StopResponse` and interruption remain `AgentSession` responsibilities.

The normal interruption path handles a person who speaks during a message.
Interruption does not itself authorize a reply. AMD still checks the next turn.
An uncertain prediction keeps the current stage and its reply rule. AMD
classifies again on the next transcribed turn.

Accepted predictions update the category and emit an event immediately. Replies
to screening, voicemail, and IVR wait for 1.5 seconds of continuous participant
silence. Silence before EOT and during classification counts toward the threshold.
Pipeline reply generation starts when the prediction arrives; playback and tool
execution wait for the silence. A realtime reply starts generating only after the
silence, so its model latency adds to the wait. A newer committed turn cancels a reply that still waits.
Human and initial `uncertain` replies use normal EOT timing. An unavailable result ends AMD.
Before reply authorization, new speech restarts the silence wait for the committed
turn, even if the new speech produces no accepted turn. After authorization,
`AgentSession` handles speech, silence, and interruptions. The next committed turn
pauses authorization until AMD decides whether to reply.
AMD enables interruptions on the session and current Agent when it starts,
then restores both settings when it finishes, including cancellation or setup failure.

AMD records voicemail delivery only after successful, uninterrupted audio playback.
This record survives transitions through `uncertain` and IVR, so returning to
voicemail does not send a second message. An interrupted or failed attempt can be
retried on a later voicemail turn. An attempt still playing blocks another message.

## DTMF and menus

AMD observes the session's `function_tools_executed` event and retains successful
`send_dtmf_events` calls and results in its own chat context. It does not copy the
session's transcripts or agent speech. Failed or canceled calls are omitted.
The tool throws `ToolError` when a publish fails. Calls are matched by the name
`send_dtmf_events`, including application overrides with that name. Tools with other
names are ignored. The built-in tool returns a `ToolResult` with `replyRequired: false`
after a successful send, preserving the result without requesting a follow-up reply.
Failed calls can still request a reply. DTMF completion alone neither triggers
classification nor proves that a person answered.

Menu extraction runs as separate best-effort work. It never holds a reply.
Each `amd_menu_observed` event identifies the turn and contains a menu description
and options with `label`, `dtmf`, and `spokenResponse`. AMD does not build a tree
or execute the observed menu. Extraction has a 5-second deadline and at most
20 options. A new classification cancels the previous menu request.

## Deadlines and cleanup

All durations are in milliseconds.

| Option                    | Default | Behavior                                                                                                                                           |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferenceTimeout`        | 2000    | Use the current stage on timeout; its silence rule still applies.                                                                                  |
| `machineSilenceThreshold` | 1500    | Wait for continuous silence before authorizing a machine reply. Set to `0` to disable.                                                             |
| `idleTimeout`             | 10000   | Complete after inactivity outside voicemail.                                                                                                       |
| `voicemailIdleTimeout`    | 60000   | Allow a delayed post-message menu after playback.                                                                                                  |
| `timeout`                 | 120000  | Fixed overall limit from the start of listening.                                                                                                   |
| `maxUncertainTurns`       | 3       | Complete with the current stage after this many consecutive uncertain predictions. Any other valid prediction, including `wait`, resets the count. |
| `maxInferenceTimeouts`    | 3       | Complete after this many prediction timeouts. A valid prediction resets the count.                                                                 |

At the inference deadline, AMD cancels the request and keeps the current stage.
Results that arrive after the deadline are ignored. The next transcribed turn
starts a new classification. Reaching `maxInferenceTimeouts` completes AMD
after the current stage's silence requirement.
Model errors and reused results use the same stage and silence rule.
New speech cancels the idle timer. Stage changes do not extend the overall limit.
The overall limit can end AMD during a silence wait. Without speech-end timing,
the silence wait starts at EOT.

Finishing AMD immediately clears `session.amd`, removes its listeners and turn
hooks, and releases session audio and reply authorization. Background cleanup
then cancels outstanding work and closes owned resources. `execute()` waits for
that cleanup and returns the final category and reason. Completion does not
decide the next call action.

## Run the example

The example requires a LiveKit room. Build first, then run it in `dev` mode:

```sh
pnpm build && node ./examples/src/telephony/amd.ts dev
```

To place an outbound call, also set
`SIP_PHONE_NUMBER`, `SIP_PARTICIPANT_IDENTITY`, and `LIVEKIT_OUTBOUND_TRUNK_ID`.

## Current limits

- Realtime requires session or AMD STT, a separate text classifier, client-side
  turn detection, per-response tool selection, and client-controlled tool replies.
- Agent handoff during AMD is not supported. Tool handoffs are cancelled with a
  warning. `updateAgent()` and inline `AgentTask` switches throw.
  Finish or close AMD before switching agents.
- No audio-based hold detection.
- The remote-session protocol maps screening and wait to `AMD_UNKNOWN`. Full v2
  prediction, menu, and completion fields still need protocol support.
- Classification quality needs repeated model evals. Unit tests prove routing,
  transcript ownership, deadlines, and cleanup, not model accuracy.
