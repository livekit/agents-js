// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AudioResampler } from '@livekit/rtc-node';
import type { Span } from '@opentelemetry/api';
import { context as otelContext } from '@opentelemetry/api';
import type { ReadableStream, ReadableStreamDefaultReader } from 'stream/web';
import {
  type ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import {
  type ToolChoice,
  type ToolContext,
  isAgentHandoff,
  isFunctionTool,
  isToolError,
} from '../llm/tool_context.js';
import { isZodSchema, parseZodSchema } from '../llm/zod-utils.js';
import { log } from '../log.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import { Future, Task, shortuuid, toError, waitForAbort } from '../utils.js';
import { type Agent, type ModelSettings, asyncLocalStorage, isStopResponse } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  AudioOutput,
  type LLMNode,
  type TTSNode,
  type TextOutput,
  type TimedString,
  createTimedString,
  isTimedString,
} from './io.js';
import { RunContext } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';

/** @internal */
export class _LLMGenerationData {
  generatedText: string = '';
  generatedToolCalls: FunctionCall[];
  id: string;

  constructor(
    public readonly textStream: ReadableStream<string>,
    public readonly toolCallStream: ReadableStream<FunctionCall>,
  ) {
    this.id = shortuuid('item_');
    this.generatedToolCalls = [];
  }
}

/**
 * TTS generation data containing audio stream and optional timed transcripts.
 * @internal
 */
export interface _TTSGenerationData {
  /** Audio frame stream from TTS */
  audioStream: ReadableStream<AudioFrame>;
  /**
   * Future that resolves to a stream of timed transcripts, or null if TTS doesn't support it.
   */
  timedTextsFut: Future<ReadableStream<TimedString> | null>;
  /** Time to first byte (set when first audio frame is received) */
  ttfb?: number;
}

// TODO(brian): remove this class in favor of ToolOutput
export class _ToolOutput {
  output: _JsOutput[];
  firstToolFut: Future;

  constructor() {
    this.output = [];
    this.firstToolFut = new Future();
  }
}

// TODO(brian): remove this class in favor of ToolExecutionOutput
export class _SanitizedOutput {
  toolCall: FunctionCall;
  toolCallOutput?: FunctionCallOutput;
  replyRequired: boolean;
  agentTask?: Agent;

  constructor(
    toolCall: FunctionCall,
    toolCallOutput: FunctionCallOutput | undefined,
    replyRequired: boolean,
    agentTask: Agent | undefined,
  ) {
    this.toolCall = toolCall;
    this.toolCallOutput = toolCallOutput;
    this.replyRequired = replyRequired;
    this.agentTask = agentTask;
  }

  static create(params: {
    toolCall: FunctionCall;
    toolCallOutput?: FunctionCallOutput;
    replyRequired?: boolean;
    agentTask?: Agent;
  }) {
    const { toolCall, toolCallOutput, replyRequired = true, agentTask } = params;
    return new _SanitizedOutput(toolCall, toolCallOutput, replyRequired, agentTask);
  }
}

function isValidToolOutput(toolOutput: unknown): boolean {
  const validTypes = ['string', 'number', 'boolean'];

  if (validTypes.includes(typeof toolOutput)) {
    return true;
  }

  if (toolOutput === undefined || toolOutput === null) {
    return true;
  }

  if (Array.isArray(toolOutput)) {
    return toolOutput.every(isValidToolOutput);
  }

  if (toolOutput instanceof Set) {
    return Array.from(toolOutput).every(isValidToolOutput);
  }

  if (toolOutput instanceof Map) {
    return Array.from(toolOutput.values()).every(isValidToolOutput);
  }

  if (toolOutput instanceof Object) {
    return Object.entries(toolOutput).every(
      ([key, value]) => validTypes.includes(typeof key) && isValidToolOutput(value),
    );
  }

  return false;
}

export class ToolExecutionOutput {
  constructor(
    public readonly toolCall: FunctionCall,
    public readonly toolCallOutput: FunctionCallOutput | undefined,
    public readonly agentTask: Agent | undefined,
    public readonly rawOutput: unknown,
    public readonly rawException: Error | undefined,
    public readonly replyRequired: boolean,
  ) {}

