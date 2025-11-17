// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AudioResampler } from '@livekit/rtc-node';
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
import { Future, Task, shortuuid, toError } from '../utils.js';
import { type Agent, type ModelSettings, asyncLocalStorage, isStopResponse } from './agent.js';
import type { AgentSession } from './agent_session.js';
import type { AudioOutput, LLMNode, TTSNode, TextOutput } from './io.js';
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

// TODO(brian): PR3 - Add @tracer.startActiveSpan('llm_node') decorator/wrapper
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

  const inferenceTask = async (signal: AbortSignal) => {
    let llmStreamReader: ReadableStreamDefaultReader<string | ChatChunk> | null = null;
    let llmStream: ReadableStream<string | ChatChunk> | null = null;

    try {
      llmStream = await node(chatCtx, toolCtx, modelSettings);
      if (llmStream === null) {
        await textWriter.close();
        return;
      }

      // TODO(brian): add support for dynamic tools

      llmStreamReader = llmStream.getReader();
      while (true) {
        if (signal.aborted) {
          break;
        }
        const { done, value: chunk } = await llmStreamReader.read();
        if (done) {
          break;
        }

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

  return [
    Task.from((controller) => inferenceTask(controller.signal), controller, 'performLLMInference'),
    data,
  ];
}

// TODO(brian): PR3 - Add @tracer.startActiveSpan('tts_node') decorator/wrapper
export function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string>,
  modelSettings: ModelSettings,
  controller: AbortController,
): [Task<void>, ReadableStream<AudioFrame>] {
  const audioStream = new IdentityTransform<AudioFrame>();
  const outputWriter = audioStream.writable.getWriter();
  const audioOutputStream = audioStream.readable;

  const inferenceTask = async (signal: AbortSignal) => {
    let ttsStreamReader: ReadableStreamDefaultReader<AudioFrame> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;

    try {
      ttsStream = await node(text, modelSettings);
      if (ttsStream === null) {
        await outputWriter.close();
        return;
      }

      ttsStreamReader = ttsStream.getReader();
      while (true) {
        if (signal.aborted) {
          break;
        }
        const { done, value: chunk } = await ttsStreamReader.read();
        if (done) {
          break;
        }
        await outputWriter.write(chunk);
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
    }
  };

  return [
    Task.from((controller) => inferenceTask(controller.signal), controller, 'performTTSInference'),
    audioOutputStream,
  ];
}

export interface _TextOut {
  text: string;
  firstTextFut: Future;
}

async function forwardText(
  source: ReadableStream<string>,
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
      out.text += delta;
      if (textOutput !== null) {
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
  source: ReadableStream<string>,
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
  firstFrameFut: Future;
}

async function forwardAudio(
  ttsStream: ReadableStream<AudioFrame>,
  audioOuput: AudioOutput,
  out: _AudioOut,
  signal?: AbortSignal,
): Promise<void> {
  const reader = ttsStream.getReader();
  let resampler: AudioResampler | null = null;

  try {
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

      // set the first frame future if not already set
      // (after completing the first frame)
      if (!out.firstFrameFut.done) {
        out.firstFrameFut.resolve();
      }
    }
  } finally {
    reader?.releaseLock();
    if (resampler) {
      for (const f of resampler.flush()) {
        await audioOuput.captureFrame(f);
      }
    }
    audioOuput.flush();
  }
}

export function performAudioForwarding(
  ttsStream: ReadableStream<AudioFrame>,
  audioOutput: AudioOutput,
  controller: AbortController,
): [Task<void>, _AudioOut] {
  const out = {
    audio: [],
    firstFrameFut: new Future(),
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

// TODO(brian): PR3 - Add @tracer.startActiveSpan('function_tool') wrapper for each tool execution
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

      const tracableToolExecution = async (toolExecTask: Promise<unknown>) => {
        // TODO(brian): add tracing

        // await for task to complete, if task is aborted, set exception
        let toolOutput: ToolExecutionOutput | undefined;
        try {
          const { result, isAborted } = await waitUntilAborted(toolExecTask, signal);
          toolOutput = createToolOutput({
            toolCall,
            exception: isAborted ? new Error('tool call was aborted') : undefined,
            output: isAborted ? undefined : result,
          });
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
        } finally {
          if (!toolOutput) throw new Error('toolOutput is undefined');
          toolCompleted(toolOutput);
        }
      };

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
