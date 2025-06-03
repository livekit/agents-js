// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, AudioSource } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { Future } from '../utils.js';
import type { LLMNode, TTSNode } from './io.js';

/* @internal */
export class _LLMGenerationData {
  generatedText: string = '';
  id: string;

  constructor(public readonly textStream: ReadableStream<string>) {
    // TODO(AJS-60): standardize id generation - same as python
    this.id = randomUUID();
  }
}

export function performLLMInference(
  node: LLMNode,
  chatCtx: ChatContext,
  modelSettings: any, // TODO(AJS-59): add type
  signal?: AbortSignal,
): [Promise<void>, _LLMGenerationData] {
  const textStream = new IdentityTransform<string>();
  const writer = textStream.writable.getWriter();
  const data = new _LLMGenerationData(textStream.readable);

  const inferenceTask = async () => {
    let reader: ReadableStreamDefaultReader<any> | null = null;
    let llmStream: ReadableStream<string | ChatChunk> | null = null;

    try {
      llmStream = await node(chatCtx, modelSettings);
      if (llmStream === null) {
        await writer.close();
        return;
      }

      reader = llmStream.getReader();
      while (true) {
        // Check abort signal before each read
        if (signal?.aborted) {
          break;
        }

        const { done, value: chunk } = await reader.read();
        if (done) {
          break;
        }

        // Check abort signal after receiving chunk
        if (signal?.aborted) {
          break;
        }

        if (typeof chunk === 'string') {
          data.generatedText += chunk;
          await writer.write(chunk);
          // TODO(shubhra): better way to check??
        } else if ('choices' in chunk) {
          const content = chunk.choices[0]?.delta.content;
          if (!content) continue;
          data.generatedText += content;
          await writer.write(content);
        } else {
          throw new Error(`Unexpected chunk type: ${JSON.stringify(chunk)}`);
        }
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        // Silently handle abort - this is expected
        console.log('+++++llm stream aborted in performLLMInference');
        return;
      }
      throw error;
    } finally {
      // Cleanup
      if (reader) {
        try {
          reader.releaseLock();
        } catch (e) {
          console.log('+++++llm reader release lock failed', e);
        }
      }
      if (llmStream) {
        try {
          await llmStream.cancel();
        } catch (e) {
          console.log('+++++llm stream cancel failed', e);
        }
      }
      try {
        await writer.close();
      } catch (e) {
        console.log('+++++llm writer close failed', e);
      }
    }
  };

  return [inferenceTask(), data];
}

export function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string>,
  modelSettings: any, // TODO(AJS-59): add type
  signal?: AbortSignal,
): [Promise<void>, ReadableStream<AudioFrame>] {
  const audioStream = new IdentityTransform<AudioFrame>();
  const writer = audioStream.writable.getWriter();
  const audioOutputStream = audioStream.readable;

  const inferenceTask = async () => {
    let reader: ReadableStreamDefaultReader<AudioFrame> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;

    try {
      ttsStream = await node(text, modelSettings);
      if (ttsStream === null) {
        await writer.close();
        return;
      }

      reader = ttsStream.getReader();
      while (true) {
        // Check abort signal before each read
        if (signal?.aborted) {
          break;
        }

        const { done, value: chunk } = await reader.read();
        if (done) break;

        // Check abort signal after receiving chunk
        if (signal?.aborted) {
          break;
        }

        await writer.write(chunk);
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        // Silently handle abort - this is expected
        return;
      }
      throw error;
    } finally {
      // Cleanup
      if (reader) {
        try {
          reader.releaseLock();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      if (ttsStream) {
        try {
          await ttsStream.cancel();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
      try {
        await writer.close();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  };

  return [inferenceTask(), audioOutputStream];
}

export interface _TextOutput {
  text: string;
  firstTextFut: Future;
}

async function forwardText(
  textOutput: _TextOutput | null,
  source: ReadableStream<string>,
  out: _TextOutput,
  signal?: AbortSignal,
): Promise<void> {
  const reader = source.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();

      const { done, value: delta } = await reader.read();
      if (done) break;
      out.text += delta;
      if (!out.firstTextFut.done) {
        out.firstTextFut.resolve();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      reader.cancel().catch(() => {});
      throw error;
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore errors if reader is already released
    }
  }
}

export function performTextForwarding(
  textOutput: _TextOutput | null,
  source: ReadableStream<string>,
  signal?: AbortSignal,
): [Promise<void>, _TextOutput] {
  const out = {
    text: '',
    firstTextFut: new Future(),
  };
  return [forwardText(textOutput, source, out, signal), out];
}

export interface _AudioOutput {
  audio: Array<AudioFrame>;
  firstFrameFut: Future;
}

async function forwardAudio(
  ttsStream: ReadableStream<AudioFrame>,
  audioOuput: AudioSource,
  out: _AudioOutput,
  signal?: AbortSignal,
): Promise<void> {
  const reader = ttsStream.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();

      const { done, value: frame } = await reader.read();
      if (done) break;
      // TODO(AJS-56) handle resampling
      await audioOuput.captureFrame(frame);
      out.audio.push(frame);
      if (!out.firstFrameFut.done) {
        out.firstFrameFut.resolve();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      reader.cancel().catch(() => {});
      throw error;
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore errors if reader is already released
    }
  }
}

export function performAudioForwarding(
  ttsStream: ReadableStream<AudioFrame>,
  audioOutput: AudioSource,
  signal?: AbortSignal,
): [Promise<void>, _AudioOutput] {
  const out = {
    audio: [],
    firstFrameFut: new Future(),
  };
  return [forwardAudio(ttsStream, audioOutput, out, signal), out];
}
