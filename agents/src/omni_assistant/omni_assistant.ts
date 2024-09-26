// livekit-agents/livekit/agents/omni_assistant/omni_assistant.ts
import { RemoteParticipant, Room } from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { ChatContext, FunctionContext } from '../llm';
import { SentenceTokenizer, WordTokenizer } from '../tokenize';
import { VAD } from '../vad';

type EventTypes =
  | 'user_started_speaking'
  | 'user_stopped_speaking'
  | 'agent_started_speaking'
  | 'agent_stopped_speaking';

interface AssistantTranscriptionOptions {
  userTranscription: boolean;
  agentTranscription: boolean;
  agentTranscriptionSpeed: number;
  sentenceTokenizer: SentenceTokenizer;
  wordTokenizer: WordTokenizer;
  hyphenateWord: (word: string) => string[];
}

interface S2SModel {
  // Protocol interface, no methods defined
}

class OmniAssistant extends EventEmitter {
  constructor(
    model: S2SModel,
    vad?: VAD,
    chatCtx?: ChatContext,
    fncCtx?: FunctionContext,
    transcription: AssistantTranscriptionOptions = {} as AssistantTranscriptionOptions,
    loop?: any, // TODO: Define proper type for loop
  ) {
    super();
    // TODO: Implement constructor
  }

  get vad(): VAD | null {
    // TODO: Implement getter for vad property
    return null;
  }

  get fncCtx(): FunctionContext | null {
    // TODO: Implement getter for fncCtx property
    return null;
  }

  set fncCtx(value: FunctionContext | null) {
    // TODO: Implement setter for fncCtx property
  }

  start(room: Room, participant?: RemoteParticipant | string): void {
    // TODO: Implement public method to start the assistant
  }
}
