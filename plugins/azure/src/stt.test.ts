// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { SpeechStream, speechsdk } from './stt.js';

function canceledEvent(
  reason: speechsdk.CancellationReason,
  errorCode?: speechsdk.CancellationErrorCode,
  errorDetails = '',
) {
  return { reason, errorCode, errorDetails };
}

describe('Azure STT cancellation handling', () => {
  it('unblocks run on canceled error', () => {
    const stream = SpeechStream.prototype as SpeechStream;
    const testStream = Object.create(stream) as SpeechStream;
    testStream._sessionStoppedEvent = {
      isSet: false,
      set() {
        this.isSet = true;
      },
      clear() {
        this.isSet = false;
      },
      wait: () => Promise.resolve(),
    } as SpeechStream['_sessionStoppedEvent'];
    testStream._cancellationError = null;

    const event = canceledEvent(
      speechsdk.CancellationReason.Error,
      speechsdk.CancellationErrorCode.ServiceTimeout,
      'timeout',
    );
    testStream._onCanceled(event);

    expect(testStream._sessionStoppedEvent.isSet).toBe(true);
    expect(testStream._cancellationError).toBe(event);
  });

  it('ignores cancellations without error', () => {
    const stream = SpeechStream.prototype as SpeechStream;
    const testStream = Object.create(stream) as SpeechStream;
    testStream._sessionStoppedEvent = {
      isSet: false,
      set() {
        this.isSet = true;
      },
      clear() {
        this.isSet = false;
      },
      wait: () => Promise.resolve(),
    } as SpeechStream['_sessionStoppedEvent'];
    testStream._cancellationError = null;

    testStream._onCanceled(canceledEvent(speechsdk.CancellationReason.EndOfStream));

    expect(testStream._sessionStoppedEvent.isSet).toBe(false);
    expect(testStream._cancellationError).toBeNull();
  });
});
