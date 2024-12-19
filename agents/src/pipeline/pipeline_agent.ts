// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LocalTrackPublication, RemoteParticipant, Room } from '@livekit/rtc-node';
import {
  AudioSource,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'node:events';
import type {
  CallableFunctionResult,
  FunctionCallInfo,
  FunctionContext,
  LLM,
} from '../llm/index.js';
import { LLMEvent, LLMStream } from '../llm/index.js';
import { ChatContext, ChatMessage, ChatRole } from '../llm/index.js';
import { log } from '../log.js';
import type { AgentMetrics, PipelineEOUMetrics } from '../metrics/base.js';
import { type STT, StreamAdapter as STTStreamAdapter, SpeechEventType } from '../stt/index.js';
import {
  SentenceTokenizer as BasicSentenceTokenizer,
  WordTokenizer as BasicWordTokenizer,
  hyphenateWord,
} from '../tokenize/basic/index.js';
import type { SentenceTokenizer, WordTokenizer } from '../tokenize/tokenizer.js';
import type { TTS } from '../tts/index.js';
import { TTSEvent, StreamAdapter as TTSStreamAdapter } from '../tts/index.js';
import { AsyncIterableQueue, CancellablePromise, Future, gracefullyCancel } from '../utils.js';
import { type VAD, type VADEvent, VADEventType } from '../vad.js';
import type { SpeechSource, SynthesisHandle } from './agent_output.js';
import { AgentOutput } from './agent_output.js';
import { AgentPlayout, AgentPlayoutEvent } from './agent_playout.js';
import { HumanInput, HumanInputEvent } from './human_input.js';
import { SpeechHandle } from './speech_handle.js';

export type AgentState = 'initializing' | 'thinking' | 'listening' | 'speaking';
export const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';
let speechData: { sequenceId: string } | undefined;

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
  METRICS_COLLECTED,
}

export type VPACallbacks = {
  [VPAEvent.USER_STARTED_SPEAKING]: () => void;
  [VPAEvent.USER_STOPPED_SPEAKING]: () => void;
  [VPAEvent.AGENT_STARTED_SPEAKING]: () => void;
  [VPAEvent.AGENT_STOPPED_SPEAKING]: () => void;
  [VPAEvent.USER_SPEECH_COMMITTED]: (msg: ChatMessage) => void;
  [VPAEvent.AGENT_SPEECH_COMMITTED]: (msg: ChatMessage) => void;
  [VPAEvent.AGENT_SPEECH_INTERRUPTED]: (msg: ChatMessage) => void;
  [VPAEvent.FUNCTION_CALLS_COLLECTED]: (funcs: FunctionCallInfo[]) => void;
  [VPAEvent.FUNCTION_CALLS_FINISHED]: (funcs: CallableFunctionResult[]) => void;
  [VPAEvent.METRICS_COLLECTED]: (metrics: AgentMetrics) => void;
};

export class AgentCallContext {
  #agent: VoicePipelineAgent;
  #llmStream: LLMStream;
  #metadata = new Map<string, any>();
  #extraChatMessages: ChatMessage[] = [];
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

  get extraChatMessages() {
    return this.#extraChatMessages;
  }

  addExtraChatMessage(message: ChatMessage) {
    this.#extraChatMessages.push(message);
  }
}

const defaultBeforeLLMCallback: BeforeLLMCallback = (
  agent: VoicePipelineAgent,
  chatCtx: ChatContext,
): LLMStream => {
  return agent.llm.chat({ chatCtx, fncCtx: agent.fncCtx });
};

const defaultBeforeTTSCallback: BeforeTTSCallback = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _: VoicePipelineAgent,
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
  maxNestedFncCalls: number;
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
  /** Options for assistant transcription. */
  transcription: AgentTranscriptionOptions;
}

const defaultVPAOptions: VPAOptions = {
  chatCtx: new ChatContext(),
  allowInterruptions: true,
  interruptSpeechDuration: 50,
  interruptMinWords: 0,
  minEndpointingDelay: 500,
  maxNestedFncCalls: 1,
  preemptiveSynthesis: false,
  beforeLLMCallback: defaultBeforeLLMCallback,
  beforeTTSCallback: defaultBeforeTTSCallback,
  transcription: defaultAgentTranscriptionOptions,
};

