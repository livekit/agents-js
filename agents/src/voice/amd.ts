// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ChatContext } from '../llm/chat_context.js';
import { LLM } from '../llm/llm.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type UserInputTranscribedEvent } from './events.js';
import { setParticipantSpanAttributes } from './utils.js';

export enum AMDCategory {
  HUMAN = 'human',
  MACHINE_IVR = 'machine-ivr',
  MACHINE_VM = 'machine-vm',
  MACHINE_UNAVAILABLE = 'machine-unavailable',
  UNCERTAIN = 'uncertain',
}

export interface AMDResult {
  category: AMDCategory;
  transcript: string;
  reason: string;
  rawResponse: string;
  isMachine: boolean;
}

export interface AMDOptions {
  llm?: LLM;
  interruptOnMachine?: boolean;
  timeoutMs?: number;
  maxTranscriptTurns?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_TRANSCRIPT_TURNS = 2;

const AMD_PROMPT = `You classify the start of a phone call.
Return strict JSON with keys "category" and "reason".
Valid categories: "human", "machine-ivr", "machine-vm", "machine-unavailable", "uncertain".
- "human": a live person answered.
- "machine-ivr": an IVR, phone tree, or menu system answered.
- "machine-vm": a voicemail greeting or mailbox prompt answered.
- "machine-unavailable": the call reached an unavailable mailbox, failed mailbox, or generic machine state where no message should be left.
- "uncertain": not enough evidence yet.
Do not include markdown fences or extra text.`;

export class AMD {
  private readonly llm: LLM;
  private readonly interruptOnMachine: boolean;
  private readonly timeoutMs: number;
  private readonly maxTranscriptTurns: number;

  private active = false;

  constructor(
    private readonly session: AgentSession,
    options: AMDOptions = {},
  ) {
    const llm = options.llm ?? this.resolveSessionLLM();
    if (!llm) {
      throw new Error(
        'AMD requires an LLM. Pass `options.llm` when the session is not using a pipeline LLM.',
      );
    }

    this.llm = llm;
    this.interruptOnMachine = options.interruptOnMachine ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTranscriptTurns = options.maxTranscriptTurns ?? DEFAULT_MAX_TRANSCRIPT_TURNS;
  }

  async execute(): Promise<AMDResult> {
    return tracer.startActiveSpan(
      async (span) => {
        if (this.active) {
          throw new Error('AMD.execute() is already running');
        }

        this.active = true;
        this.session.pauseReplyAuthorization();

        span.setAttribute(traceTypes.ATTR_AMD_INTERRUPT_ON_MACHINE, this.interruptOnMachine);
        span.setAttribute(traceTypes.ATTR_GEN_AI_OPERATION_NAME, 'classification');

        const linkedParticipant = this.session._roomIO?.linkedParticipant;
        if (linkedParticipant) {
          setParticipantSpanAttributes(span, linkedParticipant);
        }

        const transcriptParts: string[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const setResultAttributes = (result: AMDResult) => {
          span.setAttribute(traceTypes.ATTR_AMD_CATEGORY, result.category);
          span.setAttribute(traceTypes.ATTR_AMD_REASON, result.reason);
          span.setAttribute(traceTypes.ATTR_AMD_IS_MACHINE, result.isMachine);
          span.setAttribute(traceTypes.ATTR_USER_TRANSCRIPT, result.transcript);
        };

        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          this.session.off(AgentSessionEventTypes.UserInputTranscribed, onTranscript);
          this.session.off(AgentSessionEventTypes.Close, onClose);
        };

        const finish = async (
          result: AMDResult,
          resolve: (value: AMDResult) => void,
        ): Promise<void> => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          setResultAttributes(result);
          if (result.isMachine && this.interruptOnMachine) {
            await this.session.interrupt({ force: true }).await;
          }
          resolve(result);
        };

        const onClose = () => {
          void settleUnknown('Session closed before answering machine detection completed.');
        };

        const onTranscript = (ev: UserInputTranscribedEvent) => {
          if (!ev.isFinal) {
            return;
          }

          const transcript = ev.transcript.trim();
          if (!transcript) {
            return;
          }

          transcriptParts.push(transcript);
          void maybeDetect().catch((error) => {
            if (!settled) {
              settled = true;
              cleanup();
              rejectRun(error);
            }
          });
        };

        let resolveRun!: (value: AMDResult) => void;
        let rejectRun!: (reason?: unknown) => void;

        const settleUnknown = async (reason: string): Promise<void> => {
          try {
            const transcript = transcriptParts.join('\n').trim();
            const result =
              transcript.length > 0
                ? await this.detect(transcript)
                : {
                    category: AMDCategory.UNCERTAIN,
                    transcript: '',
                    reason,
                    rawResponse: '',
                    isMachine: false,
                  };
            await finish(result, resolveRun);
          } catch (error) {
            if (!settled) {
              settled = true;
              cleanup();
              rejectRun(error);
            }
          }
        };

        const maybeDetect = async (): Promise<void> => {
          if (transcriptParts.length === 0 || settled) {
            return;
          }

          const result = await this.detect(transcriptParts.join('\n'));
          if (
            result.category !== AMDCategory.UNCERTAIN ||
            transcriptParts.length >= this.maxTranscriptTurns
          ) {
            await finish(result, resolveRun);
          }
        };

        try {
          const result = await new Promise<AMDResult>((resolve, reject) => {
            resolveRun = resolve;
            rejectRun = reject;
            this.session.on(AgentSessionEventTypes.UserInputTranscribed, onTranscript);
            this.session.on(AgentSessionEventTypes.Close, onClose);
            timer = setTimeout(() => {
              void settleUnknown('Detection timed out before any final transcript was received.');
            }, this.timeoutMs);
          });
          return result;
        } finally {
          cleanup();
          this.session.resumeReplyAuthorization();
          this.active = false;
        }
      },
      {
        name: 'answering_machine_detection',
        context: this.session.rootSpanContext,
      },
    );
  }

