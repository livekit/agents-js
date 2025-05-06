import { AudioFrame, AudioStream, Participant, RemoteParticipant, Room } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { ChatContext, ChatMessage, LLM } from '../llm/index.js';
import { log } from '../log.js';
import { STT } from '../stt/index.js';
import { TTS } from '../tts/index.js';
import { VAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { ParticipantAudioInputStream, RoomIO } from './room_io.js';

// These interfaces will need to be implemented in separate files
export interface SpeechHandle {
  allowInterruptions: boolean;
  interrupted: boolean;
  interrupt(): void;
}

export type UserState = 'listening' | 'speaking';
export type AgentState = 'initializing' | 'listening' | 'speaking' | 'thinking' | 'error';

export interface VoiceOptions {
  allowInterruptions: boolean;
  discardAudioIfUninterruptible: boolean;
  minInterruptionDuration: number;
  minEndpointingDelay: number;
  maxEndpointingDelay: number;
  maxToolSteps: number;
}

export type TurnDetectionMode = 'stt' | 'vad' | 'realtime_llm' | 'manual' | any;

export type EventTypes =
  | 'agent_state_changed'
  | 'user_state_changed'
  | 'conversation_item_added'
  | 'close'
  | 'userInputTranscribed';

export interface AgentEvent {
  type: string;
}

export interface CloseEvent extends AgentEvent {
  type: 'close';
  error?: Error | null;
}

export interface AgentStateChangedEvent extends AgentEvent {
  type: 'agent_state_changed';
  oldState: AgentState;
  newState: AgentState;
}

export interface UserStateChangedEvent extends AgentEvent {
  type: 'user_state_changed';
  oldState: UserState;
  newState: UserState;
}

export interface ConversationItemAddedEvent extends AgentEvent {
  type: 'conversation_item_added';
  item: ChatMessage;
}

export interface UserInputTranscribedEvent extends AgentEvent {
  type: 'userInputTranscribed';
  transcript: string;
  isFinal: boolean;
}

export class AgentSession<T = any> extends EventEmitter {
  vad?: VAD;

  private _updateActivityTask: Promise<void> | null = null;
  private _agent?: Agent;
  private _activity?: AgentActivity;
  private _nextActivity?: AgentActivity;
  private started = false;

  private roomIO: RoomIO | null = null;
  private logger = log();

  /** @internal */
  audioInput: ParticipantAudioInputStream | null = null;

  constructor(
    vad: VAD,
    options: {
      turnDetection?: TurnDetectionMode;
      stt?: STT;
      vad?: VAD;
      llm?: LLM;
      tts?: TTS;
      userdata?: T;
      allowInterruptions?: boolean;
      discardAudioIfUninterruptible?: boolean;
      minInterruptionDuration?: number;
      minEndpointingDelay?: number;
      maxEndpointingDelay?: number;
      maxToolSteps?: number;
    } = {},
  ) {
    super();
    this.vad = vad;
  }

  async start(agent: Agent, room: Room, participant: RemoteParticipant): Promise<void> {
    if (this.started) {
      return;
    }

    this._agent = agent;

    // Update activity with the new agent
    if (this._agent) {
      this._updateActivityTask = this._doUpdateActivity(this._agent);
      await this._updateActivityTask;
    }

    this.roomIO = new RoomIO(this, room, participant);
    this.roomIO.start();
    // Start audio forwarding if audio input is available
    if (this.audioInput) {
      const audioStream = await this.audioInput.getAudioStream();
      this._activity?.updateAudioInput(audioStream);
    }

    this.logger.info('AgentSession started');
    this.started = true;
  }

  // Activity management
  private async _doUpdateActivity(agent: Agent): Promise<void> {
    // Create a new DefaultAgentActivity with the agent
    this._nextActivity = new AgentActivity(agent, this);

    // Close the current activity if it exists
    if (this._activity) {
      //   await this._activity.drain();
      //   await this._activity.close();
    }

    // Switch to the new activity
    this._activity = this._nextActivity;
    this._nextActivity = undefined;

    // Start the new activity
    if (this._activity) {
      await this._activity.start();
    }
  }
}