/** A pipeline agent (VAD + STT + LLM + TTS) implementation. */
export class VoicePipelineAgent extends (EventEmitter as new () => TypedEmitter<VPACallbacks>) {
  /** Minimum time played for the user speech to be committed to the chat context. */
  readonly MIN_TIME_PLAYED_FOR_COMMIT = 1.5;
  protected static readonly FLUSH_SENTINEL = Symbol('FLUSH_SENTINEL');

  #vad: VAD;
  #stt: STT;
  #llm: LLM;
  #tts: TTS;
  #opts: VPAOptions;
  #humanInput?: HumanInput;
  #agentOutput?: AgentOutput;
  #trackPublishedFut = new Future();
  #pendingAgentReply?: SpeechHandle;
  #agentReplyTask?: CancellablePromise<void>;
  #playingSpeech?: SpeechHandle;
  #transcribedText = '';
  #transcribedInterimText = '';
  #speechQueueOpen = new Future();
  #speechQueue = new AsyncIterableQueue<SpeechHandle | typeof VoicePipelineAgent.FLUSH_SENTINEL>();
  #updateStateTask?: CancellablePromise<void>;
  #started = false;
  #room?: Room;
  #participant: RemoteParticipant | string | null = null;
  #deferredValidation: DeferredReplyValidation;
  #logger = log();
  #agentPublication?: LocalTrackPublication;
  #lastFinalTranscriptTime?: number;
  #lastSpeechTime?: number;

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

    if (!stt.capabilities.streaming) {
      stt = new STTStreamAdapter(stt, vad);
    }

    if (!tts.capabilities.streaming) {
      tts = new TTSStreamAdapter(tts, new BasicSentenceTokenizer());
    }

    this.#vad = vad;
    this.#stt = stt;
    this.#llm = llm;
    this.#tts = tts;

    this.#deferredValidation = new DeferredReplyValidation(
      this.#validateReplyIfPossible.bind(this),
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

