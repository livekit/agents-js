// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioTranscriptionConfig,
  type ContextWindowCompressionConfig,
  type HttpOptions,
  Modality,
  type RealtimeInputConfig,
} from '@google/genai';
import type { APIConnectOptions, stream } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { type LLMTool } from '../../tools.js';
import type { LiveAPIModels, Voice } from './api_proto.js';

/**
 * Default image encoding options for Google Realtime API
 */
export const DEFAULT_IMAGE_ENCODE_OPTIONS = {
  format: 'JPEG' as const,
  quality: 75,
  resizeOptions: {
    width: 1024,
    height: 1024,
    strategy: 'scale_aspect_fit' as const,
  },
};

/**
 * Input transcription result
 */
export interface InputTranscription {
  itemId: string;
  transcript: string;
}

/**
 * Internal realtime options for Google Realtime API
 */
interface RealtimeOptions {
  model: LiveAPIModels | string;
  apiKey?: string;
  voice: Voice | string;
  language?: string;
  responseModalities: Modality[];
  vertexai: boolean;
  project?: string;
  location?: string;
  candidateCount: number;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  instructions?: string;
  inputAudioTranscription?: AudioTranscriptionConfig;
  outputAudioTranscription?: AudioTranscriptionConfig;
  imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;
  connOptions: APIConnectOptions;
  httpOptions?: HttpOptions;
  enableAffectiveDialog?: boolean;
  proactivity?: boolean;
  realtimeInputConfig?: RealtimeInputConfig;
  contextWindowCompression?: ContextWindowCompressionConfig;
  apiVersion?: string;
  geminiTools?: LLMTool[];
}

/**
 * Response generation tracking
 */
interface ResponseGeneration {
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;

  inputId: string;
  responseId: string;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;

  inputTranscription: string;
  outputText: string;

  /** @internal */
  _createdTimestamp: number;
  /** @internal */
  _firstTokenTimestamp?: number;
  /** @internal */
  _completedTimestamp?: number;
  /** @internal */
  _done: boolean;
}

/**
 * Google Realtime Model for real-time voice conversations
 *
 * This model provides real-time streaming capabilities with Google's Gemini models,
 * supporting both text and audio modalities with function calling capabilities.
 */
export class RealtimeModel extends llm.RealtimeModel {
  /* @internal */
  _options: RealtimeOptions;

