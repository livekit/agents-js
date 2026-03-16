// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Example: Custom OpenTelemetry Tracing
 * 
 * This example demonstrates how to integrate LiveKit agents with your own
 * OpenTelemetry tracing setup, allowing you to correlate LiveKit spans with
 * your application's spans in a single trace tree.
 * 
 * Run with:
 *   npx tsx examples/src/otel_tracing.ts
 */

import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { setTracerProvider } from '@livekit/agents/telemetry';
import { LiveKitRoom } from '@livekit/react-native';
import { Agent, AgentEventEmitter, RunHook } from '@livekit/agents';
import { JobContext } from '@livekit/agents';

// Example OpenTelemetry exporter (replace with your preferred exporter)
const otlpExporter = {
  // Configure your OTLP endpoint here
  // For local development, you can use @opentelemetry/exporter-trace-otlp-http
  endpoint: process.env.OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
};

async function setupCustomOtelTracing() {
  // 1. Create your custom NodeTracerProvider
  const customProvider = new NodeTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'my-livekit-agent',
    }),
  });

  // 2. Add your span processor (BatchSpanProcessor for production)
  customProvider.addSpanProcessor(
    new BatchSpanProcessor(
      // In a real app, import and use OTLPTraceExporter from @opentelemetry/exporter-trace-otlp-http
      // new OTLPTraceExporter({ url: otlpExporter.endpoint }),
      {
        // For demo purposes - in production use real OTLP exporter
        export: async (spans) => {
          console.log(`[OTEL] Exporting ${spans.length} spans to ${otlpExporter.endpoint}`);
          // In production, send to your OTLP endpoint
        },
      } as any
    )
  );

  // 3. Register the provider with LiveKit agents
  // This makes LiveKit spans children of your application's trace
  setTracerProvider(customProvider, {
    metadata: {
      'custom.attribute': 'value',
    },
  });

  console.log('[OTEL] Custom tracer provider configured successfully');
}

// Example agent with custom tracing
class TracedAgent {
  private agent: Agent;

  constructor() {
    this.agent = new Agent({
      model: 'gpt-4o',
    });
  }

  async onEnter(ctx: JobContext): Promise<void> {
    // Your agent logic here
    console.log(`[Agent] Processing job in room: ${ctx.room.name}`);
  }
}

// Run the example
async function main() {
  console.log('=== Custom OpenTelemetry Tracing Example ===\n');
  
  // Setup custom tracing before starting the agent
  await setupCustomOtelTracing();
  
  console.log('\nTo use this with a real room:');
  console.log('1. Configure OTLP exporter endpoint');
  console.log('2. Import OTLPTraceExporter from @opentelemetry/exporter-trace-otlp-http');
  console.log('3. Add your agent to a LiveKit room');
  console.log('\nYour traces will now appear alongside LiveKit spans in your OTEL backend.');
}

main().catch(console.error);
