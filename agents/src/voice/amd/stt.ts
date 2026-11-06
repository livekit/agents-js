// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Attribute session and AMD STT transcripts to committed turns without access to AgentSession. */
import type { AudioFrame } from '@livekit/rtc-node';
import { log } from '../../log.js';
import { type STT, SpeechEventType, type SpeechStream } from '../../stt/stt.js';
import type { APIConnectOptions } from '../../types.js';
import { Event } from '../../utils.js';
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

/** A committed turn's wait for its AMD final, handed to the turn's task at commit. */
export class LateAMDFinal {
  private readonly until: number;
  private transcript = '';
  private readonly arrived = new Event();
  private closed = false;

  /** @param wait - How long the turn waits for its final, in ms. */
  constructor(wait: number) {
    this.until = performance.now() + wait;
  }

  /** Take the final if the turn still waits for it. */
  deliver(transcript: string): boolean {
    if (this.closed || performance.now() > this.until) {
      return false;
    }
    this.transcript = transcript;
    this.arrived.set();
    return true;
  }

  /** The AMD final once it arrives, or `undefined` when the wait passes without it. */
  async wait(signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) {
      return undefined;
    }
    let release!: () => void;
    const passed = new Promise<void>((resolve) => (release = resolve));
    const timer = setTimeout(release, Math.max(0, this.until - performance.now()));
    signal?.addEventListener('abort', release);
    try {
      await Promise.race([this.arrived.wait(), passed]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', release);
    }
    // a cancelled task stops here, as Python's CancelledError does
    if (signal?.aborted) {
      return undefined;
    }
    this.closed = true;
    return this.transcript || undefined;
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
  /**
   * The turn just ended before its AMD final arrived: the AMD STT finalizes a sentence
   * a little after the session commits it, so a final within the wait belongs to it.
   */
  private late: LateAMDFinal | undefined;
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
          const transcript = text.trim();
          const late = this.late;
          this.late = undefined;
          if (late === undefined || !late.deliver(transcript)) {
            this.pushTranscript(transcript, { source: 'amd' });
          }
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

  /**
   * End the turn. Within `lateWait` ms, the next AMD final still belongs to it when it
   * has no AMD text yet.
   */
  endTurn(sessionTranscript: string, { lateWait = 0 }: { lateWait?: number } = {}): AMDTranscript {
    this.pushTranscript(sessionTranscript, { replace: true, source: 'session' });
    const turn = this.current;
    this.current = new AMDTurnTranscriptAccumulator();
    // without session STT the turn has no text until its AMD final arrives
    const late =
      lateWait > 0 &&
      this.amdSttActive &&
      !turn.get('amd') &&
      (Boolean(turn.get('session')) || !this.sessionEnabled);
    this.late = late ? new LateAMDFinal(lateWait) : undefined;
    return new AMDTranscript(
      this.sessionEnabled ? turn.get('session') : null,
      this.amdEnabled ? turn.get('amd') : null,
    );
  }

  /**
   * The wait of the turn just ended for its AMD final; `undefined` when it needs no wait.
   * Read it at commit: the next final or turn replaces it.
   */
  get lateFinal(): LateAMDFinal | undefined {
    return this.late;
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
