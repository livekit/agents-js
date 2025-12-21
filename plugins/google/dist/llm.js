import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  shortuuid
} from "@livekit/agents";
import { toFunctionDeclarations } from "./utils.js";
class LLM extends llm.LLM {
  #opts;
  #client;
  label() {
    return "google.LLM";
  }
  get model() {
    return this.#opts.model;
  }
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
  constructor({
    model,
    apiKey,
    vertexai,
    project,
    location,
    temperature,
    maxOutputTokens,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    toolChoice,
    thinkingConfig,
    automaticFunctionCallingConfig,
    geminiTools,
    httpOptions,
    seed
  } = {
    model: "gemini-2.0-flash-001"
  }) {
    super();
    const useVertexAI = vertexai ?? (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" || process.env.GOOGLE_GENAI_USE_VERTEXAI === "1");
    let gcpProject = project ?? process.env.GOOGLE_CLOUD_PROJECT;
    let gcpLocation = location ?? process.env.GOOGLE_CLOUD_LOCATION;
    let geminiApiKey = apiKey ?? process.env.GOOGLE_API_KEY;
    if (useVertexAI) {
      if (!gcpProject) {
        throw new Error(
          "Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable"
        );
      }
      geminiApiKey = void 0;
    } else {
      gcpProject = void 0;
      gcpLocation = void 0;
      if (!geminiApiKey) {
        throw new Error(
          "API key is required for Google API either via apiKey or GOOGLE_API_KEY environment variable"
        );
      }
    }
    if ((thinkingConfig == null ? void 0 : thinkingConfig.thinkingBudget) !== void 0) {
      const budget = thinkingConfig.thinkingBudget;
      if (budget < 0 || budget > 24576) {
        throw new Error("thinkingBudget inside thinkingConfig must be between 0 and 24576");
      }
    }
    const clientOptions = useVertexAI ? {
      vertexai: true,
      project: gcpProject,
      location: gcpLocation
    } : {
      apiKey: geminiApiKey
    };
    this.#client = new GoogleGenAI(clientOptions);
    this.#opts = {
      model,
      vertexai: useVertexAI,
      project: gcpProject,
      location: gcpLocation,
      temperature,
      maxOutputTokens,
      topP,
      topK,
      presencePenalty,
      frequencyPenalty,
      toolChoice,
      thinkingConfig,
      automaticFunctionCallingConfig,
      geminiTools,
      httpOptions,
      seed,
      apiKey
    };
  }
  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    toolChoice,
    extraKwargs,
    geminiTools
  }) {
    const extras = { ...extraKwargs };
    toolChoice = toolChoice !== void 0 ? toolChoice : this.#opts.toolChoice;
    if (toolChoice) {
      let geminiToolConfig;
      if (typeof toolChoice === "object" && toolChoice.type === "function") {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [toolChoice.function.name]
          }
        };
      } else if (toolChoice === "required") {
        const toolNames = Object.entries(toolCtx || {}).map(([name]) => name);
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: toolNames.length > 0 ? toolNames : void 0
          }
        };
      } else if (toolChoice === "auto") {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO
          }
        };
      } else if (toolChoice === "none") {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.NONE
          }
        };
      } else {
        throw new Error(`Invalid tool choice: ${toolChoice}`);
      }
      extras.toolConfig = geminiToolConfig;
    }
    if (this.#opts.temperature !== void 0) {
      extras.temperature = this.#opts.temperature;
    }
    if (this.#opts.maxOutputTokens !== void 0) {
      extras.maxOutputTokens = this.#opts.maxOutputTokens;
    }
    if (this.#opts.topP !== void 0) {
      extras.topP = this.#opts.topP;
    }
    if (this.#opts.topK !== void 0) {
      extras.topK = this.#opts.topK;
    }
    if (this.#opts.presencePenalty !== void 0) {
      extras.presencePenalty = this.#opts.presencePenalty;
    }
    if (this.#opts.frequencyPenalty !== void 0) {
      extras.frequencyPenalty = this.#opts.frequencyPenalty;
    }
    if (this.#opts.seed !== void 0) {
      extras.seed = this.#opts.seed;
    }
    if (this.#opts.thinkingConfig !== void 0) {
      extras.thinkingConfig = this.#opts.thinkingConfig;
    }
    if (this.#opts.automaticFunctionCallingConfig !== void 0) {
      extras.automaticFunctionCalling = this.#opts.automaticFunctionCallingConfig;
    }
    geminiTools = geminiTools !== void 0 ? geminiTools : this.#opts.geminiTools;
    return new LLMStream(this, {
      client: this.#client,
      model: this.#opts.model,
      chatCtx,
      toolCtx,
      connOptions,
      geminiTools,
      extraKwargs: extras
    });
  }
}
class LLMStream extends llm.LLMStream {
  #client;
  #model;
  #geminiTools;
  #extraKwargs;
  constructor(llm2, {
    client,
    model,
    chatCtx,
    toolCtx,
    connOptions,
    geminiTools,
    extraKwargs
  }) {
    super(llm2, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#model = model;
    this.#geminiTools = geminiTools;
    this.#extraKwargs = extraKwargs;
  }
  async run() {
    var _a, _b;
    let retryable = true;
    const requestId = `google_${Date.now()}`;
    try {
      const [turns, extraData] = await this.chatCtx.toProviderFormat("google");
      const contents = turns.map((turn) => ({
        role: turn.role,
        parts: turn.parts
      }));
      const functionDeclarations = this.toolCtx ? toFunctionDeclarations(this.toolCtx) : void 0;
      const tools = functionDeclarations && functionDeclarations.length > 0 ? [{ functionDeclarations }] : void 0;
      let systemInstruction = void 0;
      if (extraData.systemMessages && extraData.systemMessages.length > 0) {
        systemInstruction = {
          parts: extraData.systemMessages.map((content) => ({ text: content }))
        };
      }
      const response = await this.#client.models.generateContentStream({
        model: this.#model,
        contents,
        config: {
          ...this.#extraKwargs,
          systemInstruction,
          httpOptions: this.#extraKwargs.httpOptions ?? {
            timeout: Math.floor(this.connOptions.timeoutMs)
          },
          tools
        }
      });
      for await (const chunk of response) {
        if (chunk.promptFeedback) {
          throw new APIStatusError({
            message: `Prompt feedback error: ${JSON.stringify(chunk.promptFeedback)}`,
            options: {
              retryable: false,
              requestId
            }
          });
        }
        if (!chunk.candidates || !((_b = (_a = chunk.candidates[0]) == null ? void 0 : _a.content) == null ? void 0 : _b.parts)) {
          this.logger.warn(`No candidates in the response: ${JSON.stringify(chunk)}`);
          continue;
        }
        if (chunk.candidates.length > 1) {
          this.logger.warn(
            "Google LLM: there are multiple candidates in the response, returning response from the first one."
          );
        }
        for (const part of chunk.candidates[0].content.parts) {
          const chatChunk = this.#parsePart(requestId, part);
          if (chatChunk) {
            retryable = false;
            this.queue.put(chatChunk);
          }
        }
        if (chunk.usageMetadata) {
          const usage = chunk.usageMetadata;
          this.queue.put({
            id: requestId,
            usage: {
              completionTokens: usage.candidatesTokenCount || 0,
              promptTokens: usage.promptTokenCount || 0,
              promptCachedTokens: usage.cachedContentTokenCount || 0,
              totalTokens: usage.totalTokenCount || 0
            }
          });
        }
      }
    } catch (error) {
      const err = error;
      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new APIStatusError({
            message: `Google LLM: Rate limit error - ${err.message || "Unknown error"}`,
            options: {
              statusCode: 429,
              retryable: true
            }
          });
        } else {
          throw new APIStatusError({
            message: `Google LLM: Client error (${err.code}) - ${err.message || "Unknown error"}`,
            options: {
              statusCode: err.code,
              retryable: false
            }
          });
        }
      }
      if (err.code && err.code >= 500) {
        throw new APIStatusError({
          message: `Google LLM: Server error (${err.code}) - ${err.message || "Unknown error"}`,
          options: {
            statusCode: err.code,
            retryable
          }
        });
      }
      throw new APIConnectionError({
        message: `Google LLM: API error - ${err.message || "Unknown error"}`,
        options: {
          retryable
        }
      });
    }
  }
  #parsePart(id, part) {
    if (part.functionCall) {
      return {
        id,
        delta: {
          role: "assistant",
          toolCalls: [
            llm.FunctionCall.create({
              callId: part.functionCall.id || shortuuid("function_call_"),
              name: part.functionCall.name,
              args: JSON.stringify(part.functionCall.args)
            })
          ]
        }
      };
    }
    return {
      id,
      delta: {
        content: part.text,
        role: "assistant"
      }
    };
  }
}
export {
  LLM,
  LLMStream
};
//# sourceMappingURL=llm.js.map