    this.#stt.on(SpeechEventType.METRICS_COLLECTED, (metrics) => {
      this.emit(VPAEvent.METRICS_COLLECTED, metrics);
    });

    this.#tts.on(TTSEvent.METRICS_COLLECTED, (metrics) => {
      if (!speechData) return;
      this.emit(VPAEvent.METRICS_COLLECTED, { ...metrics, sequenceId: speechData.sequenceId });
    });

    this.#llm.on(LLMEvent.METRICS_COLLECTED, (metrics) => {
      if (!speechData) return;
      this.emit(VPAEvent.METRICS_COLLECTED, { ...metrics, sequenceId: speechData.sequenceId });
    });

    this.#vad.on(VADEventType.METRICS_COLLECTED, (metrics) => {
      this.emit(VPAEvent.METRICS_COLLECTED, metrics);
    });

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      // automatically link to the first participant that connects, if not already linked
      if (this.#participant) {
        return;
      }
      this.#linkParticipant.call(this, participant.identity);
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
  ): Promise<SpeechHandle> {
    await this.#trackPublishedFut.await;

    let callContext: AgentCallContext | undefined;
    let fncSource: string | AsyncIterable<string> | undefined;
    if (addToChatCtx) {
      callContext = AgentCallContext.getCurrent();
      if (source instanceof LLMStream) {
        this.#logger.warn('LLMStream will be ignored for function call chat context');
      } else if (typeof source === 'string') {
        fncSource = source;
      } else {
        fncSource = source;
        source = new AsyncIterableQueue<string>();
      }
    }

    const newHandle = SpeechHandle.createAssistantSpeech(allowInterruptions, addToChatCtx);
    const synthesisHandle = this.#synthesizeAgentSpeech(newHandle.id, source);
    newHandle.initialize(source, synthesisHandle);

    if (this.#playingSpeech && !this.#playingSpeech.nestedSpeechFinished) {
      this.#playingSpeech.addNestedSpeech(newHandle);
    } else {
      this.#addSpeechForPlayout(newHandle);
    }

    if (callContext && fncSource) {
      let text: string;
      if (typeof source === 'string') {
        text = fncSource as string;
      } else {
        text = '';
        for await (const chunk of fncSource) {
          (source as AsyncIterableQueue<string>).put(chunk);
          text += chunk;
        }
        (source as AsyncIterableQueue<string>).close();
      }

      callContext.addExtraChatMessage(ChatMessage.create({ text, role: ChatRole.ASSISTANT }));
      this.#logger.child({ text }).debug('added speech to function call chat context');
    }

    return newHandle;
  }

  #updateState(state: AgentState, delay = 0) {
    const runTask = (delay: number): CancellablePromise<void> => {
      return new CancellablePromise(async (resolve, _, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (this.#room?.isConnected) {
          if (!cancelled) {
            await this.#room.localParticipant?.setAttributes({ [AGENT_STATE_ATTRIBUTE]: state });
          }
        }
        resolve();
      });
    };

    if (this.#updateStateTask) {
      this.#updateStateTask.cancel();
    }

    this.#updateStateTask = runTask(delay);
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

      if (event.speechDuration >= this.#opts.interruptSpeechDuration) {
        this.#interruptIfPossible();
      }

      if (event.rawAccumulatedSpeech > 0) {
        this.#lastSpeechTime = Date.now() - event.rawAccumulatedSilence;
      }
    });
    this.#humanInput.on(HumanInputEvent.END_OF_SPEECH, (event) => {
      this.emit(VPAEvent.USER_STARTED_SPEAKING);
      this.#deferredValidation.onHumanEndOfSpeech(event);
    });
    this.#humanInput.on(HumanInputEvent.INTERIM_TRANSCRIPT, (event) => {
      this.#transcribedInterimText = event.alternatives![0].text;
    });
    this.#humanInput.on(HumanInputEvent.FINAL_TRANSCRIPT, (event) => {
      const newTranscript = event.alternatives![0].text;
      if (!newTranscript) return;

      this.#lastFinalTranscriptTime = Date.now();
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
        this.#interruptIfPossible();
      }
    });
  }

  async #run() {
    this.#updateState('initializing');
    const audioSource = new AudioSource(this.#tts.sampleRate, this.#tts.numChannels);
    const track = LocalAudioTrack.createAudioTrack('assistant_voice', audioSource);
    this.#agentPublication = await this.#room?.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );

    const agentPlayout = new AgentPlayout(audioSource);
    this.#agentOutput = new AgentOutput(agentPlayout, this.#tts);

    agentPlayout.on(AgentPlayoutEvent.PLAYOUT_STARTED, () => {
      this.emit(VPAEvent.AGENT_STARTED_SPEAKING);
      this.#updateState('speaking');
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    agentPlayout.on(AgentPlayoutEvent.PLAYOUT_STOPPED, (_) => {
      this.emit(VPAEvent.AGENT_STOPPED_SPEAKING);
      this.#updateState('listening');
    });

    this.#trackPublishedFut.resolve();

    while (true) {
      await this.#speechQueueOpen.await;
      for await (const speech of this.#speechQueue) {
        if (speech === VoicePipelineAgent.FLUSH_SENTINEL) break;
        this.#playingSpeech = speech;
        await this.#playSpeech(speech);
        this.#playingSpeech = undefined;
      }
      this.#speechQueueOpen = new Future();
    }
  }

  #synthesizeAgentReply() {
    this.#pendingAgentReply?.cancel();
    if (this.#humanInput && this.#humanInput.speaking) {
      this.#updateState('thinking', 200);
    }

    this.#pendingAgentReply = SpeechHandle.createAssistantReply(
      this.#opts.allowInterruptions,
      true,
      this.#transcribedText,
    );
    const newHandle = this.#pendingAgentReply;
    this.#agentReplyTask = this.#synthesizeAnswerTask(this.#agentReplyTask, newHandle);
  }

  #synthesizeAnswerTask(
    oldTask: CancellablePromise<void> | undefined,
    handle?: SpeechHandle,
  ): CancellablePromise<void> {
    return new CancellablePromise(async (resolve, _, onCancel) => {
      let cancelled = false;
      onCancel(() => {
        cancelled = true;
      });

      if (oldTask) {
        await gracefullyCancel(oldTask);
      }

      const copiedCtx = this.chatCtx.copy();
      const playingSpeech = this.#playingSpeech;
      if (playingSpeech && playingSpeech.initialized) {
        if (
          (!playingSpeech.userQuestion || playingSpeech.userCommitted) &&
          !playingSpeech.speechCommitted
        ) {
          // the speech is playing but not committed yet,
          // add it to the chat context for this new reply synthesis
          copiedCtx.messages.push(
            ChatMessage.create({
              text: playingSpeech.synthesisHandle.text,
              role: ChatRole.ASSISTANT,
            }),
          );
        }
      }

      copiedCtx.messages.push(
        ChatMessage.create({
          text: handle?.userQuestion,
          role: ChatRole.USER,
        }),
      );

      speechData = { sequenceId: handle!.id };

      try {
        if (cancelled) resolve();
        let llmStream = await this.#opts.beforeLLMCallback(this, copiedCtx);
        if (llmStream === false) {
          handle?.cancel();
          return;
        }

        if (cancelled) resolve();
        // fallback to default impl if no custom/user stream is returned
        if (!(llmStream instanceof LLMStream)) {
          llmStream = (await defaultBeforeLLMCallback(this, copiedCtx)) as LLMStream;
        }

        if (handle!.interrupted) {
          return;
        }

        const synthesisHandle = this.#synthesizeAgentSpeech(handle!.id, llmStream);
        handle!.initialize(llmStream, synthesisHandle);
      } finally {
        speechData = undefined;
      }
      resolve();
    });
  }

  async #playSpeech(handle: SpeechHandle) {
    try {
      await handle.waitForInitialization();
    } catch {
      return;
    }
    await this.#agentPublication!.waitForSubscription();
    const synthesisHandle = handle.synthesisHandle;
    if (synthesisHandle.interrupted) return;

    const userQuestion = handle.userQuestion;
    const playHandle = synthesisHandle.play();
    const joinFut = playHandle.join();

    const commitUserQuestionIfNeeded = () => {
      if (!userQuestion || synthesisHandle.interrupted || handle.userCommitted) return;
      const isUsingTools =
        handle.source instanceof LLMStream && !!handle.source.functionCalls.length;

      // make sure at least some speech was played before committing the user message
      // since we try to validate as fast as possible it is possible the agent gets interrupted
      // really quickly (barely audible), we don't want to mark this question as "answered".
      if (
        handle.allowInterruptions &&
        !isUsingTools &&
        playHandle.timePlayed < this.MIN_TIME_PLAYED_FOR_COMMIT &&
        !joinFut.done
      ) {
        return;
      }

      this.#logger.child({ userTranscript: userQuestion }).debug('committed user transcript');
      const userMsg = ChatMessage.create({ text: userQuestion, role: ChatRole.USER });
      this.chatCtx.messages.push(userMsg);
      this.emit(VPAEvent.USER_SPEECH_COMMITTED, userMsg);

      this.#transcribedText = this.#transcribedText.slice(userQuestion.length);
      handle.markUserCommitted();
    };

    // wait for the playHandle to finish and check every 1s if user question should be committed
    commitUserQuestionIfNeeded();

    while (!joinFut.done) {
      await new Promise<void>(async (resolve) => {
        setTimeout(resolve, 500);
        await joinFut.await;
        resolve();
      });
      commitUserQuestionIfNeeded();
      if (handle.interrupted) break;
    }
    commitUserQuestionIfNeeded();

    const collectedText = handle.synthesisHandle.text;
    const isUsingTools = handle.source instanceof LLMStream && !!handle.source.functionCalls.length;
    const interrupted = handle.interrupted;

    const executeFunctionCalls = async () => {
      // if the answer is using tools, execute the functions and automatically generate
      // a response to the user question from the returned values
      if (!isUsingTools || interrupted) return;

      if (handle.fncNestedDepth >= this.#opts.maxNestedFncCalls) {
        this.#logger
          .child({ speechId: handle.id, fncNestedDepth: handle.fncNestedDepth })
          .warn('max function calls nested depth reached');
        return;
      }

      if (!userQuestion || !handle.userCommitted) {
        throw new Error('user speech should have been committed before using tools');
      }
      const llmStream = handle.source;
      const newFunctionCalls = llmStream.functionCalls;

      new AgentCallContext(this, llmStream);

      this.emit(VPAEvent.FUNCTION_CALLS_COLLECTED, newFunctionCalls);
      const calledFuncs: FunctionCallInfo[] = [];
      for (const func of newFunctionCalls) {
        const task = func.func.execute(func.params).then(
          (result) => ({ name: func.name, toolCallId: func.toolCallId, result }),
          (error) => ({ name: func.name, toolCallId: func.toolCallId, error }),
        );
        calledFuncs.push({ ...func, task });
        this.#logger
          .child({ function: func.name, speechId: handle.id })
          .debug('executing AI function');
        try {
          await task;
        } catch {
          this.#logger
            .child({ function: func.name, speechId: handle.id })
            .error('error executing AI function');
        }
      }

      const toolCallsInfo = [];
      const toolCallsResults = [];
      for (const fnc of calledFuncs) {
        // ignore the function calls that return void
        const task = await fnc.task;
        if (!task || task.result === undefined) continue;
        toolCallsInfo.push(fnc);
        toolCallsResults.push(ChatMessage.createToolFromFunctionResult(task));
      }

      if (!toolCallsInfo.length) return;

      // generate an answer from the tool calls
      const extraToolsMessages = [ChatMessage.createToolCalls(toolCallsInfo, collectedText)];
      extraToolsMessages.push(...toolCallsResults);

      // create a nested speech handle
      const newSpeechHandle = SpeechHandle.createToolSpeech(
        handle.allowInterruptions,
        handle.addToChatCtx,
        handle.fncNestedDepth + 1,
        extraToolsMessages,
      );

      // synthesize the tool speech with the chat ctx from llmStream
      const chatCtx = handle.source.chatCtx.copy();
      chatCtx.messages.push(...extraToolsMessages);
      chatCtx.messages.push(...AgentCallContext.getCurrent().extraChatMessages);

      const answerLLMStream = this.llm.chat({
        chatCtx,
        fncCtx: this.fncCtx,
      });
      const answerSynthesis = this.#synthesizeAgentSpeech(newSpeechHandle.id, answerLLMStream);
      newSpeechHandle.initialize(answerLLMStream, answerSynthesis);
      handle.addNestedSpeech(newSpeechHandle);

      this.emit(VPAEvent.FUNCTION_CALLS_FINISHED, calledFuncs);
    };

    const task = executeFunctionCalls().then(() => {
      handle.markNestedSpeechFinished();
    });
    while (!handle.nestedSpeechFinished) {
      const changed = handle.nestedSpeechChanged();
      await Promise.race([changed, task]);
      while (handle.nestedSpeechHandles.length) {
        const speech = handle.nestedSpeechHandles[0]!;
        this.#playingSpeech = speech;
        await this.#playSpeech(speech);
        handle.nestedSpeechHandles.shift();
        this.#playingSpeech = handle;
      }
    }

    if (handle.addToChatCtx && (!userQuestion || handle.userCommitted)) {
      if (handle.extraToolsMessages) {
        this.chatCtx.messages.push(...handle.extraToolsMessages);
      }
      if (interrupted) {
        collectedText + '…';
      }

      const msg = ChatMessage.create({ text: collectedText, role: ChatRole.ASSISTANT });
      this.chatCtx.messages.push(msg);

      handle.markSpeechCommitted();
      if (interrupted) {
        this.emit(VPAEvent.AGENT_SPEECH_INTERRUPTED, msg);
      } else {
        this.emit(VPAEvent.AGENT_SPEECH_COMMITTED, msg);
      }

      this.#logger
        .child({
          agentTranscript: collectedText,
          interrupted,
          speechId: handle.id,
        })
        .debug('committed agent speech');

      handle.setDone();
    }
  }

  #synthesizeAgentSpeech(
    speechId: string,
    source: string | LLMStream | AsyncIterable<string>,
  ): SynthesisHandle {
    if (!this.#agentOutput) {
      throw new Error('agent output should be initialized when ready');
    }

    if (source instanceof LLMStream) {
      source = llmStreamToStringIterable(speechId, source);
    }

    const ogSource = source;
    if (!(typeof source === 'string')) {
      // TODO(nbsp): itertools.tee
    }

    const ttsSource = this.#opts.beforeTTSCallback(this, ogSource);
    if (!ttsSource) {
      throw new Error('beforeTTSCallback must return string or AsyncIterable<string>');
    }

    return this.#agentOutput.synthesize(speechId, ttsSource);
  }

  async #validateReplyIfPossible() {
    if (this.#playingSpeech && !this.#playingSpeech.allowInterruptions) {
      this.#logger
        .child({ speechId: this.#playingSpeech.id })
        .debug('skipping validation, agent is speaking and does not allow interruptions');
      return;
    }

    if (!this.#pendingAgentReply) {
      if (this.#opts.preemptiveSynthesis || !this.#transcribedText) {
        return;
      }
      this.#synthesizeAgentReply();
    }

    if (!this.#pendingAgentReply) {
      throw new Error('pending agent reply is undefined');
    }

    // in some bad timimg, we could end up with two pushed agent replies inside the speech queue.
    // so make sure we directly interrupt every reply when validating a new one
    if (this.#speechQueueOpen.done) {
      for await (const speech of this.#speechQueue) {
        if (speech === VoicePipelineAgent.FLUSH_SENTINEL) break;
        if (!speech.isReply) continue;
        if (speech.allowInterruptions) speech.interrupt();
      }
    }

    this.#logger.child({ speechId: this.#pendingAgentReply.id }).debug('validated agent reply');

    if (this.#lastSpeechTime) {
      const timeSinceLastSpeech = Date.now() - this.#lastSpeechTime;
      const transcriptionDelay = Math.max(
        (this.#lastFinalTranscriptTime || 0) - this.#lastSpeechTime,
        0,
      );
      const metrics: PipelineEOUMetrics = {
        timestamp: Date.now(),
        sequenceId: this.#pendingAgentReply.id,
        endOfUtteranceDelay: timeSinceLastSpeech,
        transcriptionDelay,
      };
      this.emit(VPAEvent.METRICS_COLLECTED, metrics);
    }

    this.#addSpeechForPlayout(this.#pendingAgentReply);
    this.#pendingAgentReply = undefined;
    this.#transcribedInterimText = '';
  }

  #interruptIfPossible() {
    if (
      !this.#playingSpeech ||
      !this.#playingSpeech.allowInterruptions ||
      this.#playingSpeech.interrupted
    ) {
      return;
    }

    if (this.#opts.interruptMinWords !== 0) {
      // check the final/interim transcribed text for the minimum word count
      // to interrupt the agent speech
      const interimWords = this.#opts.transcription.wordTokenizer.tokenize(
        this.#transcribedInterimText,
      );
      if (interimWords.length < this.#opts.interruptMinWords) {
        return;
      }
    }
    this.#playingSpeech.interrupt();
  }

  #addSpeechForPlayout(handle: SpeechHandle) {
    this.#speechQueue.put(handle);
    this.#speechQueue.put(VoicePipelineAgent.FLUSH_SENTINEL);
    this.#speechQueueOpen.resolve();
  }

  /** Close the voice assistant. */
  async close() {
    if (!this.#started) {
      return;
    }

    this.#room?.removeAllListeners(RoomEvent.ParticipantConnected);
    // TODO(nbsp): await this.#deferredValidation.close()
  }
}

