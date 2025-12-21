"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var realtime_api_exports = {};
__export(realtime_api_exports, {
  DEFAULT_IMAGE_ENCODE_OPTIONS: () => DEFAULT_IMAGE_ENCODE_OPTIONS,
  RealtimeModel: () => RealtimeModel,
  RealtimeSession: () => RealtimeSession
});
module.exports = __toCommonJS(realtime_api_exports);
var types = __toESM(require("@google/genai"), 1);
var import_genai = require("@google/genai");
var import_agents = require("@livekit/agents");
var import_mutex = require("@livekit/mutex");
var import_rtc_node = require("@livekit/rtc-node");
var import_tools = require("../../tools.cjs");
var import_utils = require("../../utils.cjs");
const INPUT_AUDIO_SAMPLE_RATE = 16e3;
const INPUT_AUDIO_CHANNELS = 1;
const OUTPUT_AUDIO_SAMPLE_RATE = 24e3;
const OUTPUT_AUDIO_CHANNELS = 1;
const DEFAULT_IMAGE_ENCODE_OPTIONS = {
  format: "JPEG",
  quality: 75,
  resizeOptions: {
    width: 1024,
    height: 1024,
    strategy: "scale_aspect_fit"
  }
};
function setsEqual(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
class RealtimeModel extends import_agents.llm.RealtimeModel {
  /** @internal */
  _options;
  constructor(options = {}) {
    var _a, _b, _c;
    const inputAudioTranscription = options.inputAudioTranscription === void 0 ? {} : options.inputAudioTranscription;
    const outputAudioTranscription = options.outputAudioTranscription === void 0 ? {} : options.outputAudioTranscription;
    let serverTurnDetection = true;
    if ((_b = (_a = options.realtimeInputConfig) == null ? void 0 : _a.automaticActivityDetection) == null ? void 0 : _b.disabled) {
      serverTurnDetection = false;
    }
    super({
      messageTruncation: false,
      turnDetection: serverTurnDetection,
      userTranscription: inputAudioTranscription !== null,
      autoToolReplyGeneration: true,
      audioOutput: ((_c = options.modalities) == null ? void 0 : _c.includes(import_genai.Modality.AUDIO)) ?? true
    });
    const apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
    const project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
    const location = options.location || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
    const vertexai = options.vertexai ?? false;
    const defaultModel = vertexai ? "gemini-2.0-flash-exp" : "gemini-2.0-flash-live-001";
    this._options = {
      model: options.model || defaultModel,
      apiKey,
      voice: options.voice || "Puck",
      language: options.language,
      responseModalities: options.modalities || [import_genai.Modality.AUDIO],
      vertexai,
      project,
      location,
      candidateCount: options.candidateCount || 1,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      instructions: options.instructions,
      inputAudioTranscription: inputAudioTranscription || void 0,
      outputAudioTranscription: outputAudioTranscription || void 0,
      imageEncodeOptions: options.imageEncodeOptions || DEFAULT_IMAGE_ENCODE_OPTIONS,
      connOptions: options.connOptions || import_agents.DEFAULT_API_CONNECT_OPTIONS,
      httpOptions: options.httpOptions,
      enableAffectiveDialog: options.enableAffectiveDialog,
      proactivity: options.proactivity,
      realtimeInputConfig: options.realtimeInputConfig,
      contextWindowCompression: options.contextWindowCompression,
      apiVersion: options.apiVersion,
      geminiTools: options.geminiTools,
      thinkingConfig: options.thinkingConfig
    };
  }
  /**
   * Create a new realtime session
   */
  session() {
    return new RealtimeSession(this);
  }
  /**
   * Update model options
   */
  updateOptions(options) {
    if (options.voice !== void 0) {
      this._options.voice = options.voice;
    }
    if (options.temperature !== void 0) {
      this._options.temperature = options.temperature;
    }
  }
  /**
   * Close the model and cleanup resources
   */
  async close() {
  }
}
class RealtimeSession extends import_agents.llm.RealtimeSession {
  _tools = {};
  _chatCtx = import_agents.llm.ChatContext.empty();
  options;
  geminiDeclarations = [];
  messageChannel = new import_agents.Queue();
  inputResampler;
  inputResamplerInputRate;
  instructions;
  currentGeneration;
  bstream;
  // Google-specific properties
  activeSession;
  sessionShouldClose = new import_agents.Event();
  responseCreatedFutures = {};
  pendingGenerationFut;
  sessionResumptionHandle;
  inUserActivity = false;
  sessionLock = new import_mutex.Mutex();
  numRetries = 0;
  hasReceivedAudioInput = false;
  #client;
  #task;
  #logger = (0, import_agents.log)();
  #closed = false;
  constructor(realtimeModel) {
    super(realtimeModel);
    this.options = realtimeModel._options;
    this.bstream = new import_agents.AudioByteStream(
      INPUT_AUDIO_SAMPLE_RATE,
      INPUT_AUDIO_CHANNELS,
      INPUT_AUDIO_SAMPLE_RATE / 20
    );
    const { apiKey, project, location, vertexai, enableAffectiveDialog, proactivity } = this.options;
    const apiVersion = !this.options.apiVersion && (enableAffectiveDialog || proactivity) ? "v1alpha" : this.options.apiVersion;
    const httpOptions = {
      ...this.options.httpOptions,
      apiVersion,
      timeout: this.options.connOptions.timeoutMs
    };
    const clientOptions = vertexai ? {
      vertexai: true,
      project,
      location,
      httpOptions
    } : {
      apiKey,
      httpOptions
    };
    this.#client = new import_genai.GoogleGenAI(clientOptions);
    this.#task = this.#mainTask();
  }
  async closeActiveSession() {
    const unlock = await this.sessionLock.lock();
    if (this.activeSession) {
      try {
        await this.activeSession.close();
      } catch (error) {
        this.#logger.warn({ error }, "Error closing Gemini session");
      } finally {
        this.activeSession = void 0;
      }
    }
    unlock();
  }
  markRestartNeeded() {
    if (!this.sessionShouldClose.isSet) {
      this.sessionShouldClose.set();
      this.messageChannel = new import_agents.Queue();
    }
  }
  getToolResultsForRealtime(ctx, vertexai) {
    const toolResponses = [];
    for (const item of ctx.items) {
      if (item.type === "function_call_output") {
        const response = {
          id: item.callId,
          name: item.name,
          response: { output: item.output }
        };
        if (!vertexai) {
          response.id = item.callId;
        }
        toolResponses.push(response);
      }
    }
    return toolResponses.length > 0 ? { functionResponses: toolResponses } : void 0;
  }
  updateOptions(options) {
    let shouldRestart = false;
    if (options.voice !== void 0 && this.options.voice !== options.voice) {
      this.options.voice = options.voice;
      shouldRestart = true;
    }
    if (options.temperature !== void 0 && this.options.temperature !== options.temperature) {
      this.options.temperature = options.temperature;
      shouldRestart = true;
    }
    if (shouldRestart) {
      this.markRestartNeeded();
    }
  }
  async updateInstructions(instructions) {
    if (this.options.instructions === void 0 || this.options.instructions !== instructions) {
      this.options.instructions = instructions;
      this.markRestartNeeded();
    }
  }
  async updateChatCtx(chatCtx) {
    const unlock = await this.sessionLock.lock();
    try {
      if (!this.activeSession) {
        this._chatCtx = chatCtx.copy();
        return;
      }
    } finally {
      unlock();
    }
    const diffOps = import_agents.llm.computeChatCtxDiff(this._chatCtx, chatCtx);
    if (diffOps.toRemove.length > 0) {
      this.#logger.warn("Gemini Live does not support removing messages");
    }
    const appendCtx = import_agents.llm.ChatContext.empty();
    for (const [, itemId] of diffOps.toCreate) {
      const item = chatCtx.getById(itemId);
      if (item) {
        appendCtx.items.push(item);
      }
    }
    if (appendCtx.items.length > 0) {
      const [turns] = await appendCtx.copy({
        excludeFunctionCall: true
      }).toProviderFormat("google", false);
      const toolResults = this.getToolResultsForRealtime(appendCtx, this.options.vertexai);
      if (turns.length > 0) {
        this.sendClientEvent({
          type: "content",
          value: {
            turns,
            turnComplete: false
          }
        });
      }
      if (toolResults) {
        this.sendClientEvent({
          type: "tool_response",
          value: toolResults
        });
      }
    }
    this._chatCtx = chatCtx.copy();
  }
  async updateTools(tools) {
    const newDeclarations = (0, import_utils.toFunctionDeclarations)(tools);
    const currentToolNames = new Set(this.geminiDeclarations.map((f) => f.name));
    const newToolNames = new Set(newDeclarations.map((f) => f.name));
    if (!setsEqual(currentToolNames, newToolNames)) {
      this.geminiDeclarations = newDeclarations;
      this._tools = tools;
      this.markRestartNeeded();
    }
  }
  get chatCtx() {
    return this._chatCtx.copy();
  }
  get tools() {
    return { ...this._tools };
  }
  get manualActivityDetection() {
    var _a, _b;
    return ((_b = (_a = this.options.realtimeInputConfig) == null ? void 0 : _a.automaticActivityDetection) == null ? void 0 : _b.disabled) ?? false;
  }
  pushAudio(frame) {
    this.hasReceivedAudioInput = true;
    for (const f of this.resampleAudio(frame)) {
      for (const nf of this.bstream.write(f.data.buffer)) {
        const realtimeInput = {
          mediaChunks: [
            {
              mimeType: "audio/pcm",
              data: Buffer.from(nf.data.buffer).toString("base64")
            }
          ]
        };
        this.sendClientEvent({
          type: "realtime_input",
          value: realtimeInput
        });
      }
    }
  }
  pushVideo(_) {
  }
  sendClientEvent(event) {
    this.messageChannel.put(event);
  }
  async generateReply(instructions) {
    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      this.#logger.warn(
        "generateReply called while another generation is pending, cancelling previous."
      );
      this.pendingGenerationFut.reject(new Error("Superseded by new generate_reply call"));
    }
    const fut = new import_agents.Future();
    this.pendingGenerationFut = fut;
    if (this.inUserActivity) {
      this.sendClientEvent({
        type: "realtime_input",
        value: {
          activityEnd: {}
        }
      });
      this.inUserActivity = false;
    }
    const turns = [];
    if (instructions !== void 0) {
      turns.push({
        parts: [{ text: instructions }],
        role: "model"
      });
    }
    turns.push({
      parts: [{ text: "." }],
      role: "user"
    });
    this.sendClientEvent({
      type: "content",
      value: {
        turns,
        turnComplete: true
      }
    });
    const timeoutHandle = setTimeout(() => {
      if (!fut.done) {
        fut.reject(new Error("generateReply timed out waiting for generation_created event."));
        if (this.pendingGenerationFut === fut) {
          this.pendingGenerationFut = void 0;
        }
      }
    }, 5e3);
    fut.await.finally(() => clearTimeout(timeoutHandle));
    return fut.await;
  }
  startUserActivity() {
    if (!this.manualActivityDetection) {
      return;
    }
    if (!this.inUserActivity) {
      this.inUserActivity = true;
      this.sendClientEvent({
        type: "realtime_input",
        value: {
          activityStart: {}
        }
      });
    }
  }
  async interrupt() {
    var _a;
    if (((_a = this.options.realtimeInputConfig) == null ? void 0 : _a.activityHandling) === import_genai.ActivityHandling.NO_INTERRUPTION) {
      return;
    }
    this.startUserActivity();
  }
  async truncate(_options) {
    this.#logger.warn("truncate is not supported by the Google Realtime API.");
  }
  async close() {
    super.close();
    this.#closed = true;
    this.sessionShouldClose.set();
    await this.closeActiveSession();
    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      this.pendingGenerationFut.reject(new Error("Session closed"));
    }
    for (const fut of Object.values(this.responseCreatedFutures)) {
      if (!fut.done) {
        fut.reject(new Error("Session closed before response created"));
      }
    }
    this.responseCreatedFutures = {};
    if (this.currentGeneration) {
      this.markCurrentGenerationDone();
    }
  }
  async #mainTask() {
    const maxRetries = this.options.connOptions.maxRetry;
    while (!this.#closed) {
      await this.closeActiveSession();
      this.sessionShouldClose.clear();
      const config = this.buildConnectConfig();
      try {
        this.#logger.debug("Connecting to Gemini Realtime API...");
        const sessionOpened = new import_agents.Event();
        const session = await this.#client.live.connect({
          model: this.options.model,
          callbacks: {
            onopen: () => sessionOpened.set(),
            onmessage: (message) => {
              this.onReceiveMessage(session, message);
            },
            onerror: (error) => {
              this.#logger.error("Gemini Live session error:", error);
              if (!this.sessionShouldClose.isSet) {
                this.markRestartNeeded();
              }
            },
            onclose: (event) => {
              this.#logger.debug("Gemini Live session closed:", event.code, event.reason);
              this.markCurrentGenerationDone();
            }
          },
          config
        });
        await sessionOpened.wait();
        const unlock = await this.sessionLock.lock();
        try {
          this.activeSession = session;
          const [turns] = await this._chatCtx.copy({
            excludeFunctionCall: true
          }).toProviderFormat("google", false);
          if (turns.length > 0) {
            await session.sendClientContent({
              turns,
              turnComplete: false
            });
          }
        } finally {
          unlock();
        }
        const sendTask = import_agents.Task.from((controller) => this.sendTask(session, controller));
        const restartWaitTask = import_agents.Task.from(({ signal }) => {
          const abortEvent = new import_agents.Event();
          signal.addEventListener("abort", () => abortEvent.set());
          return Promise.race([this.sessionShouldClose.wait(), abortEvent.wait()]);
        });
        await Promise.race([sendTask.result, restartWaitTask.result]);
        if (!restartWaitTask.done && this.#closed) {
          break;
        }
        await (0, import_agents.cancelAndWait)([sendTask, restartWaitTask], 2e3);
      } catch (error) {
        this.#logger.error(`Gemini Realtime API error: ${error}`);
        if (this.#closed) break;
        if (maxRetries === 0) {
          this.emitError(error, false);
          throw new import_agents.APIConnectionError({
            message: "Failed to connect to Gemini Live"
          });
        }
        if (this.numRetries >= maxRetries) {
          this.emitError(error, false);
          throw new import_agents.APIConnectionError({
            message: `Failed to connect to Gemini Live after ${maxRetries} attempts`
          });
        }
        const retryInterval = this.numRetries === 100 ? 0 : this.options.connOptions.retryIntervalMs;
        this.#logger.warn(
          {
            attempt: this.numRetries,
            maxRetries
          },
          `Gemini Realtime API connection failed, retrying in ${retryInterval}ms`
        );
        await (0, import_agents.delay)(retryInterval);
        this.numRetries++;
      } finally {
        await this.closeActiveSession();
      }
    }
  }
  async sendTask(session, controller) {
    try {
      while (!this.#closed && !this.sessionShouldClose.isSet && !controller.signal.aborted) {
        const msg = await this.messageChannel.get();
        if (controller.signal.aborted) break;
        const unlock = await this.sessionLock.lock();
        try {
          if (this.sessionShouldClose.isSet || this.activeSession !== session) {
            break;
          }
        } finally {
          unlock();
        }
        switch (msg.type) {
          case "content":
            const { turns, turnComplete } = msg.value;
            this.#logger.debug(`(client) -> ${JSON.stringify(this.loggableClientEvent(msg))}`);
            await session.sendClientContent({
              turns,
              turnComplete: turnComplete ?? true
            });
            break;
          case "tool_response":
            const { functionResponses } = msg.value;
            if (functionResponses) {
              this.#logger.debug(`(client) -> ${JSON.stringify(this.loggableClientEvent(msg))}`);
              await session.sendToolResponse({
                functionResponses
              });
            }
            break;
          case "realtime_input":
            const { mediaChunks, activityStart, activityEnd } = msg.value;
            if (mediaChunks) {
              for (const mediaChunk of mediaChunks) {
                await session.sendRealtimeInput({ media: mediaChunk });
              }
            }
            if (activityStart) await session.sendRealtimeInput({ activityStart });
            if (activityEnd) await session.sendRealtimeInput({ activityEnd });
            break;
          default:
            this.#logger.warn(`Warning: Received unhandled message type: ${msg.type}`);
            break;
        }
      }
    } catch (e) {
      if (!this.sessionShouldClose.isSet) {
        this.#logger.error(`Error in send task: ${e}`);
        this.markRestartNeeded();
      }
    } finally {
      this.#logger.debug(
        {
          closed: this.#closed,
          sessionShouldClose: this.sessionShouldClose.isSet,
          aborted: controller.signal.aborted
        },
        "send task finished."
      );
    }
  }
  async onReceiveMessage(session, response) {
    var _a, _b, _c;
    const hasAudioData = (_c = (_b = (_a = response.serverContent) == null ? void 0 : _a.modelTurn) == null ? void 0 : _b.parts) == null ? void 0 : _c.some(
      (part) => {
        var _a2;
        return (_a2 = part.inlineData) == null ? void 0 : _a2.data;
      }
    );
    if (!hasAudioData) {
      this.#logger.debug(`(server) <- ${JSON.stringify(this.loggableServerMessage(response))}`);
    }
    const unlock = await this.sessionLock.lock();
    try {
      if (this.sessionShouldClose.isSet || this.activeSession !== session) {
        this.#logger.debug("onReceiveMessage: Session changed or closed, stopping receive.");
        return;
      }
    } finally {
      unlock();
    }
    if ((!this.currentGeneration || this.currentGeneration._done) && (response.serverContent || response.toolCall)) {
      this.startNewGeneration();
    }
    if (response.sessionResumptionUpdate) {
      if (response.sessionResumptionUpdate.resumable && response.sessionResumptionUpdate.newHandle) {
        this.sessionResumptionHandle = response.sessionResumptionUpdate.newHandle;
      }
    }
    try {
      if (response.serverContent) {
        this.handleServerContent(response.serverContent);
      }
      if (response.toolCall) {
        this.handleToolCall(response.toolCall);
      }
      if (response.toolCallCancellation) {
        this.handleToolCallCancellation(response.toolCallCancellation);
      }
      if (response.usageMetadata) {
        this.handleUsageMetadata(response.usageMetadata);
      }
      if (response.goAway) {
        this.handleGoAway(response.goAway);
      }
      if (this.numRetries > 0) {
        this.numRetries = 0;
      }
    } catch (e) {
      if (!this.sessionShouldClose.isSet) {
        this.#logger.error(`Error in onReceiveMessage: ${e}`);
        this.markRestartNeeded();
      }
    }
  }
  /// Truncate large base64/audio payloads for logging to avoid flooding logs
  truncateString(data, maxLength = 30) {
    return data.length > maxLength ? `${data.slice(0, maxLength)}\u2026` : data;
  }
  loggableClientEvent(event, maxLength = 30) {
    var _a;
    const obj = { ...event };
    if (obj.type === "realtime_input" && ((_a = obj.value) == null ? void 0 : _a.mediaChunks)) {
      obj.value = {
        ...obj.value,
        mediaChunks: obj.value.mediaChunks.map(
          (mc) => ({
            ...mc,
            data: typeof mc.data === "string" ? this.truncateString(mc.data, maxLength) : mc.data
          })
        )
      };
    }
    return obj;
  }
  loggableServerMessage(message, maxLength = 30) {
    const obj = { ...message };
    if (obj.serverContent && obj.serverContent.modelTurn && Array.isArray(obj.serverContent.modelTurn.parts)) {
      obj.serverContent = { ...obj.serverContent };
      obj.serverContent.modelTurn = { ...obj.serverContent.modelTurn };
      obj.serverContent.modelTurn.parts = obj.serverContent.modelTurn.parts.map((part) => {
        var _a;
        if (((_a = part == null ? void 0 : part.inlineData) == null ? void 0 : _a.data) && typeof part.inlineData.data === "string") {
          return {
            ...part,
            inlineData: {
              ...part.inlineData,
              data: this.truncateString(part.inlineData.data, maxLength)
            }
          };
        }
        return part;
      });
    }
    return obj;
  }
  markCurrentGenerationDone() {
    if (!this.currentGeneration || this.currentGeneration._done) {
      return;
    }
    this.handleInputSpeechStopped();
    const gen = this.currentGeneration;
    if (gen.inputTranscription) {
      this.emit("input_audio_transcription_completed", {
        itemId: gen.inputId,
        transcript: gen.inputTranscription,
        isFinal: true
      });
      this._chatCtx.addMessage({
        role: "user",
        content: gen.inputTranscription,
        id: gen.inputId
      });
    }
    if (gen.outputText) {
      this._chatCtx.addMessage({
        role: "assistant",
        content: gen.outputText,
        id: gen.responseId
      });
    }
    if (this.options.outputAudioTranscription === void 0) {
      gen.textChannel.write("");
    }
    gen.textChannel.close();
    gen.audioChannel.close();
    gen.functionChannel.close();
    gen.messageChannel.close();
    gen._done = true;
  }
  emitError(error, recoverable) {
    this.emit("error", {
      timestamp: Date.now(),
      // TODO(brian): add label to realtime model
      label: "google_realtime",
      error,
      recoverable
    });
  }
  buildConnectConfig() {
    const opts = this.options;
    const config = {
      responseModalities: opts.responseModalities,
      systemInstruction: opts.instructions ? {
        parts: [{ text: opts.instructions }]
      } : void 0,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voice
          }
        },
        languageCode: opts.language
      },
      tools: [
        {
          functionDeclarations: this.geminiDeclarations,
          ...this.options.geminiTools
        }
      ],
      inputAudioTranscription: opts.inputAudioTranscription,
      outputAudioTranscription: opts.outputAudioTranscription,
      sessionResumption: {
        handle: this.sessionResumptionHandle
      }
    };
    if (opts.temperature !== void 0) {
      config.temperature = opts.temperature;
    }
    if (opts.maxOutputTokens !== void 0) {
      config.maxOutputTokens = opts.maxOutputTokens;
    }
    if (opts.topP !== void 0) {
      config.topP = opts.topP;
    }
    if (opts.topK !== void 0) {
      config.topK = opts.topK;
    }
    if (opts.proactivity !== void 0) {
      config.proactivity = { proactiveAudio: opts.proactivity };
    }
    if (opts.enableAffectiveDialog !== void 0) {
      config.enableAffectiveDialog = opts.enableAffectiveDialog;
    }
    if (opts.realtimeInputConfig !== void 0) {
      config.realtimeInputConfig = opts.realtimeInputConfig;
    }
    if (opts.contextWindowCompression !== void 0) {
      config.contextWindowCompression = opts.contextWindowCompression;
    }
    if (opts.thinkingConfig !== void 0) {
      config.generationConfig = {
        thinkingConfig: opts.thinkingConfig
      };
    }
    return config;
  }
  startNewGeneration() {
    if (this.currentGeneration && !this.currentGeneration._done) {
      this.#logger.warn("Starting new generation while another is active. Finalizing previous.");
      this.markCurrentGenerationDone();
    }
    const responseId = (0, import_agents.shortuuid)("GR_");
    this.currentGeneration = {
      messageChannel: import_agents.stream.createStreamChannel(),
      functionChannel: import_agents.stream.createStreamChannel(),
      responseId,
      inputId: (0, import_agents.shortuuid)("GI_"),
      textChannel: import_agents.stream.createStreamChannel(),
      audioChannel: import_agents.stream.createStreamChannel(),
      inputTranscription: "",
      outputText: "",
      _createdTimestamp: Date.now(),
      _done: false
    };
    if (!this._realtimeModel.capabilities.audioOutput) {
      this.currentGeneration.audioChannel.close();
    }
    const modalities = this._realtimeModel.capabilities.audioOutput ? ["audio", "text"] : ["text"];
    this.currentGeneration.messageChannel.write({
      messageId: responseId,
      textStream: this.currentGeneration.textChannel.stream(),
      audioStream: this.currentGeneration.audioChannel.stream(),
      modalities: Promise.resolve(modalities)
    });
    const generationEvent = {
      messageStream: this.currentGeneration.messageChannel.stream(),
      functionStream: this.currentGeneration.functionChannel.stream(),
      userInitiated: false
    };
    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      generationEvent.userInitiated = true;
      this.pendingGenerationFut.resolve(generationEvent);
      this.pendingGenerationFut = void 0;
    } else {
      this.handleInputSpeechStarted();
    }
    this.emit("generation_created", generationEvent);
  }
  handleInputSpeechStarted() {
    this.emit("input_speech_started", {});
  }
  handleInputSpeechStopped() {
    this.emit("input_speech_stopped", {
      userTranscriptionEnabled: false
    });
  }
  handleServerContent(serverContent) {
    if (!this.currentGeneration) {
      this.#logger.warn("received server content but no active generation.");
      return;
    }
    const gen = this.currentGeneration;
    if (serverContent.modelTurn) {
      const turn = serverContent.modelTurn;
      for (const part of turn.parts || []) {
        if (part.text) {
          gen.outputText += part.text;
          gen.textChannel.write(part.text);
        }
        if (part.inlineData) {
          if (!gen._firstTokenTimestamp) {
            gen._firstTokenTimestamp = Date.now();
          }
          try {
            if (!part.inlineData.data) {
              throw new Error("frameData is not bytes");
            }
            const binaryString = atob(part.inlineData.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const int16Array = new Int16Array(bytes.buffer);
            const audioFrame = new import_rtc_node.AudioFrame(
              int16Array,
              OUTPUT_AUDIO_SAMPLE_RATE,
              OUTPUT_AUDIO_CHANNELS,
              int16Array.length / OUTPUT_AUDIO_CHANNELS
            );
            gen.audioChannel.write(audioFrame);
          } catch (error) {
            this.#logger.error("Error processing audio data:", error);
          }
        }
      }
    }
    if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
      let text = serverContent.inputTranscription.text;
      if (gen.inputTranscription === "") {
        text = text.trimStart();
      }
      gen.inputTranscription += text;
      this.emit("input_audio_transcription_completed", {
        itemId: gen.inputId,
        transcript: gen.inputTranscription,
        isFinal: false
      });
    }
    if (serverContent.outputTranscription && serverContent.outputTranscription.text) {
      const text = serverContent.outputTranscription.text;
      gen.outputText += text;
      gen.textChannel.write(text);
    }
    if (serverContent.generationComplete || serverContent.turnComplete) {
      gen._completedTimestamp = Date.now();
    }
    if (serverContent.interrupted) {
      this.handleInputSpeechStarted();
    }
    if (serverContent.turnComplete) {
      this.markCurrentGenerationDone();
    }
  }
  handleToolCall(toolCall) {
    if (!this.currentGeneration) {
      this.#logger.warn("received tool call but no active generation.");
      return;
    }
    const gen = this.currentGeneration;
    for (const fc of toolCall.functionCalls || []) {
      gen.functionChannel.write({
        callId: fc.id || (0, import_agents.shortuuid)("fnc-call-"),
        name: fc.name,
        args: fc.args ? JSON.stringify(fc.args) : ""
      });
    }
    this.markCurrentGenerationDone();
  }
  handleToolCallCancellation(cancellation) {
    this.#logger.warn(
      {
        functionCallIds: cancellation.ids
      },
      "server cancelled tool calls"
    );
  }
  handleUsageMetadata(usage) {
    if (!this.currentGeneration) {
      this.#logger.debug("Received usage metadata but no active generation");
      return;
    }
    const gen = this.currentGeneration;
    const createdTimestamp = gen._createdTimestamp;
    const firstTokenTimestamp = gen._firstTokenTimestamp;
    const completedTimestamp = gen._completedTimestamp || Date.now();
    const ttftMs = firstTokenTimestamp ? firstTokenTimestamp - createdTimestamp : -1;
    const durationMs = completedTimestamp - createdTimestamp;
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.responseTokenCount || 0;
    const totalTokens = usage.totalTokenCount || 0;
    const realtimeMetrics = {
      type: "realtime_model_metrics",
      timestamp: createdTimestamp,
      requestId: gen.responseId,
      ttftMs,
      durationMs,
      cancelled: gen._done && !gen._completedTimestamp,
      label: "google_realtime",
      inputTokens,
      outputTokens,
      totalTokens,
      tokensPerSecond: durationMs > 0 ? outputTokens / (durationMs / 1e3) : 0,
      inputTokenDetails: {
        ...this.tokenDetailsMap(usage.promptTokensDetails),
        cachedTokens: (usage.cacheTokensDetails || []).reduce(
          (sum, detail) => sum + (detail.tokenCount || 0),
          0
        ),
        cachedTokensDetails: this.tokenDetailsMap(usage.cacheTokensDetails)
      },
      outputTokenDetails: this.tokenDetailsMap(usage.responseTokensDetails)
    };
    this.emit("metrics_collected", realtimeMetrics);
  }
  tokenDetailsMap(tokenDetails) {
    const tokenDetailsMap = { audioTokens: 0, textTokens: 0, imageTokens: 0 };
    if (!tokenDetails) {
      return tokenDetailsMap;
    }
    for (const tokenDetail of tokenDetails) {
      if (!tokenDetail.tokenCount) {
        continue;
      }
      if (tokenDetail.modality === types.MediaModality.AUDIO) {
        tokenDetailsMap.audioTokens += tokenDetail.tokenCount;
      } else if (tokenDetail.modality === types.MediaModality.TEXT) {
        tokenDetailsMap.textTokens += tokenDetail.tokenCount;
      } else if (tokenDetail.modality === types.MediaModality.IMAGE) {
        tokenDetailsMap.imageTokens += tokenDetail.tokenCount;
      }
    }
    return tokenDetailsMap;
  }
  handleGoAway(goAway) {
    this.#logger.warn({ timeLeft: goAway.timeLeft }, "Gemini server indicates disconnection soon.");
    this.sessionShouldClose.set();
  }
  async commitAudio() {
  }
  async clearAudio() {
  }
  *resampleAudio(frame) {
    if (this.inputResampler) {
      if (frame.sampleRate !== this.inputResamplerInputRate) {
        this.inputResampler = void 0;
        this.inputResamplerInputRate = void 0;
      }
    }
    if (this.inputResampler === void 0 && (frame.sampleRate !== INPUT_AUDIO_SAMPLE_RATE || frame.channels !== INPUT_AUDIO_CHANNELS)) {
      this.inputResampler = new import_rtc_node.AudioResampler(
        frame.sampleRate,
        INPUT_AUDIO_SAMPLE_RATE,
        INPUT_AUDIO_CHANNELS
      );
      this.inputResamplerInputRate = frame.sampleRate;
    }
    if (this.inputResampler) {
      for (const resampledFrame of this.inputResampler.push(frame)) {
        yield resampledFrame;
      }
    } else {
      yield frame;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_IMAGE_ENCODE_OPTIONS,
  RealtimeModel,
  RealtimeSession
});
//# sourceMappingURL=realtime_api.cjs.map