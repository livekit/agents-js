// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkSource } from './checkExceptionLogging.js';

describe('exception logging check', () => {
  it.each([
    'logger.error(`failed: ${failure}`)',
    'logger.warn("failed: %s", failure)',
    'logger.error("failed: " + failure.message)',
    'const message = String(failure); logger.error(message)',
    'console.error("failed:", failure)',
    'logger.error(failure)',
  ])('rejects exception details in %s', (statement) => {
    expect(checkSource(`try { operation(); } catch (failure) { ${statement}; }`)).not.toEqual([]);
  });

  it('checks promise rejections, error callbacks, and typed parameters', () => {
    expect(checkSource('task.catch(reason => logger.error(`${reason}`))')).not.toEqual([]);
    expect(checkSource('socket.on("error", problem => logger.error(problem.message))')).not.toEqual(
      [],
    );
    expect(checkSource('function failed(reason: Error) { logger.error(`${reason}`) }')).not.toEqual(
      [],
    );
  });

  it('allows structured exceptions and safe metadata in messages', () => {
    expect(
      checkSource('task.catch(error => logger.error({ error }, `failed, retry ${attempt}`))'),
    ).toEqual([]);
    expect(checkSource('task.catch(error => logger.error(error, "failed"))')).toEqual([]);
  });
});

describe('exception log fields', () => {
  it('checks error messages returned by provider factories', () => {
    expect(
      checkSource('const error = errorFromFrame(frame); logger.error(error.message)'),
    ).not.toEqual([]);
    expect(
      checkSource('const failure = new Error("secret"); logger.error(failure.message)'),
    ).not.toEqual([]);
    expect(checkSource('logger.error(`failed: ${evt.errorDetails}`)')).not.toEqual([]);
  });

  it('does not confuse a message property name with a caught error binding', () => {
    expect(checkSource('task.catch(error => logger.error({ error }, messages.error))')).toEqual([]);
  });
});
