// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { trace } from '@opentelemetry/api';
import { EventEmitter } from 'node:events';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { log } from '../log.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import type { ChatContext } from './chat_context.js';
import {
  type Decision,
  DecisionModel,
  type DecisionModelCallbacks,
  DecisionResponse,
  copyDecisions,
  formatTranscript,
  validateDecisions,
} from './decisions.js';

/** Emitted when a decision model becomes unavailable or recovers. */
export interface DecisionAvailabilityChangedEvent {
  model: DecisionModel;
  available: boolean;
}

export type DecisionModelFallbackCallbacks = DecisionModelCallbacks & {
  decision_availability_changed: (event: DecisionAvailabilityChangedEvent) => void;
};

/** Configures the decision model order and retry policy for each model. */
export interface DecisionModelFallbackAdapterOptions {
  /** Models in priority order. Each model must support the decisions sent to the adapter. */
  models: readonly DecisionModel[];
  /** Timeout for each model attempt in milliseconds. Defaults to 1000. */
  attemptTimeoutMs?: number;
  /** Retries on one model before moving to the next. Defaults to 0. */
  maxRetryPerModel?: number;
  /** Delay between retries on one model in milliseconds. Defaults to 500. */
  retryIntervalMs?: number;
}

interface ModelStatus {
  available: boolean;
  recoveringTask?: Promise<void>;
  recoveryController?: AbortController;
}

function name(model: DecisionModel): string {
  return `${model.label()} (${model.model})`;
}

/**
 * Sends a batch of decisions to the next decision model when the current one fails.
 *
 * Models are tried in order. A failed model is skipped until a background copy of a request
 * succeeds on it. Partial decision errors are returned without falling back.
 */
export class DecisionModelFallbackAdapter extends DecisionModel {
  readonly models: readonly DecisionModel[];
  readonly attemptTimeoutMs: number;
  readonly maxRetryPerModel: number;
  readonly retryIntervalMs: number;

  private readonly status: ModelStatus[];
  private readonly logger = log();
  private readonly forwardMetrics: DecisionModelCallbacks['metrics_collected'] = (metrics) =>
    this.emit('metrics_collected', metrics);
  private closed = false;

  constructor({
    models,
    attemptTimeoutMs = 1000,
    maxRetryPerModel = 0,
    retryIntervalMs = 500,
  }: DecisionModelFallbackAdapterOptions) {
    if (models.length === 0) throw new Error('at least one decision model must be provided');

    const kinds = models[0]!.capabilities.decisionKinds.filter((kind) =>
      models.slice(1).every((model) => model.capabilities.decisionKinds.includes(kind)),
    );
    if (kinds.length === 0) throw new Error('the decision models share no decision kind');
    super({ capabilities: { decisionKinds: kinds } });

    this.models = Object.freeze([...models]);
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.maxRetryPerModel = maxRetryPerModel;
    this.retryIntervalMs = retryIntervalMs;
    this.status = this.models.map(() => ({ available: true }));

    for (const model of new Set(this.models)) {
      model.on('metrics_collected', this.forwardMetrics);
    }
  }

  private nextInstance(): DecisionModel {
    const index = this.status.findIndex((status) => status.available);
    return this.models[index === -1 ? 0 : index]!;
  }

  override get model(): string {
    return this.nextInstance().model;
  }

  override get provider(): string {
    return this.nextInstance().provider;
  }

  override on<Event extends keyof DecisionModelFallbackCallbacks>(
    event: Event,
    listener: DecisionModelFallbackCallbacks[Event],
  ): this {
    EventEmitter.prototype.on.call(this, event, listener);
    return this;
  }

  override off<Event extends keyof DecisionModelFallbackCallbacks>(
    event: Event,
    listener: DecisionModelFallbackCallbacks[Event],
  ): this {
    EventEmitter.prototype.off.call(this, event, listener);
    return this;
  }