  static create(params: {
    toolCall: FunctionCall;
    toolCallOutput?: FunctionCallOutput;
    agentTask?: Agent;
    rawOutput: unknown;
    rawException?: Error;
    replyRequired?: boolean;
  }) {
    const {
      toolCall,
      toolCallOutput,
      agentTask,
      rawOutput,
      rawException,
      replyRequired = true,
    } = params;
    return new ToolExecutionOutput(
      toolCall,
      toolCallOutput,
      agentTask,
      rawOutput,
      rawException,
      replyRequired,
    );
  }
}

export interface ToolOutput {
  output: ToolExecutionOutput[];
  firstToolStartedFuture: Future<void>;
}

// TODO(brian): remove this class in favor of ToolExecutionOutput
export class _JsOutput {
  toolCall: FunctionCall;
  output: unknown;
  exception?: Error;

  #logger = log();

  constructor(toolCall: FunctionCall, output: unknown, exception: Error | undefined) {
    this.toolCall = toolCall;
    this.output = output;
    this.exception = exception;
  }

  static create(params: { toolCall: FunctionCall; output?: unknown; exception?: Error }) {
    const { toolCall, output = undefined, exception = undefined } = params;
    return new _JsOutput(toolCall, output, exception);
  }

  sanitize(): _SanitizedOutput {
    if (isToolError(this.exception)) {
      return _SanitizedOutput.create({
        toolCall: FunctionCall.create({ ...this.toolCall }),
        toolCallOutput: FunctionCallOutput.create({
          name: this.toolCall.name,
          callId: this.toolCall.callId,
          output: this.exception.message,
          isError: true,
        }),
      });
    }

    if (isStopResponse(this.exception)) {
      return _SanitizedOutput.create({
        toolCall: FunctionCall.create({ ...this.toolCall }),
      });
    }

    if (this.exception !== undefined) {
      return _SanitizedOutput.create({
        toolCall: FunctionCall.create({ ...this.toolCall }),
        toolCallOutput: FunctionCallOutput.create({
          name: this.toolCall.name,
          callId: this.toolCall.callId,
          output: 'An internal error occurred while executing the tool.', // Don't send the actual error message, as it may contain sensitive information
          isError: true,
        }),
      });
    }

    let agentTask: Agent | undefined = undefined;
    let toolOutput: unknown = this.output;
    if (isAgentHandoff(this.output)) {
      agentTask = this.output.agent;
      toolOutput = this.output.returns;
    }

    if (!isValidToolOutput(toolOutput)) {
      this.#logger.error(
        {
          callId: this.toolCall.callId,
          function: this.toolCall.name,
        },
        `AI function ${this.toolCall.name} returned an invalid output`,
      );
      return _SanitizedOutput.create({
        toolCall: FunctionCall.create({ ...this.toolCall }),
        toolCallOutput: undefined,
      });
    }

    return _SanitizedOutput.create({
      toolCall: FunctionCall.create({ ...this.toolCall }),
      toolCallOutput: FunctionCallOutput.create({
        name: this.toolCall.name,
        callId: this.toolCall.callId,
        output: toolOutput !== undefined ? JSON.stringify(toolOutput) : '', // take the string representation of the output
        isError: false,
      }),
      replyRequired: toolOutput !== undefined, // require a reply if the tool returned an output
      agentTask,
    });
  }
}

