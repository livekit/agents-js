---
'@livekit/agents': patch
---

Serialize the session report's `events` and `usage` arrays in snake_case to match the Python session-report schema. Event fields (`old_state`, `new_state`, `is_final`, `speaker_id`, `function_calls`, `created_at`, …) and model-usage fields (`input_tokens`, `session_duration`, `audio_duration`, `characters_count`, `total_requests`, …) previously leaked camelCase keys, so LiveKit Cloud's Python parser dropped them. Usage durations are now emitted in seconds (matching the proto wire format and Python model). Also adds the `audio_recording_path`, `audio_recording_started_at`, `sdk_version`, and `options.user_away_timeout` fields to match Python's `SessionReport.to_dict()`.
