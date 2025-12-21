import * as types from '@google/genai';
import { type AudioTranscriptionConfig, type ContextWindowCompressionConfig, type HttpOptions, Modality, type RealtimeInputConfig } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import { llm } from '@livekit/agents';
import { AudioFrame, type VideoFrame } from '@livekit/rtc-node';
import { type LLMTools } from '../../tools.js';
import type { LiveAPIModels, Voice } from './api_proto.js';
/**
 * Default image encoding options for Google Realtime API
 */
export declare const DEFAULT_IMAGE_ENCODE_OPTIONS: {
    format: "JPEG";
    quality: number;
    resizeOptions: {
        width: number;
        height: number;
        strategy: "scale_aspect_fit";
    };
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
    geminiTools?: LLMTools;
    thinkingConfig?: types.ThinkingConfig;
}
/**
 * Google Realtime Model for real-time voice conversations with Gemini models
 */
export declare class RealtimeModel extends llm.RealtimeModel {
    /** @internal */
    _options: RealtimeOptions;
    constructor(options?: {
        /**
         * Initial system instructions for the model
         */
        instructions?: string;
        /**
         * The name of the model to use
         */
        model?: LiveAPIModels | string;
        /**
         * Google Gemini API key. If not provided, will attempt to read from GOOGLE_API_KEY environment variable
         */
        apiKey?: string;
        /**
         * Voice setting for audio outputs
         */
        voice?: Voice | string;
        /**
         * The language (BCP-47 Code) to use for the API
         * See https://ai.google.dev/gemini-api/docs/live#supported-languages
         */
        language?: string;
        /**
         * Modalities to use, such as [Modality.TEXT, Modality.AUDIO]
         */
        modalities?: Modality[];
        /**
         * Whether to use VertexAI for the API
         */
        vertexai?: boolean;
        /**
         * The project ID to use for the API (for VertexAI)
         */
        project?: string;
        /**
         * The location to use for the API (for VertexAI)
         */
        location?: string;
        /**
         * The number of candidate responses to generate
         */
        candidateCount?: number;
        /**
         * Sampling temperature for response generation
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
        inputAudioTranscription?: AudioTranscriptionConfig | null;
        /**
         * The configuration for output audio transcription
         */
        outputAudioTranscription?: AudioTranscriptionConfig | null;
        /**
         * The configuration for image encoding
         */
        imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;
        /**
         * Whether to enable affective dialog
         */
        enableAffectiveDialog?: boolean;
        /**
         * Whether to enable proactive audio
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
         */
        connOptions?: APIConnectOptions;
        /**
         * HTTP options for API requests
         */
        httpOptions?: HttpOptions;
        /**
         * Gemini-specific tools to use for the session
         */
        geminiTools?: LLMTools;
        /**
         * The thinking configuration for response generation
         */
        thinkingConfig?: types.ThinkingConfig;
    });
    /**
     * Create a new realtime session
     */
    session(): RealtimeSession;
    /**
     * Update model options
     */
    updateOptions(options: {
        voice?: Voice | string;
        temperature?: number;
    }): void;
    /**
     * Close the model and cleanup resources
     */
    close(): Promise<void>;
}
/**
 * Google Realtime Session for real-time voice conversations
 *
 * This session provides real-time streaming capabilities with Google's Gemini models,
 * supporting both text and audio modalities with function calling capabilities.
 */
export declare class RealtimeSession extends llm.RealtimeSession {
    #private;
    private _tools;
    private _chatCtx;
    private options;
    private geminiDeclarations;
    private messageChannel;
    private inputResampler?;
    private inputResamplerInputRate?;
    private instructions?;
    private currentGeneration?;
    private bstream;
    private activeSession?;
    private sessionShouldClose;
    private responseCreatedFutures;
    private pendingGenerationFut?;
    private sessionResumptionHandle?;
    private inUserActivity;
    private sessionLock;
    private numRetries;
    private hasReceivedAudioInput;
    constructor(realtimeModel: RealtimeModel);
    private closeActiveSession;
    private markRestartNeeded;
    private getToolResultsForRealtime;
    updateOptions(options: {
        voice?: Voice | string;
        temperature?: number;
        toolChoice?: llm.ToolChoice;
    }): void;
    updateInstructions(instructions: string): Promise<void>;
    updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
    updateTools(tools: llm.ToolContext): Promise<void>;
    get chatCtx(): llm.ChatContext;
    get tools(): llm.ToolContext;
    get manualActivityDetection(): boolean;
    pushAudio(frame: AudioFrame): void;
    pushVideo(_: VideoFrame): void;
    private sendClientEvent;
    generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent>;
    startUserActivity(): void;
    interrupt(): Promise<void>;
    truncate(_options: {
        messageId: string;
        audioEndMs: number;
        audioTranscript?: string;
    }): Promise<void>;
    close(): Promise<void>;
    private sendTask;
    private onReceiveMessage;
    private truncateString;
    private loggableClientEvent;
    private loggableServerMessage;
    private markCurrentGenerationDone;
    private emitError;
    private buildConnectConfig;
    private startNewGeneration;
    private handleInputSpeechStarted;
    private handleInputSpeechStopped;
    private handleServerContent;
    private handleToolCall;
    private handleToolCallCancellation;
    private handleUsageMetadata;
    private tokenDetailsMap;
    private handleGoAway;
    commitAudio(): Promise<void>;
    clearAudio(): Promise<void>;
    private resampleAudio;
}
export {};
//# sourceMappingURL=realtime_api.d.ts.map