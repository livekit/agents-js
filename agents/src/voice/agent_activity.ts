import { AudioFrame } from '@livekit/rtc-node';
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
    // @ts-ignore
    this.agent.agentActivity = this;
    this.audioRecognition = new AudioRecognition(
      this,
      this.agentSession.vad,
      // This makes sure the "this" in Agent.default.sttNode(this, ...) refers to the Agent instance
      this.agent.sttNode.bind(this.agent),
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
