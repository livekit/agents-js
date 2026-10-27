// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Attribute session and AMD STT transcripts to committed turns without access to AgentSession. */
import type { AudioFrame } from '@livekit/rtc-node';
import { log } from '../../log.js';
import { type STT, SpeechEventType, type SpeechStream } from '../../stt/stt.js';
import type { APIConnectOptions } from '../../types.js';
import { AMDTranscript, type AMDTranscriptSource } from './chat_context.js';

/** Buffer a turn's session and AMD transcripts. */
export class AMDTurnTranscriptAccumulator {
  private transcripts: Record<AMDTranscriptSource, string> = { session: '', amd: '' };

  get(source: AMDTranscriptSource): string {
    return this.transcripts[source];
  }

  add(source: AMDTranscriptSource, transcript: string, { replace = false } = {}): void {
    transcript = transcript.trim();
    if (!transcript) {
      return;
    }
    this.transcripts[source] = replace
      ? transcript
      : `${this.transcripts[source]} ${transcript}`.trim();
  }
}

/**
 * Collect each turn's session transcript and, with an AMD STT, its own transcript too.
 *
 * Neither source wins: the classifier sees both, so a late or missing transcript from
 * one STT does not empty the turn. Without session STT, AMD uses its own transcript
 * alone. If the AMD stream fails, turns fall back to the session transcript alone.
 */
export class AMDTranscriber {
  private sessionEnabled: boolean;
  private amdEnabled: boolean;
  private current = new AMDTurnTranscriptAccumulator();
  private stream: SpeechStream | undefined;
  private readTask: Promise<void> | undefined;
  private logger = log();

  constructor(
    private readonly model: STT | undefined,
    private readonly connOptions: APIConnectOptions,
    { sessionStt = true }: { sessionStt?: boolean } = {},
  ) {
    this.sessionEnabled = sessionStt || model === undefined;
    this.amdEnabled = model !== undefined;
  }

  /** Whether the optional AMD stream can still receive audio. */
  get amdSttActive(): boolean {
    return this.amdEnabled;
  }

  pushAudio(frame: AudioFrame): void {
    if (!this.amdSttActive) {
      return;
    }
    try {
      if (this.stream === undefined) {
        const stream = this.model!.stream({ connOptions: this.connOptions });
        this.stream = stream;
        this.readTask = this.read(stream);
      }
      this.stream.pushFrame(frame);
    } catch (error) {
      this.fail(error);
    }
  }

  private async read(stream: SpeechStream): Promise<void> {
    try {
      for await (const event of stream) {
        const text = event.alternatives?.[0]?.text;
        if (event.type === SpeechEventType.FINAL_TRANSCRIPT && text !== undefined) {
          this.pushTranscript(text.trim(), { source: 'amd' });
        }
      }
      if (stream.terminalError !== undefined) {
        throw stream.terminalError;
      }
    } catch (error) {
      this.fail(error);
    } finally {
      stream.close();
    }
  }

  pushTranscript(
    transcript: string,
    {
      replace = false,
      source = 'session',
    }: { replace?: boolean; source?: AMDTranscriptSource } = {},
  ): void {
    this.current.add(source, transcript, { replace });
  }

  endTurn(sessionTranscript: string): AMDTranscript {
    this.pushTranscript(sessionTranscript, { replace: true, source: 'session' });
    const turn = this.current;
    this.current = new AMDTurnTranscriptAccumulator();
    return new AMDTranscript(
      this.sessionEnabled ? turn.get('session') : null,
      this.amdEnabled ? turn.get('amd') : null,
    );
  }

  closeStream(): void {
    this.amdEnabled = false;
    const stream = this.stream;
    if (stream === undefined) {
      return;
    }
    this.stream = undefined;
    // ends the reader, which then closes nothing more
    stream.close();
  }

  async aclose(): Promise<void> {
    this.closeStream();
    await this.readTask;
  }

  /** Use the session transcript alone for the open turn and subsequent turns. */
  fail(error: unknown): void {
    if (!this.amdSttActive) {
      return;
    }
    this.logger.warn(
      { errorType: error instanceof Error ? error.name : typeof error },
      'amd stt failed, falling back to session stt',
    );
    this.sessionEnabled = true;
    this.closeStream();
  }
}
