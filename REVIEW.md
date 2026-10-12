<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Review guidelines

## PII-sensitive logs and telemetry

- Report a security issue only when you can identify the sensitive value, trace a reachable path
  from its source to a log or telemetry output, and explain why that output's redaction does not
  protect it. Cite the relevant code. A string's ability to hold arbitrary text is not evidence of
  a leak. Do not flag hypothetical future callers or unused attribute constants.
- Focus on exposure introduced or changed by the PR. Read surrounding code to verify the path,
  including error formatting, handlers, and redaction processors. Do not report an unchanged path
  unless the PR makes it newly reachable or changes its protection.
- Sensitive data includes participant identities, room names, speech and transcripts, prompts and
  instructions, chat context, tool arguments and output, DTMF digits, credentials, and provider
  payload fields that carry this content.
- Ordinary diagnostics are not sensitive by default: status codes, counts, timings, model and
  provider labels, code identifiers, callback and task names, source locations, and generated
  correlation IDs. Developer-authored operational text, such as a shutdown reason, is not
  conversation content merely because a developer can customize it. Flag these values only when
  the actual source embeds sensitive data. They may appear in messages or untagged fields.
- Sensitive values must not appear in log message bodies, span names, or event names. Use a
  static message and move the value to a structured attribute instead.
- Each structured attribute that can contain a sensitive value must have a key with a whole,
  dot-delimited `pii` segment. Use `lk.pii.<name>` or the matching constant from
  `agents/src/telemetry/trace_types.ts`. Keys such as `lk.chatpii` or `lk.pii_value` are not valid
  markers. Fixed OpenTelemetry names may use the existing explicit handling in
  `agents/src/telemetry/pii.ts` instead. Check that the handling applies to the output and
  redaction settings in question.
- Apply the marker at every emission path, including logger fields, span attributes, event
  attributes, tag metadata, nested session data, and provider debug dumps. A protected span does
  not prove that a separate log is protected. Conversely, an attribute without a `pii` segment is
  not a finding when the existing processor explicitly redacts it.

### Exceptions

- Structured `error` and `err` fields, `String(error)`, stack traces, and `cause` chains are not
  violations on their own. Identify the error types that can reach the changed path and inspect
  what the actual serializer emits. Standard JavaScript stack traces do not dump local variables
  or all error properties. Stack frames and source locations alone are ordinary diagnostics.
- Distinguish connection setup from operations on an established connection. For example, a
  WebSocket handshake error can retain request headers in its attached objects. A WebSocket
  heartbeat timeout or connection reset does not inherit those headers merely because the
  connection was authenticated. Do not assume every network error carries request data.
- Storing a response in `APIError.body`, returning an error to a caller, or retaining a `cause` is
  not itself a log emission. Follow the concrete error subclass and downstream serializer: some
  message or inspection implementations include bodies or causes, while others do not. For
  automatic promise rejection logs, verify that the rejection is not handled.
- When that path exposes sensitive data, redact it at the emission boundary or use a safe wrapper
  that suppresses the sensitive cause. Preserve useful error messages and causes when they contain
  only diagnostics. Do not require type-only logging or removal of response bodies and causes
  without evidence of sensitive output.

```ts
// Correct: a numeric status is ordinary diagnostic metadata.
logger.warn({ statusCode }, 'provider request failed');

// Wrong: this event contains transcript and tool content in the message body.
logger.debug(`received provider event: ${event}`);

// Wrong: the structured key has no dot-delimited pii segment.
logger.debug({ event }, 'received provider event');

// Correct: the redactor can remove the sensitive attribute.
logger.debug({ 'lk.pii.event': event }, 'received provider event');
```
