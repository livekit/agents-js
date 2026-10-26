// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents';

/** Supply fixed stream metadata and forward events to the owning Rime TTS. */
export class StreamTTS extends tts.TTS {
  label: string;
  private streamModel: string;
  private streamProvider: string;

  constructor(parent: tts.TTS, model: string, sampleRate: number) {
    super(sampleRate, parent.numChannels, parent.capabilities);
    this.label = parent.label;
    this.streamModel = model;
    this.streamProvider = parent.provider;
    this.on('metrics_collected', (metrics) => parent.emit('metrics_collected', metrics));
    this.on('error', (error) => parent.emit('error', error));
  }

  override get model() {
    return this.streamModel;
  }

  override get provider() {
    return this.streamProvider;
  }

  synthesize(): tts.ChunkedStream {
    throw new Error('Synthesis is owned by the Rime transport');
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Synthesis is owned by the Rime transport');
  }
}
