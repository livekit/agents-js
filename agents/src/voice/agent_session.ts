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
  //   private _options: VoiceOptions;
  private _started = false;
  private _turnDetection: TurnDetectionMode | null;
  private _stt?: STT | null;
  private _vad?: VAD | null;
  private _llm?: LLM | null;
  private _tts?: TTS | null;
  private _userdata?: T | null;

  //   private _input: AgentInput;

  private _forwardAudioTask: Promise<void> | null = null;
  private _updateActivityTask: Promise<void> | null = null;
  private _userState: UserState = 'listening';
  private _agentState: AgentState = 'initializing';
  private _agent: Agent | null = null;
  private _activity: AgentActivity | null = null;
  private _nextActivity: AgentActivity | null = null;
  private _chatCtx = new ChatContext();
  private _closingTask: Promise<void> | null = null;

  private roomIO: RoomIO | null = null;
  private logger = log();

  /** @internal */
  audioInput: ParticipantAudioInputStream | null = null;

  constructor(
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

    this._turnDetection = options.turnDetection || null;
    this._stt = options.stt || null;
    this._vad = options.vad || null;
    this._llm = options.llm || null;
    this._tts = options.tts || null;
    this._userdata = options.userdata || null;
  }

  async start(agent: Agent, room: Room, participant: RemoteParticipant): Promise<void> {
    if (this._started) {
      return;
    }

    this._agent = agent;

    this.logger.debug('++++++ starting agent session +++++', agent, room, participant);

    // Update activity with the new agent
    if (this._agent) {
      this._updateActivityTask = this._doUpdateActivity(this._agent);
      await this._updateActivityTask;
    }

    this.logger.debug('++++++ creating roomIO +++++');

    this.roomIO = new RoomIO(this, room, participant);
    this.roomIO.start();

    // Start audio forwarding if audio input is available
    if (this.audioInput) {
      this.logger.debug('++++++ starting forward audio +++++');
      this._forwardAudioTask = this._doForwardAudio(this.audioInput);
    }
  }

  // Audio input handling
  private async _doForwardAudio(audioInput: ParticipantAudioInputStream): Promise<void> {
    try {
      this.logger.debug('++++++ getting audio stream +++++');
      const audioStream = await audioInput.getAudioStream();
      for await (const frame of audioStream) {
        if (this._activity) {
          this._activity.pushAudio(frame);
        }
      }
    } catch (error) {
      console.error('Error in audio forwarding:', error);
    }
  }

  // Activity management
  private async _doUpdateActivity(agent: Agent): Promise<void> {
    // Create a new DefaultAgentActivity with the agent
    this._nextActivity = new AgentActivity(agent);

    // Close the current activity if it exists
    if (this._activity) {
      //   await this._activity.drain();
      //   await this._activity.close();
    }

    // Switch to the new activity
    this._activity = this._nextActivity;
    this._nextActivity = null;

    // Start the new activity
    if (this._activity) {
      await this._activity.start();
    }
  }
}