  async aclose(): Promise<void> {
    this.session.resumeReplyAuthorization();
    this.active = false;
  }

  private resolveSessionLLM(): LLM | undefined {
    return this.session.llm instanceof LLM ? this.session.llm : undefined;
  }

  private async detect(transcript: string): Promise<AMDResult> {
    const chatCtx = new ChatContext();
    chatCtx.addMessage({ role: 'system', content: AMD_PROMPT });
    chatCtx.addMessage({
      role: 'user',
      content: `Transcript:\n${transcript}\n\nClassify this call answer.`,
    });

    const stream = this.llm.chat({ chatCtx });
    let rawResponse = '';
    for await (const chunk of stream) {
      rawResponse += chunk.delta?.content ?? '';
    }

    const parsed = this.parseDetection(rawResponse);
    return {
      ...parsed,
      transcript,
      rawResponse,
      isMachine:
        parsed.category === AMDCategory.MACHINE_IVR ||
        parsed.category === AMDCategory.MACHINE_VM ||
        parsed.category === AMDCategory.MACHINE_UNAVAILABLE,
    };
  }

  private parseDetection(rawResponse: string): Pick<AMDResult, 'category' | 'reason'> {
    const normalized = rawResponse.trim();
    const jsonStart = normalized.indexOf('{');
    const jsonEnd = normalized.lastIndexOf('}');
    const jsonChunk =
      jsonStart >= 0 && jsonEnd >= jsonStart
        ? normalized.slice(jsonStart, jsonEnd + 1)
        : normalized;

    try {
      const parsed = JSON.parse(jsonChunk) as { category?: string; reason?: string };
      return {
        category: this.normalizeCategory(parsed.category),
        reason: parsed.reason?.trim() || 'No reason provided.',
      };
    } catch {
      return {
        category: AMDCategory.UNCERTAIN,
        reason: normalized || 'Failed to parse AMD model response.',
      };
    }
  }

  private normalizeCategory(category: string | undefined): AMDCategory {
    switch (category) {
      case AMDCategory.HUMAN:
        return AMDCategory.HUMAN;
      case AMDCategory.MACHINE_IVR:
        return AMDCategory.MACHINE_IVR;
      case AMDCategory.MACHINE_VM:
        return AMDCategory.MACHINE_VM;
      case AMDCategory.MACHINE_UNAVAILABLE:
        return AMDCategory.MACHINE_UNAVAILABLE;
      case AMDCategory.UNCERTAIN:
        return AMDCategory.UNCERTAIN;
      default:
        return AMDCategory.UNCERTAIN;
    }
  }
}