export function createToolOutput(params: {
  toolCall: FunctionCall;
  output?: unknown;
  exception?: Error;
}): ToolExecutionOutput {
  const { toolCall, output, exception } = params;
  const logger = log();

  // support returning Exception instead of raising them (for devex purposes inside evals)
  let finalOutput = output;
  let finalException = exception;
  if (output instanceof Error) {
    finalException = output;
    finalOutput = undefined;
  }

  if (isToolError(finalException)) {
    return ToolExecutionOutput.create({
      toolCall: FunctionCall.create({ ...toolCall }),
      toolCallOutput: FunctionCallOutput.create({
        name: toolCall.name,
        callId: toolCall.callId,
        output: finalException.message,
        isError: true,
      }),
      rawOutput: finalOutput,
      rawException: finalException,
    });
  }

  if (isStopResponse(finalException)) {
    return ToolExecutionOutput.create({
      toolCall: FunctionCall.create({ ...toolCall }),
      rawOutput: finalOutput,
      rawException: finalException,
    });
  }

  if (finalException !== undefined) {
    return ToolExecutionOutput.create({
      toolCall: FunctionCall.create({ ...toolCall }),
      toolCallOutput: FunctionCallOutput.create({
        name: toolCall.name,
        callId: toolCall.callId,
        output: 'An internal error occurred', // Don't send the actual error message, as it may contain sensitive information
        isError: true,
      }),
      rawOutput: finalOutput,
      rawException: finalException,
    });
  }

  let agentTask: Agent | undefined = undefined;
  let toolOutput: unknown = finalOutput;
  if (isAgentHandoff(finalOutput)) {
    agentTask = finalOutput.agent;
    toolOutput = finalOutput.returns;
  }

  if (!isValidToolOutput(toolOutput)) {
    logger.error(
      {
        callId: toolCall.callId,
        output: finalOutput,
      },
      `AI function ${toolCall.name} returned an invalid output`,
    );
    return ToolExecutionOutput.create({
      toolCall: FunctionCall.create({ ...toolCall }),
      rawOutput: finalOutput,
      rawException: finalException,
    });
  }

  return ToolExecutionOutput.create({
    toolCall: FunctionCall.create({ ...toolCall }),
    toolCallOutput: FunctionCallOutput.create({
      name: toolCall.name,
      callId: toolCall.callId,
      output: toolOutput !== undefined ? JSON.stringify(toolOutput) : '', // take the string representation of the output
      isError: false,
    }),
    replyRequired: toolOutput !== undefined, // require a reply if the tool returned an output
    agentTask,
    rawOutput: finalOutput,
    rawException: finalException,
  });
}

const INSTRUCTIONS_MESSAGE_ID = 'lk.agent_task.instructions';

/**
 * Update the instruction message in the chat context or insert a new one if missing.
 *
 * This function looks for an existing instruction message in the chat context using the identifier
 * 'INSTRUCTIONS_MESSAGE_ID'.
 *
 * @param options - The options for updating the instructions.
 * @param options.chatCtx - The chat context to update.
 * @param options.instructions - The instructions to add.
 * @param options.addIfMissing - Whether to add the instructions if they are missing.
 */
export function updateInstructions(options: {
  chatCtx: ChatContext;
  instructions: string;
  addIfMissing: boolean;
}) {
  const { chatCtx, instructions, addIfMissing } = options;

  const idx = chatCtx.indexById(INSTRUCTIONS_MESSAGE_ID);
  if (idx !== undefined) {
    if (chatCtx.items[idx]!.type === 'message') {
      // create a new instance to avoid mutating the original
      chatCtx.items[idx] = ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: [instructions],
        createdAt: chatCtx.items[idx]!.createdAt,
      });
    } else {
      throw new Error('expected the instructions inside the chatCtx to be of type "message"');
    }
  } else if (addIfMissing) {
    // insert the instructions at the beginning of the chat context
    chatCtx.items.unshift(
      ChatMessage.create({
        id: INSTRUCTIONS_MESSAGE_ID,
        role: 'system',
        content: [instructions],
      }),
    );
  }
}

