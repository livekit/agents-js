// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import type { Agent } from './agent.js';

/**
 * Simple implementation of the AgentActivity interface.
 * This is focused on receiving frames from LiveKit and printing them.
 */
export class AgentActivity {
  //   private _agent: Agent;
  //   private _currentSpeech: DefaultSpeechHandle | null = null;
  private _started = false;
  private _closed = false;
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  async start(): Promise<void> {
    if (this._started) {
      return;
    }

    this._started = true;

    console.log('Agent activity started');
  }

  /**
   * Handles incoming audio frames from LiveKit
   */
  pushAudio(frame: AudioFrame): void {
    if (!this._started || this._closed) {
      return;
    }

    // For debugging, just log the frame info
    console.log(
      `Received audio frame: sampleRate=${frame.sampleRate}, channels=${frame.channels}, samples=${frame.data.length / frame.channels}`,
    );
  }
}