async function* llmStreamToStringIterable(
  speechId: string,
  stream: LLMStream,
): AsyncIterable<string> {
  const startTime = Date.now();
  let firstFrame = true;
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta.content;
    if (!content) continue;

    if (firstFrame) {
      firstFrame = false;
      log()
        .child({ speechId, elapsed: Math.round(Date.now() - startTime) })
        .debug('received first LLM token');
    }
    yield content;
  }
}

/** This class is used to try to find the best time to validate the agent reply. */
class DeferredReplyValidation {
  // if the STT gives us punctuation, we can try to validate the reply faster.
  readonly PUNCTUATION = '.!?';
  readonly PUNCTUATION_REDUCE_FACTOR = 0.75;
  readonly LATE_TRANSCRIPT_TOLERANCE = 1.5; // late compared to end of speech

  #validateFunc: () => Promise<void>;
  #validatingPromise?: Promise<void>;
  #validatingFuture = new Future();
  #lastFinalTranscript = '';
  #lastRecvEndOfSpeechTime = 0;
  #speaking = false;
  #endOfSpeechDelay: number;
  #finalTranscriptDelay: number;

  constructor(validateFunc: () => Promise<void>, minEndpointingDelay: number) {
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHumanStartOfSpeech(_: VADEvent) {
    this.#speaking = true;
    // TODO(nbsp):
    // if (this.validating) {
    //   this.#validatingPromise.cancel()
    // }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  // TODO(nbsp): aclose

  #endWithPunctuation(): boolean {
    return (
      this.#lastFinalTranscript.length > 0 &&
      this.PUNCTUATION.includes(this.#lastFinalTranscript[this.#lastFinalTranscript.length - 1]!)
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
      await this.#validateFunc();
    };

    this.#validatingFuture = new Future();
    this.#validatingPromise = runTask(delay);
  }
}