export function performLLMInference(
  node: LLMNode,
  chatCtx: ChatContext,
  toolCtx: ToolContext,
  modelSettings: ModelSettings,
  controller: AbortController,
): [Task<void>, _LLMGenerationData] {
  const textStream = new IdentityTransform<string>();
  const toolCallStream = new IdentityTransform<FunctionCall>();

  const textWriter = textStream.writable.getWriter();
  const toolCallWriter = toolCallStream.writable.getWriter();
  const data = new _LLMGenerationData(textStream.readable, toolCallStream.readable);

  const _performLLMInferenceImpl = async (signal: AbortSignal, span: Span) => {
    span.setAttribute(
      traceTypes.ATTR_CHAT_CTX,
      JSON.stringify(chatCtx.toJSON({ excludeTimestamp: false })),
    );
    span.setAttribute(traceTypes.ATTR_FUNCTION_TOOLS, JSON.stringify(Object.keys(toolCtx)));

    let llmStreamReader: ReadableStreamDefaultReader<string | ChatChunk> | null = null;
    let llmStream: ReadableStream<string | ChatChunk> | null = null;

    try {
      llmStream = await node(chatCtx, toolCtx, modelSettings);
      if (llmStream === null) {
        await textWriter.close();
        return;
      }

      const abortPromise = waitForAbort(signal);

      // TODO(brian): add support for dynamic tools

      llmStreamReader = llmStream.getReader();
      while (true) {
        if (signal.aborted) break;

        const result = await Promise.race([llmStreamReader.read(), abortPromise]);
        if (result === undefined) break;

        const { done, value: chunk } = result;
        if (done) break;

        if (typeof chunk === 'string') {
          data.generatedText += chunk;
          await textWriter.write(chunk);
          // TODO(shubhra): better way to check??
        } else {
          if (chunk.delta === undefined) {
            continue;
          }

          if (chunk.delta.toolCalls) {
            for (const tool of chunk.delta.toolCalls) {
              if (tool.type !== 'function_call') continue;

              const toolCall = FunctionCall.create({
                callId: `${data.id}/fnc_${data.generatedToolCalls.length}`,
                name: tool.name,
                args: tool.args,
                // Preserve thought signature for Gemini 3+ thinking mode
                thoughtSignature: tool.thoughtSignature,
                extra: tool.extra || {},
              });

              data.generatedToolCalls.push(toolCall);
              await toolCallWriter.write(toolCall);
            }
          }

          if (chunk.delta.content) {
            data.generatedText += chunk.delta.content;
            await textWriter.write(chunk.delta.content);
          }
        }

        // No need to check if chunk is of type other than ChatChunk or string like in
        // Python since chunk is defined in the type ChatChunk | string in TypeScript
      }

      span.setAttribute(traceTypes.ATTR_RESPONSE_TEXT, data.generatedText);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Abort signal was triggered, handle gracefully
        return;
      }
      throw error;
    } finally {
      llmStreamReader?.releaseLock();
      await llmStream?.cancel();
      await textWriter.close();
      await toolCallWriter.close();
    }
  };

  // Capture the current context (agent_turn) to ensure llm_node is properly parented
  const currentContext = otelContext.active();

  const inferenceTask = async (signal: AbortSignal) =>
    tracer.startActiveSpan(async (span) => _performLLMInferenceImpl(signal, span), {
      name: 'llm_node',
      context: currentContext,
    });

  return [
    Task.from((controller) => inferenceTask(controller.signal), controller, 'performLLMInference'),
    data,
  ];
}

export function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string | TimedString>,
  modelSettings: ModelSettings,
  controller: AbortController,
): [Task<void>, _TTSGenerationData] {
  const audioStream = new IdentityTransform<AudioFrame>();
  const outputWriter = audioStream.writable.getWriter();
  const audioOutputStream = audioStream.readable;

  const timedTextsFut = new Future<ReadableStream<TimedString> | null>();
  const timedTextsStream = new IdentityTransform<TimedString>();
  const timedTextsWriter = timedTextsStream.writable.getWriter();

  // Transform stream to extract text from TimedString objects
  const textOnlyStream = new IdentityTransform<string>();
  const textOnlyWriter = textOnlyStream.writable.getWriter();
  (async () => {
    const reader = text.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const textValue = typeof value === 'string' ? value : value.text;
        await textOnlyWriter.write(textValue);
      }
      await textOnlyWriter.close();
    } catch (e) {
      await textOnlyWriter.abort(e as Error);
    } finally {
      reader.releaseLock();
    }
  })();

  const _performTTSInferenceImpl = async (signal: AbortSignal) => {
    let ttsStreamReader: ReadableStreamDefaultReader<AudioFrame> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;
    let pushedDuration = 0;

    try {
      ttsStream = await node(textOnlyStream.readable, modelSettings);
      if (ttsStream === null) {
        timedTextsFut.resolve(null);
        await outputWriter.close();
        await timedTextsWriter.close();
        return;
      }

      // This is critical: the future must be resolved with the channel/stream before the loop
      // so that agent_activity can start reading while we write
      if (!timedTextsFut.done) {
        timedTextsFut.resolve(timedTextsStream.readable);
      }

      ttsStreamReader = ttsStream.getReader();

      // In Python, perform_tts_inference has a while loop processing multiple input segments
      // (separated by FlushSentinel), with pushed_duration accumulating across segments.
      // JS currently only does single inference, so initialPushedDuration is always 0.
      // TODO: Add FlushSentinel + multi-segment loop
      const initialPushedDuration = pushedDuration;

      while (true) {
        if (signal.aborted) {
          break;
        }
        const { done, value: frame } = await ttsStreamReader.read();
        if (done) {
          break;
        }

        // Write the audio frame to the output stream
        await outputWriter.write(frame);

        const timedTranscripts = frame.userdata[USERDATA_TIMED_TRANSCRIPT] as
          | TimedString[]
          | undefined;
        if (timedTranscripts && timedTranscripts.length > 0) {
          for (const timedText of timedTranscripts) {
            // Uses the INITIAL value (from previous inferences), not the accumulated value
            const adjustedTimedText = createTimedString({
              text: timedText.text,
              startTime:
                timedText.startTime !== undefined
                  ? timedText.startTime + initialPushedDuration
                  : undefined,
              endTime:
                timedText.endTime !== undefined
                  ? timedText.endTime + initialPushedDuration
                  : undefined,
              confidence: timedText.confidence,
              startTimeOffset: timedText.startTimeOffset,
            });
            await timedTextsWriter.write(adjustedTimedText);
          }
        }

        const frameDuration = frame.samplesPerChannel / frame.sampleRate;
        pushedDuration += frameDuration;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Abort signal was triggered, handle gracefully
        return;
      }
      throw error;
    } finally {
      ttsStreamReader?.releaseLock();
      await ttsStream?.cancel();
      await outputWriter.close();
      await timedTextsWriter.close();
    }
  };

  // Capture the current context (agent_turn) to ensure tts_node is properly parented
  const currentContext = otelContext.active();

  const inferenceTask = async (signal: AbortSignal) =>
    tracer.startActiveSpan(async () => _performTTSInferenceImpl(signal), {
      name: 'tts_node',
      context: currentContext,
    });

  const genData: _TTSGenerationData = {
    audioStream: audioOutputStream,
    timedTextsFut,
  };

  return [
    Task.from((controller) => inferenceTask(controller.signal), controller, 'performTTSInference'),
    genData,
  ];
}

