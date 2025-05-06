// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, AudioStream } from '@livekit/rtc-node';
import { assert } from 'node:console';
import { log } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
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
  private inputAudioStream: Promise<AudioStream>;
  private inputAudioStreamResolver: (value: AudioStream) => void = () => {};
  private audioRecognition?: AudioRecognition;
  private logger = log();
  agent: Agent;
  agentSession: AgentSession;

  constructor(agent: Agent, agentSession: AgentSession) {
    this.agent = agent;
    this.agentSession = agentSession;
    this.inputAudioStream = new Promise((resolve) => {
      this.inputAudioStreamResolver = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.audioRecognition = new AudioRecognition(this, this.agent.sttNode, this.agentSession.vad);
    this.audioRecognition.start();
    this.started = true;
  }

  updateAudioInput(audioStream: AudioStream): void {
    this.inputAudioStreamResolver(audioStream);
    this.audioRecognition?.setInputAudioStream(audioStream);
  }

  onStartOfSpeech(ev: VADEvent): void {
    this.logger.info('Start of speech', ev);
  }

  onEndOfSpeech(ev: VADEvent): void {
    this.logger.info('End of speech', ev);
  }

  onVADInferenceDone(ev: VADEvent): void {
    //this.logger.info('VAD inference done', ev);
  }

  onInterimTranscript(ev: SpeechEvent): void {
    this.logger.info('Interim transcript', ev);
  }

  onFinalTranscript(ev: SpeechEvent): void {
    this.logger.info('Final transcript', ev);
  }

  onEndOfTurn(ev: EndOfTurnInfo): void {
    this.logger.info('End of turn', ev);
  }
}
