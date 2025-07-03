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
import { shortuuid } from '../llm/misc.js';
import {
  type ToolChoice,
  type ToolContext,
  ToolError,
  isAgentHandoff,
  isFunctionTool,
  isToolError,
} from '../llm/tool_context.js';
import { toError } from '../llm/utils.js';
import { log } from '../log.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { Future, Task } from '../utils.js';
import { type Agent, type ModelSettings, isStopResponse } from './agent.js';
import type { AgentSession } from './agent_session.js';
import type { AudioOutput, LLMNode, TTSNode, TextOutput } from './io.js';
import { RunContext } from './run_context.js';
import type { SpeechHandle } from './speech_handle.js';

/* @internal */
export class _LLMGenerationData {
  generatedText: string = '';
  generatedToolCalls: FunctionCall[];
  id: string;

  constructor(
    public readonly textStream: ReadableStream<string>,
    public readonly toolCallStream: ReadableStream<FunctionCall>,
  ) {
    // TODO(AJS-60): standardize id generation - same as python
    this.id = shortuuid('item');
    this.generatedToolCalls = [];
  }
}

export class _ToolOutput {
  output: _JsOutput[];
  firstToolFut: Future;

  constructor() {
    this.output = [];
    this.firstToolFut = new Future();
  }
}

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
  const validTypes = ['string', 'number', 'boolean', undefined, null];

  if (validTypes.includes(typeof toolOutput)) {
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
        toolCall: { ...this.toolCall },
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
        toolCall: { ...this.toolCall },
      });
    }

    if (this.exception !== undefined) {
      return _SanitizedOutput.create({
        toolCall: { ...this.toolCall },
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
        toolCall: { ...this.toolCall },
        toolCallOutput: undefined,
      });
    }

    return _SanitizedOutput.create({
      toolCall: { ...this.toolCall },
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
  textOutput?: TextOutput,
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
      if (textOutput) {
        await textOutput.captureText(delta);
      }
      if (!out.firstTextFut.done) {
        out.firstTextFut.resolve();
      }
    }
  } finally {
    textOutput?.flush();
    reader?.releaseLock();
  }
}

export function performTextForwarding(
  source: ReadableStream<string>,
  controller: AbortController,
  textOutput?: TextOutput,
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

export function performToolExecutions({
  session,
  speechHandle,
  toolCtx,
  toolChoice,
  toolCallStream,
  controller,
}: {
  session: AgentSession;
  speechHandle: SpeechHandle;
  toolCtx: ToolContext;
  toolChoice?: ToolChoice;
  toolCallStream: ReadableStream<FunctionCall>;
  controller: AbortController;
}): [Task<void>, _ToolOutput] {
  const logger = log();
  const toolOutput = new _ToolOutput();

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

      const tool = toolCtx[toolCall.name];
      if (!tool) {
        logger.error(
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
      const jsOut = _JsOutput.create({ toolCall });

      // Ensure valid arguments
      try {
        parsedArgs = tool.parameters.parse(JSON.parse(toolCall.args));
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
        jsOut.exception = new ToolError(
          `Error when parsing arguments for tool ${toolCall.name}: ${error.message}. Make sure to pass the valid arguments.`,
        );
        toolOutput.output.push(jsOut);
        continue;
      }

      if (!toolOutput.firstToolFut.done) {
        toolOutput.firstToolFut.resolve();
      }

      logger.debug(
        {
          function: toolCall.name,
          arguments: parsedArgs,
          speech_id: speechHandle.id,
        },
        'executing tool',
      );

      const toolExecution = tool.execute(parsedArgs, {
        ctx: new RunContext(session, speechHandle, toolCall),
        toolCallId: toolCall.callId,
        abortSignal: signal,
      });

      const task = async (toolExecTask: Promise<any>) => {
        // await for task to complete, if task is aborted, set exception
        try {
          const { result, isAborted } = await waitUntilAborted(toolExecTask, signal);
          jsOut.exception = isAborted ? new Error('tool call was aborted') : undefined;
          jsOut.output = isAborted ? undefined : result;
        } catch (rawError) {
          logger.error(
            {
              function: toolCall.name,
              speech_id: speechHandle.id,
              error: toError(rawError).message,
            },
            'exception occurred while executing tool',
          );
          jsOut.exception = toError(rawError);
        } finally {
          toolOutput.output.push(jsOut);
        }
      };

      // wait, not cancelling all tool calling tasks
      tasks.push(task(toolExecution));
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
