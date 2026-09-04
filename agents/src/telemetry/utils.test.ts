// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContext } from '../job.js';
import { REDACTED_EXCEPTION_MESSAGE } from './redaction.js';
import * as traceTypes from './trace_types.js';
import { type RecordExceptionOptions, recordException } from './utils.js';

function fakeSpan() {
  return {
    addEvent: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  };
}

function captureException(
  span: ReturnType<typeof fakeSpan>,
  options?: RecordExceptionOptions,
): void {
  const error = new Error('secret transcript');
  recordException(span as unknown as Span, error, options);
}

describe('recordException', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves exception details when redaction is explicitly disabled', () => {
    const span = fakeSpan();

    captureException(span, { redacted: false });

    expect(span.recordException).toHaveBeenCalledOnce();
    // `error.type` is the GenAI/HTTP conventions' low-cardinality error identifier
    expect(span.setAttribute).toHaveBeenCalledWith(traceTypes.ATTR_ERROR_TYPE, 'Error');
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'secret transcript',
    });
    expect(span.setAttributes).toHaveBeenCalledWith({
      [traceTypes.ATTR_EXCEPTION_TYPE]: 'Error',
      [traceTypes.ATTR_EXCEPTION_MESSAGE]: 'secret transcript',
      [traceTypes.ATTR_EXCEPTION_TRACE]: expect.stringContaining('secret transcript'),
    });
  });

  it('omits exception details when redaction is explicitly enabled', () => {
    const span = fakeSpan();

    captureException(span, { redacted: true });

    const attrs = {
      [traceTypes.ATTR_EXCEPTION_TYPE]: 'Error',
      [traceTypes.ATTR_EXCEPTION_MESSAGE]: REDACTED_EXCEPTION_MESSAGE,
    };
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.addEvent).toHaveBeenCalledWith('exception', attrs);
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: REDACTED_EXCEPTION_MESSAGE,
    });
    expect(span.setAttributes).toHaveBeenCalledWith(attrs);
    // `error.type` names the error class, never its message, so it survives redaction
    expect(span.setAttribute).toHaveBeenCalledWith(traceTypes.ATTR_ERROR_TYPE, 'Error');
    expect(
      JSON.stringify([
        span.addEvent.mock.calls,
        span.setStatus.mock.calls,
        span.setAttribute.mock.calls,
        span.setAttributes.mock.calls,
      ]),
    ).not.toContain('secret transcript');
  });

  it('uses the resolved session redaction setting by default', () => {
    const span = fakeSpan();
    const context = {
      job: { enableRedaction: false },
      _redactionEnabled: true,
    } as unknown as JobContext;

    runWithJobContext(context, () => captureException(span));

    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setAttributes).toHaveBeenCalledWith({
      [traceTypes.ATTR_EXCEPTION_TYPE]: 'Error',
      [traceTypes.ATTR_EXCEPTION_MESSAGE]: REDACTED_EXCEPTION_MESSAGE,
    });
  });

  it('preserves exception details by default without a job context', () => {
    const span = fakeSpan();

    captureException(span);

    expect(span.recordException).toHaveBeenCalledOnce();
  });

  it('allows an explicit false override for resolved redaction', () => {
    const span = fakeSpan();
    const context = {
      _redactionEnabled: true,
    } as unknown as JobContext;

    runWithJobContext(context, () => captureException(span, { redacted: false }));

    expect(span.recordException).toHaveBeenCalledOnce();
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'secret transcript',
    });
  });
});
