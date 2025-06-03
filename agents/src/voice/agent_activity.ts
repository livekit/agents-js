// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { Heap } from 'heap-js';
import type { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatMessage, ChatRole } from '../llm/chat_context.js';
import type { LLM } from '../llm/index.js';
import { log } from '../log.js';
import { SpeechHandle } from '../pipeline/speech_handle.js';
import type { STT, SpeechEvent } from '../stt/stt.js';
import type { TTS } from '../tts/tts.js';
import { Future } from '../utils.js';
import type { VADEvent } from '../vad.js';
import { StopResponse } from './agent.js';
import type { Agent } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';
import {
  performAudioForwarding,
  performLLMInference,
  performTTSInference,
  performTextForwarding,
} from './generation.js';

export class AgentActivity implements RecognitionHooks {
  private started = false;
  private audioRecognition?: AudioRecognition;
  private logger = log();
  private turnDetectionMode?: string;
  private _draining = false;
  private currentSpeech?: SpeechHandle;
  private speechQueue: Heap<[number, number, SpeechHandle]>; // [priority, timestamp, speechHandle]
  private q_updated: Future;
  agent: Agent;
  agentSession: AgentSession;

  constructor(agent: Agent, agentSession: AgentSession) {
    this.agent = agent;
    this.agentSession = agentSession;
    // relies on JavaScript's built-in lexicographic array comparison behavior, which checks elements of the array one by one
    this.speechQueue = new Heap<[number, number, SpeechHandle]>(Heap.maxComparator);
    this.q_updated = new Future();
  }

  async start(): Promise<void> {
    this.agent.agentActivity = this;
    this.audioRecognition = new AudioRecognition(
      this,
      this.agentSession.vad,
      this.agentSession.options.minEndpointingDelay,
      this.agentSession.options.maxEndpointingDelay,
      // Arrow function preserves the Agent context
      (...args) => this.agent.sttNode(...args),
      this.turnDetectionMode === 'manual',
    );
    this.audioRecognition.start();
    this.started = true;

    this.mainTask();

    // TODO(shubhra): Add turn detection mode
  }

  get stt(): STT {
    // TODO(AJS-51): Allow components to be defined in Agent class
    return this.agentSession.stt;
  }

  get llm(): LLM {
    // TODO(AJS-51): Allow components to be defined in Agent class
    return this.agentSession.llm;
  }

  get tts(): TTS {
    // TODO(AJS-51): Allow components to be defined in Agent class
    return this.agentSession.tts;
  }

  get draining(): boolean {
    return this._draining;
  }

  get allowInterruptions(): boolean {
    // TODO(AJS-51): Allow options to be defined in Agent class
    return this.agentSession.options.allowInterruptions;
  }

  updateAudioInput(audioStream: ReadableStream<AudioFrame>): void {
    this.audioRecognition?.setInputAudioStream(audioStream);
  }

  onStartOfSpeech(ev: VADEvent): void {
    this.logger.info('Start of speech', ev);
  }