export interface _TextOut {
  text: string;
  firstTextFut: Future;
}

async function forwardText(
  source: ReadableStream<string | TimedString>,
  out: _TextOut,
  signal: AbortSignal,
  textOutput: TextOutput | null,
): Promise<void> {
  const reader = source.getReader();
  try {
    while (true) {
      if (signal.aborted) {
        break;
      }
      const { done, value: delta } = await reader.read();
      if (done) break;

      const deltaIsTimedString = isTimedString(delta);
      const textDelta = deltaIsTimedString ? delta.text : delta;

      out.text += textDelta;
      if (textOutput !== null) {
        // Pass TimedString to textOutput for synchronized transcription
        await textOutput.captureText(delta);
      }
      if (!out.firstTextFut.done) {
        out.firstTextFut.resolve();
      }
    }
  } finally {
    if (textOutput !== null) {
      textOutput.flush();
    }
    reader?.releaseLock();
  }
}

export function performTextForwarding(
  source: ReadableStream<string | TimedString>,
  controller: AbortController,
  textOutput: TextOutput | null,
): [Task<void>, _TextOut] {
  const out = {
    text: '',
    firstTextFut: new Future(),
  };
  return [
    Task.from(
      (controller) => forwardText(source, out, controller.signal, textOutput),
      controller,
      'performTextForwarding',
    ),
    out,
  ];
}

export interface _AudioOut {
  audio: Array<AudioFrame>;
  /** Future that will be set with the timestamp of the first frame's capture */
  firstFrameFut: Future<number>;
}

