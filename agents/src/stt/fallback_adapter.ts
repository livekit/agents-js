// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../log.js';
import { Task } from '../utils.js';
import type { VAD } from '../vad.js';
import { StreamAdapter } from './stream_adapter.js';
import { STT } from './stt.js';

interface STTStatus {
  available: boolean;
  recoveringSynthesizeTask: Task<void> | null;
  recoveringStreamTask: Task<void> | null;
}

interface FallbackAdapterOptions {
  sstInstances: STT[];
  vad?: VAD;
  attemptTimeoutMs: number;
  maxRetryPerSTT: number;
  retryIntervalMs: number;
}

export class FallbackAdapter extends STT {
  label = 'sst.FallbackAdapter';

  readonly sttInstances: STT[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerSTT: number;
  readonly retryIntervalMs: number;

  private _status: STTStatus[];
  private _logger = log();

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sstInstances || opts.sstInstances.length < 1) {
      throw new Error('At least one STT instance must be provided.');
    }
    let sttInstances = opts.sstInstances!;
    const nonStreaming = sttInstances.filter((s: STT) => !s.capabilities.streaming);
    if (nonStreaming.length > 0) {
      if (!opts.vad) {
        const labels = nonStreaming.map((s: STT) => s.label).join(', ');
        throw new Error(
          `STTs do not support streaming: ${labels}. ` +
            'Provide a VAD to enable stt.StreamAdapter automatically ' +
            'or wrap them with stt.StreamAdapter before using this adapter.',
        );
      }
      const vad = opts.vad;
      sttInstances = sttInstances.map((s: STT) =>
        s.capabilities.streaming ? s : new StreamAdapter(s, vad),
      );
    }

    super({
      streaming: true,
      interimResults: sttInstances.every((s) => s.capabilities.interimResults),
    });

    this.sttInstances = sttInstances;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 10000;
    this.maxRetryPerSTT = opts.maxRetryPerSTT ?? 1;
    this.retryIntervalMs = opts.retryIntervalMs ?? 5000;
    this._status = sttInstances.map(() => ({
      available: true,
      recoveringSynthesizeTask: null,
      recoveringStreamTask: null,
    }));
    this.setupEventForwarding();
  }

  get status(): STTStatus[] {
    return this._status;
  }

  private setupEventForwarding(): void {
    this.sttInstances.forEach((stt: STT) => {
      stt.on('metrics_collected', (metrics) => this.emit('metrics_collected', metrics));
      stt.on('error', (error) => this.emit('error', error));
    });
  }
}
