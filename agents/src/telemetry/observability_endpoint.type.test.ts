// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import type { SimpleOTLPHttpLogExporterConfig } from './otel_http_exporter.js';
import type { PinoCloudExporterConfig } from './pino_otel_transport.js';

interface LegacySimpleExporterConfig extends SimpleOTLPHttpLogExporterConfig {
  custom: true;
}

interface LegacyPinoExporterConfig extends PinoCloudExporterConfig {
  custom: true;
}

describe('observability endpoint type compatibility', () => {
  it('keeps the published legacy config interfaces extendable', () => {
    expectTypeOf<LegacySimpleExporterConfig['cloudHostname']>().toEqualTypeOf<string>();
    expectTypeOf<LegacyPinoExporterConfig['cloudHostname']>().toEqualTypeOf<string>();
  });
});