  override async evaluate({
    input,
    decisions,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    abortSignal,
  }: {
    input: string | ChatContext;
    decisions: Readonly<Record<string, Decision>>;
    connOptions?: APIConnectOptions;
    abortSignal?: AbortSignal;
  }): Promise<DecisionResponse> {
    const definitions = copyDecisions(decisions);
    validateDecisions(definitions, this.capabilities);
    if (Object.keys(definitions).length === 0) {
      return new DecisionResponse({ results: {}, model: this.model, provider: this.provider });
    }

    const text = typeof input === 'string' ? input : formatTranscript(input);
    const childOptions = {
      ...connOptions,
      maxRetry: this.maxRetryPerModel,
      timeoutMs: this.attemptTimeoutMs,
      retryIntervalMs: this.retryIntervalMs,
    };
    return tracer.startActiveSpan(
      async () => this.evaluateImpl(text, definitions, childOptions, abortSignal),
      { name: 'decision_fallback_adapter' },
    );
  }

  protected override _evaluateImpl(): Promise<DecisionResponse> {
    throw new Error('DecisionModelFallbackAdapter.evaluate must be used');
  }

  private async evaluateImpl(
    input: string,
    decisions: Readonly<Record<string, Decision>>,
    connOptions: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): Promise<DecisionResponse> {
    const started = performance.now();
    const allFailed = this.status.every((status) => !status.available);
    if (allFailed) this.logger.error('all decision models are unavailable, retrying...');

    for (let index = 0; index < this.models.length; index++) {
      abortSignal?.throwIfAborted();
      const model = this.models[index]!;
      const status = this.status[index]!;
      if (status.available || allFailed) {
        try {
          const response = await model.evaluate({ input, decisions, connOptions, abortSignal });
          this.setAvailable(model, status, true);
          trace.getActiveSpan()?.setAttributes({
            [traceTypes.ATTR_FALLBACK_LABEL]: model.label(),
            [traceTypes.ATTR_FALLBACK_INDEX]: index,
          });
          return response;
        } catch (error) {
          if (abortSignal?.aborted) throw abortSignal.reason;
          if (error instanceof APIError) {
            this.logger.warn({ model: name(model), error }, 'failed, switching decision model');
          } else {
            this.logger.error(
              { model: name(model), error },
              'unexpected error, switching decision model',
            );
          }
          this.setAvailable(model, status, false);
        }
      }
      this.tryRecovery(model, status, input, decisions, connOptions);
    }

    const names = this.models.map(name);
    throw new APIConnectionError({
      message: `all decision models failed (${JSON.stringify(names)}) after ${(
        (performance.now() - started) /
        1000
      ).toFixed(2)} seconds`,
    });
  }

  private setAvailable(model: DecisionModel, status: ModelStatus, available: boolean): void {
    if (status.available === available) return;
    status.available = available;
    EventEmitter.prototype.emit.call(this, 'decision_availability_changed', { model, available });
  }

  private tryRecovery(
    model: DecisionModel,
    status: ModelStatus,
    input: string,
    decisions: Readonly<Record<string, Decision>>,
    connOptions: APIConnectOptions,
  ): void {
    if (this.closed || status.recoveringTask) return;
    const controller = new AbortController();
    status.recoveryController = controller;
    status.recoveringTask = Promise.resolve()
      .then(() =>
        tracer.startActiveSpan(
          async () => {
            if (controller.signal.aborted) return;
            try {
              await model.evaluate({
                input,
                decisions,
                connOptions,
                abortSignal: controller.signal,
              });
              if (!this.closed) {
                this.logger.info({ model: name(model) }, 'decision model recovered');
                this.setAvailable(model, status, true);
              }
            } catch (error) {
              if (!controller.signal.aborted) {
                this.logger.debug({ model: name(model), error }, 'decision model recovery failed');
              }
            }
          },
          {
            name: 'decision_fallback_adapter.recovery',
            attributes: { [traceTypes.ATTR_FALLBACK_RECOVERY]: true },
          },
        ),
      )
      .finally(() => {
        status.recoveringTask = undefined;
        status.recoveryController = undefined;
      });
  }

  override async aclose(): Promise<void> {
    this.closed = true;
    for (const status of this.status) status.recoveryController?.abort();
    await Promise.allSettled(this.status.flatMap((status) => status.recoveringTask ?? []));
    for (const model of new Set(this.models)) {
      model.off('metrics_collected', this.forwardMetrics);
    }
  }
}
