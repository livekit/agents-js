// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { setTimeout as sleep } from 'node:timers/promises';

const NONE = 'none';

const ACTION_PERSONAS = new Set(['leila', 'jess', 'mr_fox']);

const POSE_NAMES: Record<string, Record<string, string>> = {
  leila: {
    wave: 'wave-2-leila',
    turn: 'turn-leila',
    dance: 'dance-leila',
  },
  jess: {
    wave: 'jess_wave',
    turn: 'jess_turn',
    dance: 'jess_dance',
  },
  mr_fox: {
    wave: 'fox2_wave',
    turn: 'fox2_turn',
    dance: 'fox2_dance',
  },
};

const DEFAULT_POSE_DURATION = 6000;
const OPENING_WAVE_DELAY = 500;

export function supportsActions(personaId: string): boolean {
  return ACTION_PERSONAS.has(personaId);
}

function controlUrl(sessionId: string): string {
  const base = (process.env.LEMONSLICE_API_BASE ?? 'https://lemonslice.com/api').replace(/\/$/, '');
  return `${base}/liveai/sessions/${sessionId}/control`;
}

async function triggerPose(sessionId: string, name: string): Promise<boolean> {
  const response = await fetch(controlUrl(sessionId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.LEMONSLICE_API_KEY ?? '',
    },
    body: JSON.stringify({ event: 'pose-trigger', pose_trigger: { name } }),
    signal: AbortSignal.timeout(30000),
  });
  return response.ok;
}

export class ActionController {
  private sessionId: string | undefined;
  private personaId: string | undefined;
  private poseEndsAt = 0;
  private triggering = false;

  setSession(sessionId: string, personaId: string): void {
    this.sessionId = sessionId;
    this.personaId = personaId;
  }

  clearSession(): void {
    this.sessionId = undefined;
    this.personaId = undefined;
  }

  private currentPosePlaying(): boolean {
    if (Date.now() < this.poseEndsAt) {
      return true;
    }
    this.poseEndsAt = 0;
    return false;
  }

  async cancel(): Promise<void> {
    this.poseEndsAt = 0;
    this.triggering = false;
    const sid = this.sessionId;
    this.clearSession();
    if (sid !== undefined) {
      await triggerPose(sid, NONE);
    }
  }

  async shutdown(_reason = ''): Promise<void> {
    await this.cancel();
  }

  async play(actionId: string): Promise<string> {
    const sessionId = this.sessionId;
    const personaId = this.personaId;
    if (sessionId === undefined || personaId === undefined) {
      return 'Motion unavailable - avatar session not ready.';
    }

    const key = actionId.trim().toLowerCase();
    const poseName = POSE_NAMES[personaId]?.[key];
    if (poseName === undefined) {
      return `Unknown motion ${JSON.stringify(actionId)}.`;
    }

    if (this.triggering || this.currentPosePlaying()) {
      return 'That motion is already playing; try again in a moment.';
    }

    this.triggering = true;
    try {
      const ok = await triggerPose(sessionId, poseName);
      if (!ok) {
        return 'Could not trigger the motion on the avatar.';
      }

      this.poseEndsAt = Date.now() + DEFAULT_POSE_DURATION;
      return `Playing motion ${key}.`;
    } finally {
      this.triggering = false;
    }
  }

  async openingWave(): Promise<void> {
    if (OPENING_WAVE_DELAY > 0) {
      await sleep(OPENING_WAVE_DELAY);
    }
    await this.play('wave');
  }
}