async function forwardAudio(
  ttsStream: ReadableStream<AudioFrame>,
  audioOuput: AudioOutput,
  out: _AudioOut,
  signal?: AbortSignal,
): Promise<void> {
  const reader = ttsStream.getReader();
  let resampler: AudioResampler | null = null;

  const onPlaybackStarted = (ev: { createdAt: number }) => {
    if (!out.firstFrameFut.done) {
      out.firstFrameFut.resolve(ev.createdAt);
    }
  };

  try {
    audioOuput.on(AudioOutput.EVENT_PLAYBACK_STARTED, onPlaybackStarted);
    audioOuput.resume();

    while (true) {
      if (signal?.aborted) {
        break;
      }

      const { done, value: frame } = await reader.read();
      if (done) break;

      out.audio.push(frame);

      if (
        !out.firstFrameFut.done &&
        audioOuput.sampleRate &&
        audioOuput.sampleRate !== frame.sampleRate &&
        !resampler
      ) {
        resampler = new AudioResampler(frame.sampleRate, audioOuput.sampleRate, 1);
      }

      if (resampler) {
        for (const f of resampler.push(frame)) {
          await audioOuput.captureFrame(f);
        }
      } else {
        await audioOuput.captureFrame(frame);
      }
    }

    if (resampler) {
      for (const f of resampler.flush()) {
        await audioOuput.captureFrame(f);
      }
    }
  } finally {
    audioOuput.off(AudioOutput.EVENT_PLAYBACK_STARTED, onPlaybackStarted);

    if (!out.firstFrameFut.done) {
      out.firstFrameFut.reject(new Error('audio forwarding cancelled before playback started'));
    }

    reader?.releaseLock();
    audioOuput.flush();
  }
}

export function performAudioForwarding(
  ttsStream: ReadableStream<AudioFrame>,
  audioOutput: AudioOutput,
  controller: AbortController,
): [Task<void>, _AudioOut] {
  const out: _AudioOut = {
    audio: [],
    firstFrameFut: new Future<number>(),
  };

  return [
    Task.from(
      (controller) => forwardAudio(ttsStream, audioOutput, out, controller.signal),
      controller,
      'performAudioForwarding',
    ),
    out,
  ];
}