  constructor(
    options: {
      /**
       * Initial system instructions for the model
       */
      instructions?: string;

      /**
       * The name of the model to use
       * @default "gemini-2.0-flash-live-001" (Gemini API) or "gemini-2.0-flash-exp" (VertexAI)
       */
      model?: LiveAPIModels | string;

      /**
       * Google Gemini API key. If not provided, will attempt to read from GOOGLE_API_KEY environment variable
       */
      apiKey?: string;

      /**
       * Voice setting for audio outputs
       * @default "Puck"
       */
      voice?: Voice | string;

      /**
       * The language (BCP-47 Code) to use for the API
       * See https://ai.google.dev/gemini-api/docs/live#supported-languages
       */
      language?: string;

      /**
       * Modalities to use, such as [Modality.TEXT, Modality.AUDIO]
       * @default [Modality.AUDIO]
       */
      modalities?: Modality[];

      /**
       * Whether to use VertexAI for the API
       * @default false
       */
      vertexai?: boolean;

      /**
       * The project ID to use for the API (for VertexAI)
       */
      project?: string;

      /**
       * The location to use for the API (for VertexAI)
       * @default "us-central1"
       */
      location?: string;

      /**
       * The number of candidate responses to generate
       * @default 1
       */
      candidateCount?: number;

      /**
       * Sampling temperature for response generation
       * @default 0.8
       */
      temperature?: number;

      /**
       * Maximum number of tokens in the response
       */
      maxOutputTokens?: number;

      /**
       * The top-p value for response generation
       */
      topP?: number;

      /**
       * The top-k value for response generation
       */
      topK?: number;

      /**
       * The presence penalty for response generation
       */
      presencePenalty?: number;

      /**
       * The frequency penalty for response generation
       */
      frequencyPenalty?: number;

      /**
       * The configuration for input audio transcription
       */
      inputAudioTranscription?: AudioTranscriptionConfig;

      /**
       * The configuration for output audio transcription
       */
      outputAudioTranscription?: AudioTranscriptionConfig;

      /**
       * The configuration for image encoding
       */
      imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;

      /**
       * Whether to enable affective dialog
       * @default false
       */
      enableAffectiveDialog?: boolean;

      /**
       * Whether to enable proactive audio
       * @default false
       */
      proactivity?: boolean;

      /**
       * The configuration for realtime input
       */
      realtimeInputConfig?: RealtimeInputConfig;

      /**
       * The configuration for context window compression
       */
      contextWindowCompression?: ContextWindowCompressionConfig;

      /**
       * API version to use
       */
      apiVersion?: string;

      /**
       * The configuration for the API connection
       * @default DEFAULT_API_CONNECT_OPTIONS
       */
      connOptions?: APIConnectOptions;

      /**
       * HTTP options for API requests
       */
      httpOptions?: HttpOptions;

      /**
       * Gemini-specific tools to use for the session
       */
      geminiTools?: LLMTool[];
    } = {},
  ) {
    const serverTurnDetection = !options.realtimeInputConfig?.automaticActivityDetection?.disabled;
    const modalities = options.modalities || [Modality.AUDIO];

    super({
      messageTruncation: false,
      turnDetection: serverTurnDetection,
      userTranscription: options.inputAudioTranscription !== undefined,
      autoToolReplyGeneration: true,
    });

    let model = options.model;
    if (!model) {
      model = options.vertexai ? 'gemini-2.0-flash-exp' : 'gemini-2.0-flash-live-001';
    }

    let apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
    let project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
    let location: string | undefined =
      options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    const useVertexAI =
      options.vertexai ||
      process.env.GOOGLE_GENAI_USE_VERTEXAI === '1' ||
      process.env.GOOGLE_GENAI_USE_VERTEXAI?.toLowerCase() === 'true';

    if (useVertexAI) {
      if (!project || !location) {
        throw new Error(
          'Project is required for VertexAI via project option or GOOGLE_CLOUD_PROJECT environment variable',
        );
      }
      apiKey = undefined;
    } else {
      project = undefined;
      location = undefined;
      if (!apiKey) {
        throw new Error(
          'API key is required for Google API either via apiKey option or GOOGLE_API_KEY environment variable',
        );
      }
    }

    const inputAudioTranscription =
      options.inputAudioTranscription !== undefined ? options.inputAudioTranscription : {};
    const outputAudioTranscription =
      options.outputAudioTranscription !== undefined ? options.outputAudioTranscription : {};

    this._options = {
      model,
      apiKey,
      voice: options.voice || 'Puck',
      language: options.language,
      responseModalities: modalities,
      vertexai: useVertexAI,
      project,
      location,
      candidateCount: options.candidateCount ?? 1,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      instructions: options.instructions,
      inputAudioTranscription,
      outputAudioTranscription,
      imageEncodeOptions: options.imageEncodeOptions,
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
      httpOptions: options.httpOptions,
      enableAffectiveDialog: options.enableAffectiveDialog,
      proactivity: options.proactivity,
      realtimeInputConfig: options.realtimeInputConfig,
      contextWindowCompression: options.contextWindowCompression,
      apiVersion: options.apiVersion,
      geminiTools: options.geminiTools,
    };
  }

  /**
   * Create a new realtime session
   */
  session(): llm.RealtimeSession {
    // Note: RealtimeSession implementation will be added later
    throw new Error('RealtimeSession not yet implemented');
  }

  /**
   * Update model options
   */
  updateOptions(options: { voice?: Voice | string; temperature?: number }): void {
    if (options.voice !== undefined) {
      this._options.voice = options.voice;
    }
    if (options.temperature !== undefined) {
      this._options.temperature = options.temperature;
    }

    // TODO: Notify active sessions of option changes
  }

  /**
   * Close the model and cleanup resources
   */
  async close(): Promise<void> {
    // TODO: Implementation depends on session management
  }
}
