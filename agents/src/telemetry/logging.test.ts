// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtraDetailsProcessor, MetadataLogProcessor } from './logging.js';

describe('OpenTelemetry SDK 2.x log processors', () => {
  let provider: LoggerProvider | undefined;

  afterEach(async () => {
    await provider?.shutdown();
  });

  it('adds LiveKit metadata and the logger name to exported records', async () => {
    const exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider({
      processors: [
        new MetadataLogProcessor({ room_id: 'room1', job_id: 'job1' }),
        new ExtraDetailsProcessor(),
        new SimpleLogRecordProcessor({ exporter }),
      ],
    });

    provider.getLogger('agent-runtime').emit({ body: 'hello' });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    expect(exporter.getFinishedLogRecords()[0]!.attributes).toMatchObject({
      room_id: 'room1',
      job_id: 'job1',
      'logger.name': 'agent-runtime',
    });
  });
});
