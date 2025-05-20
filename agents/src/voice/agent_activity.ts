// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatMessage, ChatRole } from '../llm/chat_context.js';
import type { LLM } from '../llm/index.js';
import { log } from '../log.js';
import { SpeechHandle } from '../pipeline/speech_handle.js';
import type { STT, SpeechEvent } from '../stt/stt.js';
import type { VADEvent } from '../vad.js';
import { StopResponse } from './agent.js';
import type { Agent } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';
import { performLLMInference } from './generation.js';

export class AgentActivity implements RecognitionHooks {
  private started = false;
  private audioRecognition?: AudioRecognition;
  private logger = log();
  private turnDetectionMode?: string;
  private _draining = false;
  private currentSpeech?: SpeechHandle;
  agent: Agent;
  agentSession: AgentSession;

  constructor(agent: Agent, agentSession: AgentSession) {
    this.agent = agent;
    this.agentSession = agentSession;
  }

  async start(): Promise<void> {
    this.agent.agentActivity = this;
    this.audioRecognition = new AudioRecognition(
      this,
      this.agentSession.vad,
      this.agentSession.options.min_endpointing_delay,
      this.agentSession.options.max_endpointing_delay,
      // Arrow function preserves the Agent context
      (...args) => this.agent.sttNode(...args),
      this.turnDetectionMode === 'manual',
    );
    this.audioRecognition.start();
    this.started = true;

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

  get draining(): boolean {
    return this._draining;
  }

  get allowInterruptions(): boolean {
    // TODO(AJS-51): Allow options to be defined in Agent class
    return this.agentSession.options.allow_interruptions;
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
    // TODO(AJS-40): Implement this
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
      this.agentSession.options.min_interruption_words > 0 &&
      info.newTranscript.split(' ').length < this.agentSession.options.min_interruption_words
    ) {
      return false;
    }
    this.userTurnCompleted(info);
    return true;
  }

  retrieveChatCtx(): ChatContext {
    return this.agentSession.chatCtx;
  }

  private generateReply(
    userMessage?: ChatMessage,
    chatCtx?: ChatContext,
    instructions?: string,
    allowInterruptions?: boolean,
  ): SpeechHandle {
    this.logger.info('++++ generateReply');
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

    this.pipelineReplyTask(handle, chatCtx || this.agent.chatCtx); // add instructions
    // this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    return handle;
  }

  private async userTurnCompleted(info: EndOfTurnInfo): Promise<void> {
    // if (oldTask) {
    //   // We never cancel user code as this is very confusing.
    //   // So we wait for the old execution of on_user_turn_completed to finish.
    //   // In practice this is OK because most speeches will be interrupted if a new turn
    //   // is detected. So the previous execution should complete quickly.
    //   await oldTask();
    // }

    // When the audio recognition detects the end of a user turn:
    //  - check if realtime model server-side turn detection is enabled
    //  - check if there is no current generation happening
    //  - cancel the current generation if it allows interruptions (otherwise skip this current
    //  turn)
    //  - generate a reply to the user input

    // TODO(AJS-32): Add realtime model supppourt

    this.logger.info('++++ user turn completed');

    if (this.currentSpeech) {
      if (!this.currentSpeech.allowInterruptions) {
        this.logger.warn(
          { user_input: info.newTranscript },
          'skipping user input, current speech generation cannot be interrupted',
        );
        return;
      }

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
    handle: SpeechHandle,
    chatCtx: ChatContext,
    // instructions?: string,
    // newMessage?: ChatMessage,
  ): Promise<void> {
    this.logger.info('++++ pipelineReplyTask');
    // audioOutput = ''; //TODO
    // TODO(shubhra): add transcription/text output

    chatCtx = chatCtx.copy();

    // TODO(shubhra): handle new message

    // TODO(shubhra): handle instructions

    // TODO(shubhra): update agent state

    const tasks: Array<() => Promise<void>> = [];
    const [llmTask, llmGenData] = performLLMInference(
      this.agent.llmNode.bind(this.agent),
      chatCtx,
      {},
    );
    tasks.push(llmTask);
    llmTask();
    for await (const chunk of llmGenData.textStream) {
      this.logger.info(`LLM output: ${chunk}`);
    }
  }

  // private scheduleSpeech(handle: SpeechHandle, priority: number): void {
  //   // TODO(AJS-40) implement this
  // }
}
