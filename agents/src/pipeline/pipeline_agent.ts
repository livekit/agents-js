// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RemoteParticipant, Room } from '@livekit/rtc-node';
import {
  AudioSource,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'node:events';
import type { FunctionContext, LLM, LLMStream } from '../llm/index.js';
import { ChatContext } from '../llm/index.js';
import { log } from '../log.js';
import type { STT } from '../stt/index.js';
import {
  SentenceTokenizer as BasicSentenceTokenizer,
  WordTokenizer as BasicWordTokenizer,
  hyphenateWord,
} from '../tokenize/basic/index.js';
import type { SentenceTokenizer, WordTokenizer } from '../tokenize/tokenizer.js';
import type { TTS } from '../tts/index.js';
import { AsyncIterableQueue, CancellablePromise, Future } from '../utils.js';
import type { VAD, VADEvent } from '../vad.js';
import type { SpeechSource } from './agent_output.js';
import { AgentOutput } from './agent_output.js';
import { AgentPlayout, AgentPlayoutEvent } from './agent_playout.js';
import { HumanInput, HumanInputEvent } from './human_input';
import { SpeechHandle } from './speech_handle';

export type AgentState = 'initializing' | 'thinking' | 'listening' | 'speaking';

export type BeforeLLMCallback = (
  agent: VoicePipelineAgent,
  chatCtx: ChatContext,
) => LLMStream | false | void | Promise<LLMStream | false | void>;

export type BeforeTTSCallback = (
  agent: VoicePipelineAgent,
  source: string | AsyncIterable<string>,
) => SpeechSource;

export enum VPAEvent {
  USER_STARTED_SPEAKING,
  USER_STOPPED_SPEAKING,
  AGENT_STARTED_SPEAKING,
  AGENT_STOPPED_SPEAKING,
  USER_SPEECH_COMMITTED,
  AGENT_SPEECH_COMMITTED,
  AGENT_SPEECH_INTERRUPTED,
  FUNCTION_CALLS_COLLECTED,
  FUNCTION_CALLS_FINISHED,
}

export type VPACallbacks = {
  [VPAEvent.USER_STARTED_SPEAKING]: () => void;
  [VPAEvent.USER_STOPPED_SPEAKING]: () => void;
  [VPAEvent.AGENT_STARTED_SPEAKING]: () => void;
  [VPAEvent.AGENT_STOPPED_SPEAKING]: () => void;
  [VPAEvent.USER_SPEECH_COMMITTED]: () => void;
  [VPAEvent.AGENT_SPEECH_COMMITTED]: () => void;
  [VPAEvent.AGENT_SPEECH_INTERRUPTED]: () => void;
  [VPAEvent.FUNCTION_CALLS_COLLECTED]: () => void;
  [VPAEvent.FUNCTION_CALLS_FINISHED]: () => void;
};

export class AgentCallContext {
  #agent: VoicePipelineAgent;
  #llmStream: LLMStream;
  #metadata = new Map<string, any>();
  static #current: AgentCallContext;

  constructor(agent: VoicePipelineAgent, llmStream: LLMStream) {
    this.#agent = agent;
    this.#llmStream = llmStream;
    AgentCallContext.#current = this;
  }

  static getCurrent(): AgentCallContext {
    return AgentCallContext.#current;
  }

  get agent(): VoicePipelineAgent {
    return this.#agent;
  }

  storeMetadata(key: string, value: any) {
    this.#metadata.set(key, value);
  }

  getMetadata(key: string, orDefault: any = undefined) {
    return this.#metadata.get(key) || orDefault;
  }

  get llmStream(): LLMStream {
    return this.#llmStream;
  }
}

const defaultBeforeLLMCallback: BeforeLLMCallback = (
  agent: VoicePipelineAgent,
  chatCtx: ChatContext,
): LLMStream => {
  return agent.llm.chat({ chatCtx, fncCtx: agent.fncCtx });
};

const defaultBeforeTTSCallback: BeforeTTSCallback = (
  agent: VoicePipelineAgent,
  text: string | AsyncIterable<string>,
): string | AsyncIterable<string> => {
  return text;
};

export interface AgentTranscriptionOptions {
  /** Whether to forward the user transcription to the client */
  userTranscription: boolean;
  /** Whether to forward the agent transcription to the client */
  agentTranscription: boolean;
  /**
   * The speed at which the agent's speech transcription is forwarded to the client.
   * We try to mimic the agent's speech speed by adjusting the transcription speed.
   */
  agentTranscriptionSpeech: number;
  /**
   * The tokenizer used to split the speech into sentences.
   * This is used to decide when to mark a transcript as final for the agent transcription.
   */
  sentenceTokenizer: SentenceTokenizer;
  /**
   * The tokenizer used to split the speech into words.
   * This is used to simulate the "interim results" of the agent transcription.
   */
  wordTokenizer: WordTokenizer;
  /**
   * A function that takes a string (word) as input and returns a list of strings,
   * representing the hyphenated parts of the word.
   */
  hyphenateWord: (word: string) => string[];
}

const defaultAgentTranscriptionOptions: AgentTranscriptionOptions = {
  userTranscription: true,
  agentTranscription: true,
  agentTranscriptionSpeech: 1,
  sentenceTokenizer: new BasicSentenceTokenizer(),
  wordTokenizer: new BasicWordTokenizer(false),
  hyphenateWord: hyphenateWord,
};

export interface VPAOptions {
  /** Chat context for the assistant. */
  chatCtx?: ChatContext;
  /** Function context for the assistant. */
  fncCtx?: FunctionContext;
  /** Whether to allow the user to interrupt the assistant. */
  allowInterruptions: boolean;
  /** Minimum duration of speech to consider for interruption. */
  interruptSpeechDuration: number;
  /** Minimum number of words to consider for interuption. This may increase latency. */
  interruptMinWords: number;
  /** Delay to wait before considering the user speech done. */
  minEndpointingDelay: number;
  maxRecursiveFncCalls: number;
  /* Whether to preemptively synthesize responses. */
  preemptiveSynthesis: boolean;
  /*
   * Callback called when the assistant is about to synthesize a reply.
   *
   * @remarks
   * Returning void will create a default LLM stream.
   * You can also return your own LLM stream by calling `llm.chat()`.
   * Returning `false` ill cancel the synthesis of the reply.
   */
  beforeLLMCallback: BeforeLLMCallback;
  /*
   * Callback called when the assistant is about to synthesize speech.
   *
   * @remarks
   * This can be used to customize text before synthesis
   * (e.g. editing the pronunciation of a word).
   */
  beforeTTSCallback: BeforeTTSCallback;
  /** Whether to enable plotting for debugging. */
  plotting: boolean;
  /** Options for assistant transcription. */
  transcription: AgentTranscriptionOptions;
}

const defaultVPAOptions: VPAOptions = {
  chatCtx: new ChatContext(),
  allowInterruptions: true,
  interruptSpeechDuration: 0.5,
  interruptMinWords: 0,
  minEndpointingDelay: 0.5,
  maxRecursiveFncCalls: 1,
  preemptiveSynthesis: false,
  beforeLLMCallback: defaultBeforeLLMCallback,
  beforeTTSCallback: defaultBeforeTTSCallback,
  plotting: false,
  transcription: defaultAgentTranscriptionOptions,
};

/** A pipeline agent (VAD + STT + LLM + TTS) implementation. */
export class VoicePipelineAgent extends (EventEmitter as new () => TypedEmitter<VPACallbacks>) {
  /** Minimum time played for the user speech to be committed to the chat context. */
  readonly MIN_TIME_PLAYED_FOR_COMMIT = 1.5;

  #vad: VAD;
  #stt: STT;
  #llm: LLM;
  #tts: TTS;
  #opts: VPAOptions;
  #humanInput?: HumanInput;
  #agentOutput?: AgentOutput;
  #trackPublishedFut = new Future();
  #pendingAgentReply?: SpeechHandle;
  #agentReplyTask?: Promise<void>;
  #playingSpeech?: SpeechHandle;
  #transcribedText = '';
  #transcribedInterimText = '';
  #speechQueue = new AsyncIterableQueue<SpeechHandle>();
  #lastEndOfSpeechTime?: number;
  #updateStateTask?: CancellablePromise<void>;
  #started = false;
  #room?: Room;
  #participant: RemoteParticipant | string | null = null;
  #deferredValidation: DeferredReplyValidation;
  #logger = log();
  #agentPublication: any;

  constructor(
    /** Voice Activity Detection instance. */
    vad: VAD,
    /** Speech-to-Text instance. */
    stt: STT,
    /** Large Language Model instance. */
    llm: LLM,
    /** Text-to-Speech instance. */
    tts: TTS,
    /** Additional VoicePipelineAgent options. */
    opts: Partial<VPAOptions> = defaultVPAOptions,
  ) {
    super();

    this.#opts = { ...defaultVPAOptions, ...opts };

    // TODO(nbsp): AssistantPlotter

    this.#vad = vad;
    this.#stt = stt;
    this.#llm = llm;
    this.#tts = tts;

    this.#deferredValidation = new DeferredReplyValidation(
      this.#validateReplyIfPossible,
      this.#opts.minEndpointingDelay,
    );
  }

  get fncCtx(): FunctionContext | undefined {
    return this.#opts.fncCtx;
  }

  set fncCtx(ctx: FunctionContext) {
    this.#opts.fncCtx = ctx;
  }

  get chatCtx(): ChatContext {
    return this.#opts.chatCtx!;
  }

  get llm(): LLM {
    return this.#llm;
  }

  get tts(): TTS {
    return this.#tts;
  }

  get stt(): STT {
    return this.#stt;
  }

  get vad(): VAD {
    return this.#vad;
  }

  /** Start the voice assistant. */
  start(
    /** The room to connect to. */
    room: Room,
    /**
     * The participant to listen to.
     *
     * @remarks
     * Can be a participant or an identity.
     * If omitted, the first participant in the room will be selected.
     */
    participant: RemoteParticipant | string | null = null,
  ) {
    if (this.#started) {
      throw new Error('voice assistant already started');
    }
    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      // automatically link to the first participant that connects, if not already linked
      if (this.#participant) {
        return;
      }
      this.#linkParticipant(participant.identity);
    });

    this.#room = room;
    this.#participant = participant;

    if (participant) {
      if (typeof participant === 'string') {
        this.#linkParticipant(participant);
      } else {
        this.#linkParticipant(participant.identity);
      }
    }

    this.#run();
  }

  /** Play a speech source through the voice assistant. */
  async say(
    source: string | LLMStream | AsyncIterable<string>,
    allowInterruptions = true,
    addToChatCtx = true,
  ) {
    await this.#trackPublishedFut.await;
    const newHandle = SpeechHandle.createAssistantSpeech(allowInterruptions, addToChatCtx);
    const synthesisHandle = this.#synthesizeAgentSpeech(newHandle.id, source);
    this.#addSpeechForPlayout(newHandle);
  }

  #updateState(state: AgentState, delay = 0) {
    const runTask = async (delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#room?.isConnected) {
        await this.#room.localParticipant?.setAttributes({ ATTRIBUTE_AGENT_STATE: state });
      }
    };

    if (this.#updateStateTask) {
      this.#updateStateTask.cancel();
    }

    this.#updateStateTask = CancellablePromise.from(runTask(delay));
  }

  #linkParticipant(participantIdentity: string): void {
    if (!this.#room) {
      this.#logger.error('Room is not set');
      return;
    }

    this.#participant = this.#room.remoteParticipants.get(participantIdentity) || null;
    if (!this.#participant) {
      this.#logger.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }

    this.#humanInput = new HumanInput(this.#room, this.#vad, this.#stt, this.#participant);
    this.#humanInput.on(HumanInputEvent.START_OF_SPEECH, (event) => {
      // TODO(nbsp): this.plotter.plot_event
      this.emit(VPAEvent.USER_STARTED_SPEAKING);
      this.#deferredValidation.onHumanStartOfSpeech(event);
    });
    this.#humanInput.on(HumanInputEvent.VAD_INFERENCE_DONE, (event) => {
      if (!this.#trackPublishedFut.done) {
        return;
      }
      if (!this.#agentOutput) {
        throw new Error('agent output is undefined');
      }

      let tv = 1;
      if (this.#opts.allowInterruptions) {
        tv = Math.max(0, 1 - event.probability);
        this.#agentOutput.playout.targetVolume = tv;
      }

      const smoothedTv = this.#agentOutput.playout.targetVolume;

      // self._plotter.plot_value("raw_vol", tv)
      // self._plotter.plot_value("smoothed_vol", smoothed_tv)
      // self._plotter.plot_value("vad_probability", ev.probability)

      if (event.speechDuration >= this.#opts.interruptSpeechDuration) {
        this.#interruptIfPossible();
      }
    });
    this.#humanInput.on(HumanInputEvent.END_OF_SPEECH, (event) => {
      // TODO(nbsp): this.plotter.plot_event
      this.emit(VPAEvent.USER_STARTED_SPEAKING);
      this.#deferredValidation.onHumanEndOfSpeech(event);
      this.#lastEndOfSpeechTime = Date.now();
    });
    this.#humanInput.on(HumanInputEvent.INTERIM_TRANSCRIPT, (event) => {
      this.#transcribedInterimText = event.alternatives[0].text;
    });
    this.#humanInput.on(HumanInputEvent.FINAL_TRANSCRIPT, (event) => {
      const newTranscript = event.alternatives[0].text;
      if (!newTranscript) return;

      this.#logger.child({ userTranscript: newTranscript }).debug('received user transcript');
      this.#transcribedText += (this.#transcribedText ? ' ' : '') + newTranscript;

      if (
        this.#opts.preemptiveSynthesis &&
        (!this.#playingSpeech || this.#playingSpeech.allowInterruptions)
      ) {
        this.#synthesizeAgentReply();
      }

      this.#deferredValidation.onHumanFinalTranscript(newTranscript);

      const words = this.#opts.transcription.wordTokenizer.tokenize(newTranscript);
      if (words.length >= 3) {
        // VAD can sometimes not detect that the human is speaking.
        // to make the interruption more reliable, we also interrupt on the final transcript.
        this.#interruptIfPossible;
      }
    });
  }

  async #run() {
    if (this.#opts.plotting) {
      // await this.#plotter.start()
    }

    this.#updateState('initializing');
    const audioSource = new AudioSource(this.#tts.sampleRate, this.#tts.numChannels);
    const track = LocalAudioTrack.createAudioTrack('assistant_voice', audioSource);
    this.#agentPublication = await this.#room?.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    const ttsStream = this.#tts.stream();

    const agentPlayout = new AgentPlayout(audioSource);
    this.#agentOutput = new AgentOutput(agentPlayout, ttsStream);

    agentPlayout.on(AgentPlayoutEvent.PLAYOUT_STARTED, () => {
      // this.plotter
      this.emit(VPAEvent.AGENT_STARTED_SPEAKING);
      this.#updateState('speaking');
    });
    // eslint-ignore-next-line @typescript-eslint/no-unused-vars
    agentPlayout.on(AgentPlayoutEvent.PLAYOUT_STOPPED, (_) => {
      // this.plotter
      this.emit(VPAEvent.AGENT_STOPPED_SPEAKING);
      this.#updateState('listening');
    });

    this.#trackPublishedFut.resolve();

    for await (const speech of this.#speechQueue) {
      this.#playingSpeech = speech;
      await this.#playSpeech(speech);
      this.#playingSpeech = undefined;
    }
  }

  #synthesizeAgentReply() {}

  async #synthesizeAnswerTask(oldTask: CancellablePromise<void>, handle?: SpeechHandle) {}

  async #playSpeech(handle: SpeechHandle) {}

  #synthesizeAgentSpeech(speechId: string, source: string | LLMStream | AsyncIterable<string>) {}

  #validateReplyIfPossible() {}

  #interruptIfPossible() {}

  #addSpeechForPlayout(handle: SpeechHandle) {}

  /** Close the voice assistant. */
  async close() {
    if (!this.#started) {
      return;
    }

    this.#room?.removeAllListeners(RoomEvent.ParticipantConnected);
    // await this.#deferredValidation.close()
  }
}

