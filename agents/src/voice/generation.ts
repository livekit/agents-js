// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, AudioSource } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'node:stream/web';
import type { ChatContext } from '../llm/chat_context.js';
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
): [Promise<void>, _LLMGenerationData] {
  const textStream = new IdentityTransform<string>();
  const writer = textStream.writable.getWriter();
  const data = new _LLMGenerationData(textStream.readable);

  const inferenceTask = async () => {
    const llmStream = await node(chatCtx, modelSettings);
    if (llmStream === null) {
      return;
    }
    try {
      const reader = llmStream.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) {
          break;
        }
        if (typeof chunk === 'string') {
          data.generatedText += chunk;
          writer.write(chunk);
          // TODO(shubhra): better way to check??
        } else if ('choices' in chunk) {
          const content = chunk.choices[0]?.delta.content;
          if (!content) continue;
          data.generatedText += content;
          writer.write(content);
        } else {
          throw new Error(`Unexpected chunk type: ${JSON.stringify(chunk)}`);
        }
      }
    } finally {
      writer.close();
    }
  };
  return [inferenceTask(), data];
}

export function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string>,
  modelSettings: any, // TODO(AJS-59): add type
): [Promise<void>, ReadableStream<AudioFrame>] {
  const audioStream = new IdentityTransform<AudioFrame>();
  const writer = audioStream.writable.getWriter();
  const audioOutputStream = audioStream.readable;

  const inferenceTask = async () => {
    try {
      const ttsNode = await node(text, modelSettings);
      if (ttsNode === null) {
        writer.close();
        return;
      }

      const reader = ttsNode.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        writer.write(chunk);
      }
    } finally {
      writer.close();
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
): Promise<void> {
  const reader = source.getReader();
  while (true) {
    const { done, value: delta } = await reader.read();
    if (done) break;
    out.text += delta;
    if (!out.firstTextFut.done) {
      out.firstTextFut.resolve();
    }
  }
}

export function performTextForwarding(
  textOutput: _TextOutput | null,
  source: ReadableStream<string>,
): [Promise<void>, _TextOutput] {
  const out = {
    text: '',
    firstTextFut: new Future(),
  };
  return [forwardText(textOutput, source, out), out];
}

export interface _AudioOutput {
  audio: Array<AudioFrame>;
  firstFrameFut: Future;
}

async function forwardAudio(
  ttsStream: ReadableStream<AudioFrame>,
  audioOuput: AudioSource,
  out: _AudioOutput,
): Promise<void> {
  const reader = ttsStream.getReader();
  while (true) {
    const { done, value: frame } = await reader.read();
    if (done) break;
    // TODO(AJS-56) handle resampling
    await audioOuput.captureFrame(frame);
    out.audio.push(frame);
    if (!out.firstFrameFut.done) {
      out.firstFrameFut.resolve();
    }
  }
}

export function performAudioForwarding(
  ttsStream: ReadableStream<AudioFrame>,
  audioOutput: AudioSource,
): [Promise<void>, _AudioOutput] {
  const out = {
    audio: [],
    firstFrameFut: new Future(),
  };
  return [forwardAudio(ttsStream, audioOutput, out), out];
}
