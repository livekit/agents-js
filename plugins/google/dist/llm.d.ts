import type * as types from '@google/genai';
import { type GenerateContentConfig, GoogleGenAI } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import { llm } from '@livekit/agents';
import type { ChatModels } from './models.js';
import type { LLMTools } from './tools.js';
export interface LLMOptions {
    model: string | ChatModels;
    apiKey?: string;
    temperature?: number;
    toolChoice?: llm.ToolChoice;
    vertexai?: boolean;
    project?: string;
    location?: string;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    thinkingConfig?: types.ThinkingConfig;
    automaticFunctionCallingConfig?: types.AutomaticFunctionCallingConfig;
    geminiTools?: LLMTools;
    httpOptions?: types.HttpOptions;
    seed?: number;
}
export declare class LLM extends llm.LLM {
    #private;
    label(): string;
    get model(): string;
    /**
     * Create a new instance of Google GenAI LLM.
     *
     * Environment Requirements:
     * - For VertexAI: Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of the service account key file or use any of the other Google Cloud auth methods.
     * The Google Cloud project and location can be set via `project` and `location` arguments or the environment variables
     * `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. By default, the project is inferred from the service account key file,
     * and the location defaults to "us-central1".
     * - For Google Gemini API: Set the `apiKey` argument or the `GOOGLE_API_KEY` environment variable.
     *
     * @param model - The model name to use. Defaults to "gemini-2.0-flash-001".
     * @param apiKey - The API key for Google Gemini. If not provided, it attempts to read from the `GOOGLE_API_KEY` environment variable.
     * @param vertexai - Whether to use VertexAI. If not provided, it attempts to read from the `GOOGLE_GENAI_USE_VERTEXAI` environment variable. Defaults to false.
     * @param project - The Google Cloud project to use (only for VertexAI). Defaults to undefined.
     * @param location - The location to use for VertexAI API requests. Default value is "us-central1".
     * @param temperature - Sampling temperature for response generation. Defaults to undefined.
     * @param maxOutputTokens - Maximum number of tokens to generate in the output. Defaults to undefined.
     * @param topP - The nucleus sampling probability for response generation. Defaults to undefined.
     * @param topK - The top-k sampling value for response generation. Defaults to undefined.
     * @param presencePenalty - Penalizes the model for generating previously mentioned concepts. Defaults to undefined.
     * @param frequencyPenalty - Penalizes the model for repeating words. Defaults to undefined.
     * @param toolChoice - Specifies whether to use tools during response generation. Defaults to "auto".
     * @param thinkingConfig - The thinking configuration for response generation. Defaults to undefined.
     * @param automaticFunctionCallingConfig - The automatic function calling configuration for response generation. Defaults to undefined.
     * @param geminiTools - The Gemini-specific tools to use for the session.
     * @param httpOptions - The HTTP options to use for the session.
     * @param seed - Random seed for reproducible results. Defaults to undefined.
     */
    constructor({ model, apiKey, vertexai, project, location, temperature, maxOutputTokens, topP, topK, presencePenalty, frequencyPenalty, toolChoice, thinkingConfig, automaticFunctionCallingConfig, geminiTools, httpOptions, seed, }?: LLMOptions);
    chat({ chatCtx, toolCtx, connOptions, toolChoice, extraKwargs, geminiTools, }: {
        chatCtx: llm.ChatContext;
        toolCtx?: llm.ToolContext;
        connOptions?: APIConnectOptions;
        parallelToolCalls?: boolean;
        toolChoice?: llm.ToolChoice;
        extraKwargs?: Record<string, unknown>;
        geminiTools?: LLMTools;
    }): LLMStream;
}
export declare class LLMStream extends llm.LLMStream {
    #private;
    constructor(llm: LLM, { client, model, chatCtx, toolCtx, connOptions, geminiTools, extraKwargs, }: {
        client: GoogleGenAI;
        model: string;
        chatCtx: llm.ChatContext;
        toolCtx?: llm.ToolContext;
        connOptions: APIConnectOptions;
        geminiTools?: LLMTools;
        extraKwargs: GenerateContentConfig;
    });
    protected run(): Promise<void>;
}
//# sourceMappingURL=llm.d.ts.map