/** This class is used to try to find the best time to validate the agent reply. */
class DeferredReplyValidation {
  // if the STT gives us punctuation, we can try to validate the reply faster.
  readonly PUNCTUATION = '.!?';
  readonly PUNCTUATION_REDUCE_FACTOR = 0.75;
  readonly LATE_TRANSCRIPT_TOLERANCE = 1.5; // late compared to end of speech

  #validateFunc: () => void;
  #validatingPromise?: Promise<void>;
  #validatingFuture = new Future();
  #lastFinalTranscript = '';
  #lastRecvEndOfSpeechTime = 0;
  #speaking = false;
  #endOfSpeechDelay: number;
  #finalTranscriptDelay: number;

  constructor(validateFunc: () => void, minEndpointingDelay: number) {
    this.#validateFunc = validateFunc;
    this.#endOfSpeechDelay = minEndpointingDelay;
    this.#finalTranscriptDelay = minEndpointingDelay;
  }

  get validating(): boolean {
    return !this.#validatingFuture.done;
  }

  onHumanFinalTranscript(transcript: string) {
    this.#lastFinalTranscript = transcript.trim();
    if (this.#speaking) return;

    const hasRecentEndOfSpeech =
      Date.now() - this.#lastRecvEndOfSpeechTime < this.LATE_TRANSCRIPT_TOLERANCE;
    let delay = hasRecentEndOfSpeech ? this.#endOfSpeechDelay : this.#finalTranscriptDelay;
    delay = this.#endWithPunctuation() ? delay * this.PUNCTUATION_REDUCE_FACTOR : 1;

    this.#run(delay);
  }

  // eslint-ignore-next-line @typescript-eslint/no-unused-vars
  onHumanStartOfSpeech(_: VADEvent) {
    this.#speaking = true;
    // if (this.validating) {
    //   this.#validatingPromise.cancel()
    // }
  }

  // eslint-ignore-next-line @typescript-eslint/no-unused-vars
  onHumanEndOfSpeech(_: VADEvent) {
    this.#speaking = false;
    this.#lastRecvEndOfSpeechTime = Date.now();

    if (this.#lastFinalTranscript) {
      const delay = this.#endWithPunctuation()
        ? this.#endOfSpeechDelay * this.PUNCTUATION_REDUCE_FACTOR
        : 1;
      this.#run(delay);
    }
  }

  // aclose

  #endWithPunctuation(): boolean {
    return (
      this.#lastFinalTranscript.length > 0 &&
      this.PUNCTUATION.includes(this.#lastFinalTranscript[this.#lastFinalTranscript.length - 1])
    );
  }

  #resetStates() {
    this.#lastFinalTranscript = '';
    this.#lastRecvEndOfSpeechTime = 0;
  }

  #run(delay: number) {
    const runTask = async (delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      this.#resetStates();
      this.#validateFunc();
    };

    if (this.#validatingFuture.done) {
      this.#validatingFuture = new Future();
    }
    this.#validatingPromise = runTask(delay);
  }
}
