// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { Heap } from 'heap-js';
import type { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatMessage } from '../llm/chat_context.js';
import type { LLM, ToolChoice, ToolContext } from '../llm/index.js';
import { log } from '../log.js';
import type { STT, SpeechEvent } from '../stt/stt.js';
import type { TTS } from '../tts/tts.js';
import type { Task } from '../utils.js';
import { Future } from '../utils.js';
import type { VADEvent } from '../vad.js';
import type { Agent } from './agent.js';
import { StopResponse } from './agent.js';
import { type AgentSession, AgentSessionEvent, type TurnDetectionMode } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';
import {
  type _AudioOut,
  type _TextOut,
  performAudioForwarding,
  performLLMInference,
  performTTSInference,
  performTextForwarding,
  performToolExecutions,
} from './generation.js';
import { SpeechHandle } from './speech_handle.js';

export class AgentActivity implements RecognitionHooks {
  private static readonly REPLY_TASK_CANCEL_TIMEOUT = 5000;
  private started = false;
  private audioRecognition?: AudioRecognition;
  private logger = log();
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
      this.agentSession.turnDetection,
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

  get turnDetection(): TurnDetectionMode | undefined {
    // TODO(brian): prioritize using agent.turn_detection
    return this.agentSession.turnDetection;
  }

  updateAudioInput(audioStream: ReadableStream<AudioFrame>): void {
    this.audioRecognition?.setInputAudioStream(audioStream);
  }

  commitUserTurn() {
    if (!this.audioRecognition) {
      throw new Error('AudioRecognition is not initialized');
    }

    // TODO(brian): add audio_detached flag
    const audioDetached = false;
    this.audioRecognition.commitUserTurn(audioDetached);
  }

  clearUserTurn() {
    if (!this.audioRecognition) {
      throw new Error('AudioRecognition is not initialized');
    }

    this.audioRecognition.clearUserTurn();
  }

  onStartOfSpeech(ev: VADEvent): void {
    this.logger.info('Start of speech', ev);
  }

