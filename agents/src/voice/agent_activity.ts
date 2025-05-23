// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import { log } from '../log.js';
import type { STT, SpeechEvent } from '../stt/stt.js';
import type { VADEvent } from '../vad.js';
import type { Agent } from './agent.js';
import type { AgentSession } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type RecognitionHooks,
} from './audio_recognition.js';

export class AgentActivity implements RecognitionHooks {
  private started = false;
  private audioRecognition?: AudioRecognition;
  private logger = log();
  private turnDetectionMode?: string;

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
    // TODO(shubhra): Allow components to be defined in Agent class
    return this.agentSession.stt;
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

  async onEndOfTurn(ev: EndOfTurnInfo): Promise<boolean> {
    this.logger.info(ev, 'End of turn');
    return true;
  }

  retrieveChatCtx(): ChatContext {
    return this.agentSession.chatCtx;
  }
}