// function_tool span is already implemented in tracableToolExecution below (line ~796)
export function performToolExecutions({
  session,
  speechHandle,
  toolCtx,
  toolChoice,
  toolCallStream,
  onToolExecutionStarted = () => {},
  onToolExecutionCompleted = () => {},
  controller,
}: {
  session: AgentSession;
  speechHandle: SpeechHandle;
  toolCtx: ToolContext;
  toolChoice?: ToolChoice;
  toolCallStream: ReadableStream<FunctionCall>;
  onToolExecutionStarted?: (toolCall: FunctionCall) => void;
  onToolExecutionCompleted?: (toolExecutionOutput: ToolExecutionOutput) => void;
  controller: AbortController;
}): [Task<void>, ToolOutput] {
  const logger = log();
  const toolOutput: ToolOutput = {
    output: [],
    firstToolStartedFuture: new Future(),
  };

  const toolCompleted = (out: ToolExecutionOutput) => {
    onToolExecutionCompleted(out);
    toolOutput.output.push(out);
  };

  const executeToolsTask = async (controller: AbortController) => {
    const signal = controller.signal;
    const reader = toolCallStream.getReader();

    const tasks: Promise<any>[] = [];
    while (!signal.aborted) {
      const { done, value: toolCall } = await reader.read();
      if (signal.aborted) break;
      if (done) break;

      if (toolChoice === 'none') {
        logger.error(
          {
            function: toolCall.name,
            speech_id: speechHandle.id,
          },
          "received a tool call with toolChoice set to 'none', ignoring",
        );
        continue;
      }

      // TODO(brian): assert other toolChoice values

      const tool = toolCtx[toolCall.name];
      if (!tool) {
        logger.warn(
          {
            function: toolCall.name,
            speech_id: speechHandle.id,
          },
          `unknown AI function ${toolCall.name}`,
        );
        continue;
      }

      if (!isFunctionTool(tool)) {
        logger.error(
          {
            function: toolCall.name,
            speech_id: speechHandle.id,
          },
          `unknown tool type: ${typeof tool}`,
        );
        continue;
      }

      let parsedArgs: object | undefined;

      // Ensure valid arguments
      try {
        const jsonArgs = JSON.parse(toolCall.args);

        if (isZodSchema(tool.parameters)) {
          const result = await parseZodSchema<object>(tool.parameters, jsonArgs);
          if (result.success) {
            parsedArgs = result.data;
          } else {
            throw result.error;
          }
        } else {
          parsedArgs = jsonArgs;
        }
      } catch (rawError) {
        const error = toError(rawError);
        logger.error(
          {
            function: toolCall.name,
            arguments: toolCall.args,
            speech_id: speechHandle.id,
            error: error.message,
          },
          `tried to call AI function ${toolCall.name} with invalid arguments`,
        );
        toolCompleted(
          createToolOutput({
            toolCall,
            exception: error,
          }),
        );
        continue;
      }

      if (!toolOutput.firstToolStartedFuture.done) {
        toolOutput.firstToolStartedFuture.resolve();
      }

      onToolExecutionStarted(toolCall);

      logger.info(
        {
          function: toolCall.name,
          arguments: parsedArgs,
          speech_id: speechHandle.id,
        },
        'Executing LLM tool call',
      );

      const toolExecution = asyncLocalStorage.run({ functionCall: toolCall }, async () => {
        return await tool.execute(parsedArgs, {
          ctx: new RunContext(session, speechHandle, toolCall),
          toolCallId: toolCall.callId,
          abortSignal: signal,
        });
      });

      const _tracableToolExecutionImpl = async (toolExecTask: Promise<unknown>, span: Span) => {
        span.setAttribute(traceTypes.ATTR_FUNCTION_TOOL_NAME, toolCall.name);
        span.setAttribute(traceTypes.ATTR_FUNCTION_TOOL_ARGS, toolCall.args);

        // await for task to complete, if task is aborted, set exception
        let toolOutput: ToolExecutionOutput | undefined;
        try {
          const { result, isAborted } = await waitUntilAborted(toolExecTask, signal);
          toolOutput = createToolOutput({
            toolCall,
            exception: isAborted ? new Error('tool call was aborted') : undefined,
            output: isAborted ? undefined : result,
          });

          if (toolOutput.toolCallOutput) {
            span.setAttribute(
              traceTypes.ATTR_FUNCTION_TOOL_OUTPUT,
              toolOutput.toolCallOutput.output,
            );
            span.setAttribute(
              traceTypes.ATTR_FUNCTION_TOOL_IS_ERROR,
              toolOutput.toolCallOutput.isError,
            );
          }
        } catch (rawError) {
          logger.error(
            {
              function: toolCall.name,
              speech_id: speechHandle.id,
              error: toError(rawError).message,
            },
            'exception occurred while executing tool',
          );
          toolOutput = createToolOutput({
            toolCall,
            exception: toError(rawError),
          });

          if (toolOutput.toolCallOutput) {
            span.setAttribute(
              traceTypes.ATTR_FUNCTION_TOOL_OUTPUT,
              toolOutput.toolCallOutput.output,
            );
            span.setAttribute(traceTypes.ATTR_FUNCTION_TOOL_IS_ERROR, true);
          }
        } finally {
          if (!toolOutput) throw new Error('toolOutput is undefined');
          toolCompleted(toolOutput);
        }
      };

      const tracableToolExecution = (toolExecTask: Promise<unknown>) =>
        tracer.startActiveSpan(async (span) => _tracableToolExecutionImpl(toolExecTask, span), {
          name: 'function_tool',
        });

      // wait, not cancelling all tool calling tasks
      tasks.push(tracableToolExecution(toolExecution));
    }

    await Promise.allSettled(tasks);
    if (toolOutput.output.length > 0) {
      logger.debug(
        {
          speech_id: speechHandle.id,
        },
        'tools execution completed',
      );
    }
  };

  return [Task.from(executeToolsTask, controller, 'performToolExecutions'), toolOutput];
}

type Aborted<T> =
  | {
      result: T;
      isAborted: false;
    }
  | {
      result: undefined;
      isAborted: true;
    };

async function waitUntilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<Aborted<T>> {
  const abortFut = new Future<Aborted<T>>();

  const resolveAbort = () => {
    if (!abortFut.done) {
      abortFut.resolve({ result: undefined, isAborted: true });
    }
  };

  signal.addEventListener('abort', resolveAbort);

  promise
    .then((r) => {
      if (!abortFut.done) {
        abortFut.resolve({ result: r, isAborted: false });
      }
    })
    .catch((e) => {
      if (!abortFut.done) {
        abortFut.reject(e);
      }
    })
    .finally(() => {
      signal.removeEventListener('abort', resolveAbort);
    });

  return await abortFut.await;
}

export function removeInstructions(chatCtx: ChatContext) {
  // loop in case there are items with the same id (shouldn't happen!)
  while (true) {
    const idx = chatCtx.indexById(INSTRUCTIONS_MESSAGE_ID);
    if (idx !== undefined) {
      chatCtx.items.splice(idx, 1);
    } else {
      break;
    }
  }
}