  onEndOfSpeech(ev: VADEvent): void {
    this.logger.info('End of speech', ev);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onVADInferenceDone(ev: VADEvent): void {
    // skip speech handle interruption for manual and realtime model
    if (this.turnDetection === 'manual' || this.turnDetection === 'realtime_llm') {
      return;
    }

    if (
      this.currentSpeech &&
      !this.currentSpeech.interrupted &&
      this.currentSpeech.allowInterruptions
    ) {
      // this.logger.info({ 'speech id': this.currentSpeech.id }, 'speech interrupted by VAD');
      // this.currentSpeech.interrupt();
    }
  }

  onInterimTranscript(ev: SpeechEvent): void {
    this.agentSession.emit(AgentSessionEvent.UserInputTranscribed, {
      transcript: ev.alternatives![0].text,
      isFinal: false,
      // TODO(AJS-106): add multi participant support
      speakerId: null,
    });
  }

  onFinalTranscript(ev: SpeechEvent): void {
    this.agentSession.emit(AgentSessionEvent.UserInputTranscribed, {
      transcript: ev.alternatives![0].text,
      isFinal: true,
      // TODO(AJS-106): add multi participant support
      speakerId: null,
    });
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
      this.turnDetection !== 'manual' &&
      this.currentSpeech &&
      this.currentSpeech.allowInterruptions &&
      !this.currentSpeech.interrupted &&
      this.agentSession.options.minInterruptionWords > 0 &&
      info.newTranscript.split(' ').length < this.agentSession.options.minInterruptionWords
    ) {
      // avoid interruption if the new_transcript is too short
      this.logger.info('skipping user input, new_transcript is too short');
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
    toolChoice?: ToolChoice,
  ): SpeechHandle {
    // TODO(AJS-32): Add realtime model support for generating a reply

    // TODO(shubhra) handle tool calls
    const handle = SpeechHandle.create(
      allowInterruptions === undefined ? this.allowInterruptions : allowInterruptions,
      0,
      this.currentSpeech,
    );
    this.logger.info({ speech_id: handle.id }, 'Creating speech handle');

    if (instructions) {
      instructions = `${this.agent.instructions}\n${instructions}`;
    }

    this.pipelineReplyTask(
      handle,
      chatCtx || this.agent.chatCtx,
      this.agent.toolCtx,
      // TODO(brian): make tool choice as model settings
      toolChoice || 'auto',
      instructions,
      userMessage,
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
    this.logger.info('userTurnCompleted', info);
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

    const userMessage = ChatMessage.create({
      role: 'user',
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
    toolCtx: ToolContext,
    toolChoice: ToolChoice,
    instructions?: string,
    newMessage?: ChatMessage,
  ): Promise<void> {
    const replyAbortController = new AbortController();

    // TODO(AJS-54): add transcription/text output

    const audioOutput = this.agentSession.audioOutput;
    const transcriptionOutput = this.agentSession._transcriptionOutput;

    chatCtx = chatCtx.copy();

    if (newMessage) {
      chatCtx.insert(newMessage);
      this.agent._chatCtx.insert(newMessage);
      this.agentSession._conversationItemAdded(newMessage);
    }

    // TODO(AJS-57): handle instructions

    this.agentSession._updateAgentState('thinking');
    const tasks: Array<Task<void>> = [];
    const [llmTask, llmGenData] = performLLMInference(
      // preserve  `this` context in llmNode
      (...args) => this.agent.llmNode(...args),
      chatCtx,
      {},
      replyAbortController,
    );
    tasks.push(llmTask);

    const [ttsTextInput, llmOutput] = llmGenData.textStream.tee();

    let ttsTask: Task<void> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;
    if (audioOutput) {
      [ttsTask, ttsStream] = performTTSInference(
        (...args) => this.agent.ttsNode(...args),
        ttsTextInput,
        {},
        replyAbortController,
      );
      tasks.push(ttsTask);
    }

    await speechHandle.waitIfNotInterrupted([speechHandle.waitForAuthorization()]);
    if (speechHandle.interrupted) {
      replyAbortController.abort();
      await Promise.allSettled(
        tasks.map((task) => task.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT)),
      );
      return;
    }

    const replyStartedAt = Date.now();
    const trNodeResult = await this.agent.transcriptionNode(llmOutput, {}); // TODO(AJS-59): add model settings
    let textOut: _TextOut | null = null;
    if (trNodeResult) {
      const [textForwardTask, _textOut] = performTextForwarding(
        trNodeResult,
        replyAbortController,
        transcriptionOutput,
      );
      tasks.push(textForwardTask);
      textOut = _textOut;
    }

    const onFirstFrame = () => {
      this.agentSession._updateAgentState('speaking');
    };

    let audioOut: _AudioOut | null = null;
    if (audioOutput) {
      if (ttsStream) {
        const [forwardTask, _audioOut] = performAudioForwarding(
          ttsStream,
          audioOutput,
          replyAbortController,
        );
        audioOut = _audioOut;
        tasks.push(forwardTask);
        audioOut.firstFrameFut.await.then(onFirstFrame);
      } else {
        throw Error('ttsStream is null when audioOutput is enabled');
      }
    } else {
      textOut?.firstTextFut.await.then(onFirstFrame);
    }

    const [executeToolsTask, toolOutput] = performToolExecutions({
      session: this.agentSession,
      speechHandle,
      toolCtx,
      toolChoice,
      toolCallStream: llmGenData.toolCallStream,
    });
    tasks.push(executeToolsTask);

    await speechHandle.waitIfNotInterrupted(tasks.map((task) => task.result));

    if (audioOutput) {
      await speechHandle.waitIfNotInterrupted([audioOutput.waitForPlayout()]);
    }

    if (speechHandle.interrupted) {
      this.logger.debug(
        { speech_id: speechHandle.id },
        'Aborting all pipeline reply tasks due to interruption',
      );
      replyAbortController.abort();
      await Promise.allSettled(
        tasks.map((task) => task.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT)),
      );
      // TODO(AJS-87): add syncronizher and transcripts

      if (audioOutput) {
        audioOutput.clearBuffer();
        const playbackEv = await audioOutput.waitForPlayout();
        if (audioOut?.firstFrameFut.done) {
          // playback EV is valid only if the first frame was already played
          this.logger.info(
            { speech_id: speechHandle.id, playbackPosition: playbackEv.playbackPosition },
            'playout interrupted',
          );
        }
      }

      const message = ChatMessage.create({
        role: 'assistant',
        content: textOut?.text || '',
        id: llmGenData.id,
        interrupted: true,
        createdAt: replyStartedAt,
      });
      chatCtx.insert(message);
      this.agent._chatCtx.insert(message);
      if (this.agentSession.agentState === 'speaking') {
        this.agentSession._updateAgentState('listening');
      }
      this.agentSession._conversationItemAdded(message);

      this.logger.info(
        { speech_id: speechHandle.id, message: textOut?.text },
        'playout completed with interrupt',
      );
      // TODO(shubhra) add chat message to speech handle
      speechHandle.markPlayoutDone();
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    if (textOut && textOut.text) {
      const message = ChatMessage.create({
        role: 'assistant',
        id: llmGenData.id,
        interrupted: false,
        createdAt: replyStartedAt,
        content: textOut.text,
      });
      chatCtx.insert(message);
      this.agent._chatCtx.insert(message);
      this.agentSession._conversationItemAdded(message);
      this.logger.info(
        { speech_id: speechHandle.id, message: textOut.text },
        'playout completed without interruption',
      );
    }

    if (toolOutput.output.length > 0) {
      this.agentSession._updateAgentState('thinking');
    } else if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
    }

    speechHandle.markPlayoutDone();
    await executeToolsTask.result;

    if (toolOutput.output.length > 0) {
      // TODO(brian): handle actual tool execution output
    }
  }

  private scheduleSpeech(speechHandle: SpeechHandle, priority: number): void {
    // Monotonic time to avoid near 0 collisions
    this.speechQueue.push([priority, Number(process.hrtime.bigint()), speechHandle]);
    this.wakeupMainTask();
  }
}
