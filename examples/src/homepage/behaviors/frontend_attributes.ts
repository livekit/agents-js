// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext } from '@livekit/agents';

export function frontendAttributes({
  ttsVoice,
}: {
  ttsVoice?: string | null;
}): Record<string, string> {
  return ttsVoice ? { tts_voice: ttsVoice } : {};
}

/** Publish configuration that the session byte stream cannot carry. */
export async function publishFrontendAttributes({
  ttsVoice,
}: {
  ttsVoice?: string | null;
}): Promise<void> {
  const attributes = frontendAttributes({ ttsVoice });
  if (Object.keys(attributes).length === 0) return;

  const ctx = getJobContext();
  const participant = ctx.room.localParticipant;
  if (!participant) throw new Error('local participant is unavailable after connecting');
  await participant.setAttributes(attributes);
}
