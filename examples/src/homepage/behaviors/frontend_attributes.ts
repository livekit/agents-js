// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { getJobContext } from '@livekit/agents';

const inFlight = new Set<Promise<void>>();

export function frontendAttributes({
  ttsVoice,
}: {
  ttsVoice: string | null;
}): Record<string, string> {
  if (!ttsVoice) {
    return {};
  }
  return { tts_voice: ttsVoice };
}

export function publishFrontendAttributes({ ttsVoice }: { ttsVoice: string | null }): void {
  const attributes = frontendAttributes({ ttsVoice });
  if (Object.keys(attributes).length === 0) {
    return;
  }

  const ctx = getJobContext();
  const publish = (async () => {
    await ctx.connect();
    const { localParticipant } = ctx.room;
    if (!localParticipant) {
      throw new Error('local participant is unavailable after connecting');
    }
    await localParticipant.setAttributes(attributes);
  })();

  inFlight.add(publish);
  publish.finally(() => inFlight.delete(publish)).catch(() => {});
}
