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

  readonly sstInstances: STT[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerSTT: number;
  readonly retryIntervalMs: number;
  
  private _status: STTStatus[];
  private _logger = log();

  constructor(opts: FallbackAdapterOptions) {
    if (!opts.sstInstances || opts.sstInstances.length < 1) {
      throw new Error('At least one STT instance must be provided.');
    }
    let sttInstances = opts.sttInstances;
    const nonStreaming = sttInstances.filter((s) => !s.capabilities.streaming);
    if (nonStreaming.length > 0) {
      if (!opts.vad) {
        const labels = nonStreaming.map((s) => s.label).join(', ');
        throw new Error(
          `STTs do not support streaming: ${labels}. ` +
            'Provide a VAD to enable stt.StreamAdapter automatically ' +
            'or wrap them with stt.StreamAdapter before using this adapter.',
        );
      }
      const vad = opts.vad;
      sttInstances = sttInstances.map((s) =>
        s.capabilities.streaming ? s : new StreamAdapter(s, vad),
      );
    }
  }
}