  onEndOfSpeech(ev: VADEvent): void {
    this.logger.info('End of speech', ev);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onVADInferenceDone(ev: VADEvent): void {
    if (this.currentSpeech && !this.currentSpeech.interrupted && this.currentSpeech.done) {
      this.logger.info({ 'speech id': this.currentSpeech.id }, 'speech interrupted by VAD');
      // this.currentSpeech.interrupt();
    }
  }

  onInterimTranscript(ev: SpeechEvent): void {
    this.logger.info('Interim transcript', ev);
  }

  onFinalTranscript(ev: SpeechEvent): void {
    this.logger.info(`Final transcript ${ev.alternatives![0].text}`);
  }

  async onEndOfTurn(info: EndOfTurnInfo): Promise<boolean> {
    if (this.draining) {
      this.logger.warn({ user_input: info.newTranscript }, 'skipping user input, task is draining');
      // copied from python:
      // TODO(shubhra): should we "forward" this new turn to the next agent/activity?
      return true;
    }
    if (
      this.stt &&
      this.turnDetectionMode !== 'manual' &&
      this.currentSpeech &&
      this.currentSpeech.allowInterruptions &&
      !this.currentSpeech.interrupted &&
      this.agentSession.options.minInterruptionWords > 0 &&
      info.newTranscript.split(' ').length < this.agentSession.options.minInterruptionWords
    ) {
      // avoid interruption if the new transcript is too short
      return false;
    }
    this.userTurnCompleted(info);
    return true;
  }

  retrieveChatCtx(): ChatContext {
    return this.agentSession.chatCtx;
  }

  private async mainTask(): Promise<void> {
    while (true) {
      await this.q_updated.await;
      while (this.speechQueue.size() > 0) {
        const heapItem = this.speechQueue.pop();
        if (!heapItem) {
          throw new Error('Speech queue is empty');
        }
        const speechHandle = heapItem[2];
        this.currentSpeech = speechHandle;
        speechHandle.authorizePlayout();
        await speechHandle.waitForPlayout();
        this.currentSpeech = undefined;
        this.q_updated = new Future();
      }
    }
  }

  private wakeupMainTask(): void {
    this.q_updated.resolve();
  }

  private generateReply(
    userMessage?: ChatMessage,
    chatCtx?: ChatContext,
    instructions?: string,
    allowInterruptions?: boolean,
  ): SpeechHandle {
    // TODO(AJS-32): Add realtime model support for generating a reply

    // TODO(shubhra) handle tool calls
    const handle = SpeechHandle.create(
      allowInterruptions === undefined ? this.allowInterruptions : allowInterruptions,
      0,
      this.currentSpeech,
    );

    if (instructions) {
      instructions = `${this.agent.instructions}\n${instructions}`;
    }

    this.pipelineReplyTask(
      handle,
      chatCtx || this.agent.chatCtx,
      instructions,
      userMessage?.copy(),
    ).then(() => {
      this.onPipelineReplyDone();
    });
    this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    return handle;
  }

  private onPipelineReplyDone(): void {
    if (!this.speechQueue.peek() && (!this.currentSpeech || this.currentSpeech.done)) {
      this.agentSession._updateAgentState('listening');
    }
  }

  private async userTurnCompleted(info: EndOfTurnInfo): Promise<void> {
    // TODO(AJS-40) handle old task cancellation

    // When the audio recognition detects the end of a user turn:
    //  - check if realtime model server-side turn detection is enabled
    //  - check if there is no current generation happening
    //  - cancel the current generation if it allows interruptions (otherwise skip this current
    //  turn)
    //  - generate a reply to the user input

    // TODO(AJS-32): Add realtime model supppourt

    if (this.currentSpeech) {
      if (!this.currentSpeech.allowInterruptions) {
        this.logger.warn(
          { user_input: info.newTranscript },
          'skipping user input, current speech generation cannot be interrupted',
        );
        return;
      }

      this.logger.info(
        { 'speech id': this.currentSpeech.id },
        'speech interrupted, new user turn detected',
      );

      this.currentSpeech.interrupt();
      // TODO(AJS-32): Add realtime model support for interrupting the current generation
    }

    const userMessage = new ChatMessage({
      role: ChatRole.USER,
      content: info.newTranscript,
    });

    // create a temporary mutable chat context to pass to onUserTurnCompleted
    // the user can edit it for the current generation, but changes will not be kept inside the
    // Agent.chatCtx
    const chatCtx = this.agent.chatCtx.copy();

    try {
      await this.agent.onUserTurnCompleted(chatCtx, userMessage);
    } catch (e) {
      if (e instanceof StopResponse) {
        return;
      }
      this.logger.error({ error: e }, 'error occurred during onUserTurnCompleted');
    }

    this.generateReply(userMessage, chatCtx);
    //TODO(AJS-40) handle interruptions
  }

  private async pipelineReplyTask(
    speechHandle: SpeechHandle,
    chatCtx: ChatContext,
    instructions?: string,
    newMessage?: ChatMessage,
  ): Promise<void> {
    // Create abort controller for this speech generation
    const abortController = new AbortController();
    const signal = abortController.signal;

    // TODO(AJS-54): add transcription/text output

    const audioOutput = this.agentSession.audioOutput;

    chatCtx = chatCtx.copy();

    if (newMessage) {
      chatCtx.insertItem(newMessage);
      this.agent._chatCtx.insertItem(newMessage);
      this.agentSession._conversationItemAdded(newMessage);
    }

    // TODO(AJS-57): handle instructions

    this.agentSession._updateAgentState('thinking');
    const tasks: Array<Promise<void>> = [];
    const [llmTask, llmGenData] = performLLMInference(
      (...args) => this.agent.llmNode(...args),
      chatCtx,
      {},
      signal, // Pass abort signal
    );
    tasks.push(llmTask);

    const [ttsTextInput, llmOutput] = llmGenData.textStream.tee();

    let ttsTask: Promise<void> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;
    if (audioOutput) {
      [ttsTask, ttsStream] = performTTSInference(
        (...args) => this.agent.ttsNode(...args),
        ttsTextInput,
        {},
        signal, // Pass abort signal
      );
      tasks.push(ttsTask);
    }

    await speechHandle.waitIfNotInterrupted([speechHandle.waitForAuthorization()]);
    if (speechHandle.interrupted) {
      this.logger.info({ speech_id: speechHandle.id }, 'speech interrupted');
      abortController.abort(); // Abort all tasks
      await Promise.allSettled(tasks); // Wait for tasks to complete
      return;
    }

    const [textForwardTask, textOutput] = performTextForwarding(null, llmOutput, signal);
    tasks.push(textForwardTask);

    const onFirstFrame = () => {
      this.agentSession._updateAgentState('speaking');
    };

    if (audioOutput) {
      if (ttsStream) {
        const [forwardTask, audioOut] = performAudioForwarding(ttsStream, audioOutput, signal);
        tasks.push(forwardTask);
        audioOut.firstFrameFut.await.then(onFirstFrame);
      } else {
        throw Error('ttsStream is null when audioOutput is enabled');
      }
    } else {
      textOutput.firstTextFut.await.then(onFirstFrame);
    }
    // TODO(shubhra): handle tool calls

    await speechHandle.waitIfNotInterrupted(tasks);

    // TODO(shubhra): add waiting for audio playout in audio output

    if (speechHandle.interrupted) {
      abortController.abort();
      await Promise.allSettled(tasks);
      return;
    }

    const message = ChatMessage.create({
      role: ChatRole.ASSISTANT,
      text: textOutput.text,
    });
    chatCtx.insertItem(message);
    this.agent._chatCtx.insertItem(message);
    this.agentSession._conversationItemAdded(message);

    await Promise.all(tasks);

    this.logger.info({ speech_id: speechHandle.id }, 'playout completed');
    speechHandle.markPlayoutDone();
  }

  private scheduleSpeech(speechHandle: SpeechHandle, priority: number): void {
    // Monotonic time to avoid near 0 collisions
    this.speechQueue.push([priority, Number(process.hrtime.bigint()), speechHandle]);
    this.wakeupMainTask();
  }
}
