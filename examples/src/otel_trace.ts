// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  logMetrics,
  stt,
  telemetry,
  tts,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { type Attributes } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// This example shows how to trace the agent session with OpenTelemetry.
// It requires OpenTelemetry JS SDK 2.x and experimental packages 0.2xx. When migrating from
// SDK 1.x, configure processors with `spanProcessors` and use `registerSpanProcessor` instead
// of the removed provider `addSpanProcessor` method.
// It exports spans over OTLP/HTTP, so it works with any OTLP-compatible backend
// (Langfuse, Jaeger, Grafana Tempo, Honeycomb, etc.). To enable tracing, set the trace
// provider with `telemetry.setTracerProvider` at the module level or inside the entrypoint
// before `AgentSession.start()`.
//
// Configure the destination either by passing `url`/`headers` to `setupOtel`, or by leaving
// them unset and exporting the standard OTLP environment variables:
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://my-collector.example.com
//   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
//
// Worked example - Langfuse: the endpoint is `<LANGFUSE_HOST>/api/public/otel` and auth
// is a base64-encoded `Authorization: Basic` header built from the public/secret keys:
//   const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
//   setupOtel({
//     url: `${host.replace(/\/$/, '')}/api/public/otel`,
//     headers: { Authorization: `Basic ${auth}`, 'x-langfuse-ingestion-version': '4' },
//   });
// Refer to their docs for latest instructions: https://langfuse.com/integrations/native/opentelemetry#opentelemetry-endpoint
function setupOtel(options?: {
  metadata?: Attributes;
  url?: string;
  headers?: Record<string, string>;
}): NodeTracerProvider {
  const traceExporter = new OTLPTraceExporter({
    url: options?.url,
    headers: options?.headers,
  });
  // OTel SDK 2.x providers accept span processors only at construction, so include a
  // FanoutSpanProcessor and hand its `add` to setTracerProvider — that's how the framework
  // attaches the metadata processor (and the LiveKit Cloud exporter, when enabled) later.
  const fanout = new telemetry.FanoutSpanProcessor();
  const traceProvider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(traceExporter), fanout],
  });

  traceProvider.register();
  telemetry.setTracerProvider(traceProvider, {
    metadata: options?.metadata,
    registerSpanProcessor: (processor) => fanout.add(processor),
  });
  return traceProvider;
}

// Resolve the logger lazily: log() requires initializeLogger() to have run, which the CLI
// only does after this module is imported, so calling it at module scope would throw.
const logger = () => log().child({ example: 'otel-trace-example' });

const lookupWeather = llm.tool({
  name: 'lookupWeather',
  description: 'Called when the user asks for weather related information.',
  parameters: z.object({
    location: z.string().describe('The location they are asking for'),
  }),
  execute: async ({ location }) => {
    logger().info({ location }, 'Looking up weather');
    return 'sunny with a temperature of 70 degrees.';
  },
});

class Kelly extends voice.Agent {
  constructor() {
    super({
      instructions: 'Your name is Kelly.',
      tools: [
        lookupWeather,
        llm.tool({
          name: 'transferToAlloy',
          description: 'Transfer the call to Alloy.',
          parameters: z.object({}),
          execute: async () => {
            logger().info('Transferring the call to Alloy');
            return llm.handoff({ agent: new Alloy(), returns: 'Transfer complete.' });
          },
        }),
      ],
    });
  }

  async onEnter() {
    logger().info('Kelly is entering the session');
    this.session.generateReply();
  }
}

class Alloy extends voice.Agent {
  constructor() {
    super({
      instructions: 'Your name is Alloy.',
      llm: new openai.realtime.RealtimeModel({ voice: 'alloy' }),
      tools: [
        lookupWeather,
        llm.tool({
          name: 'transferToKelly',
          description: 'Transfer the call to Kelly.',
          parameters: z.object({}),
          execute: async () => {
            logger().info('Transferring the call to Kelly');
            return llm.handoff({ agent: new Kelly(), returns: 'Transfer complete.' });
          },
        }),
      ],
    });
  }

  async onEnter() {
    logger().info('Alloy is entering the session');
    this.session.generateReply();
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Set up the OpenTelemetry tracer.
    const traceProvider = setupOtel({
      // Metadata is set as attributes on all spans created by the tracer; some backends have
      // their own grouping conventions (e.g. Langfuse uses `langfuse.session.id` or `session.id`).
      metadata: {
        'session.id': ctx.room.name,
      },
    });

    // Shut down the provider to flush pending spans and release exporter resources.
    ctx.addShutdownCallback(async () => {
      await traceProvider.shutdown();
    });

    const session = new voice.AgentSession({
      llm: new llm.FallbackAdapter({
        llms: [
          new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
          new inference.LLM({ model: 'google/gemini-2.5-flash' }),
        ],
      }),
      stt: new stt.FallbackAdapter({
        sttInstances: [
          new inference.STT({ model: 'deepgram/nova-3' }),
          new inference.STT({ model: 'cartesia/ink-whisper' }),
        ],
      }),
      tts: new tts.FallbackAdapter({
        ttsInstances: [
          new inference.TTS({ model: 'cartesia/sonic-3' }),
          new inference.TTS({ model: 'rime/arcana' }),
        ],
      }),
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      logMetrics(ev.metrics);
    });

    await session.start({
      agent: new Kelly(),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
