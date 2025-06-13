// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { Future, Task } from '../utils.js';
import type { LLMNode, TTSNode } from './io.js';
import type { ParticipantAudioOutput, ParticipantTranscriptionOutput } from './room_io.js';

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
  controller: AbortController,
): [Task<void>, _LLMGenerationData] {
  const textStream = new IdentityTransform<string>();
  const outputWriter = textStream.writable.getWriter();
  const data = new _LLMGenerationData(textStream.readable);

  const inferenceTask = async (signal: AbortSignal) => {
    let llmStreamReader: ReadableStreamDefaultReader<any> | null = null;
    let llmStream: ReadableStream<string | ChatChunk> | null = null;

    try {
      llmStream = await node(chatCtx, modelSettings);
      if (llmStream === null) {
        await outputWriter.close();
        return;
      }

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
          await outputWriter.write(chunk);
          // TODO(shubhra): better way to check??
        } else if ('choices' in chunk) {
          const content = chunk.choices[0]?.delta.content;
          if (!content) continue;
          data.generatedText += content;
          await outputWriter.write(content);
        } else {
          throw new Error(`Unexpected chunk type: ${JSON.stringify(chunk)}`);
        }
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
      await outputWriter.close();
    }
  };

  return [Task.from((controller) => inferenceTask(controller.signal), controller), data];
}

export function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string>,
  modelSettings: any, // TODO(AJS-59): add type
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
    Task.from((controller) => inferenceTask(controller.signal), controller),
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
  textOutput?: ParticipantTranscriptionOutput,
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
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Abort signal was triggered, handle gracefully
      return;
    }
    throw error;
  } finally {
    textOutput?.flush();
    reader?.releaseLock();
  }
}

export function performTextForwarding(
  source: ReadableStream<string>,
  controller: AbortController,
  textOutput?: ParticipantTranscriptionOutput,
): [Task<void>, _TextOut] {
  const out = {
    text: '',
    firstTextFut: new Future(),
  };
  return [
    Task.from((controller) => forwardText(source, out, controller.signal, textOutput), controller),
    out,
  ];
}

export interface _AudioOut {
  audio: Array<AudioFrame>;
  firstFrameFut: Future;
}

async function forwardAudio(
  ttsStream: ReadableStream<AudioFrame>,
  audioOuput: ParticipantAudioOutput,
  out: _AudioOut,
  signal?: AbortSignal,
): Promise<void> {
  const reader = ttsStream.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

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
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Abort signal was triggered, handle gracefully
      return;
    }
    throw error;
  } finally {
    reader?.releaseLock();
    audioOuput.flush();
  }
}

export function performAudioForwarding(
  ttsStream: ReadableStream<AudioFrame>,
  audioOutput: ParticipantAudioOutput,
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
    ),
    out,
  ];
}
