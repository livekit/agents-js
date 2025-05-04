// import type { VADEvent } from "../vad.js";

// /**
//  * Types for audio speech recognition and processing.
//  */
// export interface EndOfTurnInfo {
//     newTranscript: string;
//     transcriptionDelay: number;
//     endOfUtteranceDelay: number;
//   }
  
//   export interface RecognitionHooks {
//     onStartOfSpeech(ev: VADEvent): void;
//     onVADInferenceDone(ev: VADEvent): void;
//     onEndOfSpeech(ev: VADEvent): void;
//     onInterimTranscript(ev: SpeechEvent): void;
//     onFinalTranscript(ev: SpeechEvent): void;
//     onEndOfTurn(info: EndOfTurnInfo): Promise<void>;
//     retrieveChatCtx(): ChatContext;
//   }
  
//   export interface TurnDetector {
//     unlikelyThreshold(language: string | null): number | null;
//     supportsLanguage(language: string | null): boolean;
//     predictEndOfTurn(chatCtx: ChatContext): Promise<number>;
//   }
  
//   /**
//    * Processes audio frames to detect speech segments and handle turn detection.
//    */
//   export class AudioRecognition {
//     private hooks: RecognitionHooks;
//     private sttNode: STTNode | null;
//     private vad: VAD | null;
//     private turnDetector: TurnDetector | null;
//     private minEndpointingDelay: number;
//     private maxEndpointingDelay: number;
//     private manualTurnDetection: boolean;
    
//     private userTurnCommitted = false;
//     private speaking = false;
//     private lastSpeakingTime = 0;
//     private lastFinalTranscriptTime = 0;
//     private audioTranscript = "";
//     private audioInterimTranscript = "";
//     private lastLanguage: string | null = null;
//     private sampleRate: number | null = null;
    
//     private sttStream: ReadableStream<AudioFrame> | null = null;
//     private vadStream: ReadableStream<AudioFrame> | null = null;
//     private endOfTurnAbortController: AbortController | null = null;
    
//     constructor(options: {
//       hooks: RecognitionHooks;
//       stt: STTNode | null;
//       vad: VAD | null;
//       turnDetector: TurnDetector | null;
//       minEndpointingDelay: number;
//       maxEndpointingDelay: number;
//       manualTurnDetection: boolean;
//     }) {
//       this.hooks = options.hooks;
//       this.sttNode = options.stt;
//       this.vad = options.vad;
//       this.turnDetector = options.turnDetector;
//       this.minEndpointingDelay = options.minEndpointingDelay;
//       this.maxEndpointingDelay = options.maxEndpointingDelay;
//       this.manualTurnDetection = options.manualTurnDetection;
//     }
    
//     start(): void {
//       this.updateSTT(this.sttNode);
//       this.updateVAD(this.vad);
//     }
    
//     stop(): void {
//       this.updateSTT(null);
//       this.updateVAD(null);
//     }
    
//     pushAudio(frame: AudioFrame): void {
//       this.sampleRate = frame.sampleRate;
//       if (this.sttStream) {
//         // Send frame to STT stream
//       }
//       if (this.vadStream) {
//         // Send frame to VAD stream
//       }
//     }
    
//     async close(): Promise<void> {
//       // Close streams and cancel pending operations
//     }
    
//     updateSTT(stt: STTNode | null): void {
//       // Setup STT processing
//     }
    
//     updateVAD(vad: VAD | null): void {
//       // Setup VAD processing
//     }
    
//     clearUserTurn(): void {
//       this.audioTranscript = "";
//       this.audioInterimTranscript = "";
//       this.userTurnCommitted = false;
      
//       // Reset STT to clear buffer
//       const stt = this.sttNode;
//       this.updateSTT(null);
//       this.updateSTT(stt);
//     }
    
//     commitUserTurn(audioDetached: boolean): void {
//       // Commit the current turn and trigger processing
//     }
    
//     private async onSTTEvent(ev: SpeechEvent): Promise<void> {
//       if (this.manualTurnDetection && this.userTurnCommitted) {
//         return;
//       }
      
//       if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
//         this.hooks.onFinalTranscript(ev);
//         const transcript = ev.alternatives[0].text;
//         this.lastLanguage = ev.alternatives[0].language;
//         if (!transcript) {
//           return;
//         }
        
//         this.lastFinalTranscriptTime = Date.now();
//         this.audioTranscript += ` ${transcript}`;
//         this.audioTranscript = this.audioTranscript.trim();
//         this.audioInterimTranscript = "";
        
//         if (!this.speaking) {
//           if (!this.vad) {
//             this.lastSpeakingTime = Date.now();
//           }
          
//           if (!this.manualTurnDetection || this.userTurnCommitted) {
//             const chatCtx = this.hooks.retrieveChatCtx().copy();
//             this.runEOUDetection(chatCtx);
//           }
//         }
//       } else if (ev.type === SpeechEventType.INTERIM_TRANSCRIPT) {
//         this.hooks.onInterimTranscript(ev);
//         this.audioInterimTranscript = ev.alternatives[0].text;
//       }
//     }
    
//     private async onVADEvent(ev: VADEvent): Promise<void> {
//       if (ev.type === VADEventType.START_OF_SPEECH) {
//         this.hooks.onStartOfSpeech(ev);
//         this.speaking = true;
        
//         if (this.endOfTurnAbortController) {
//           this.endOfTurnAbortController.abort();
//           this.endOfTurnAbortController = null;
//         }
//       } else if (ev.type === VADEventType.INFERENCE_DONE) {
//         this.hooks.onVADInferenceDone(ev);
//       } else if (ev.type === VADEventType.END_OF_SPEECH) {
//         this.hooks.onEndOfSpeech(ev);
//         this.speaking = false;
//         this.lastSpeakingTime = Date.now() - ev.silenceDuration;
        
//         if (!this.manualTurnDetection) {
//           const chatCtx = this.hooks.retrieveChatCtx().copy();
//           this.runEOUDetection(chatCtx);
//         }
//       }
//     }
    
//     private runEOUDetection(chatCtx: ChatContext): void {
//       if (this.sttNode && !this.audioTranscript && !this.manualTurnDetection) {
//         return;
//       }
      
//       chatCtx = chatCtx.copy();
//       chatCtx.addMessage("user", this.audioTranscript);
      
//       const turnDetector = this.audioTranscript && !this.manualTurnDetection 
//         ? this.turnDetector 
//         : null;
      
//       if (this.endOfTurnAbortController) {
//         this.endOfTurnAbortController.abort();
//       }
      
//       this.endOfTurnAbortController = new AbortController();
//       const signal = this.endOfTurnAbortController.signal;
      
//       this.runEndOfTurnTask(chatCtx, turnDetector, this.lastSpeakingTime, signal);
//     }
    
//     private async runEndOfTurnTask(
//       chatCtx: ChatContext, 
//       turnDetector: TurnDetector | null,
//       lastSpeakingTime: number,
//       signal: AbortSignal
//     ): Promise<void> {
//       try {
//         let endpointingDelay = this.minEndpointingDelay;
        
//         if (turnDetector && !signal.aborted) {
//           if (!turnDetector.supportsLanguage(this.lastLanguage)) {
//             console.debug(`Turn detector doesn't support language ${this.lastLanguage}`);
//           } else {
//             const endOfTurnProbability = await turnDetector.predictEndOfTurn(chatCtx);
//             const unlikelyThreshold = turnDetector.unlikelyThreshold(this.lastLanguage);
//             if (unlikelyThreshold !== null && 
//                 endOfTurnProbability < unlikelyThreshold) {
//               endpointingDelay = this.maxEndpointingDelay;
//             }
//           }
//         }
        
//         if (signal.aborted) return;
        
//         const extraSleep = lastSpeakingTime + endpointingDelay - Date.now();
//         if (extraSleep > 0) {
//           await new Promise(resolve => setTimeout(resolve, extraSleep));
//         }
        
//         if (signal.aborted) return;
        
//         await this.hooks.onEndOfTurn({
//           newTranscript: this.audioTranscript,
//           transcriptionDelay: Math.max(
//             this.lastFinalTranscriptTime - lastSpeakingTime, 0
//           ),
//           endOfUtteranceDelay: Date.now() - lastSpeakingTime
//         });
        
//         this.audioTranscript = "";
//       } catch (err) {
//         if (err.name !== 'AbortError') {
//           console.error('Error in end of turn task:', err);
//         }
//       }
//     }
//   }
  
//   /**
//    * Manages agent activities including audio processing, speech handling,
//    * and interaction with LLM, TTS, and STT services.
//    */
//   export class AgentActivity implements RecognitionHooks {
//     private agent: Agent;
//     private session: AgentSession;
//     private rtSession: RealtimeSession | null = null;
//     private audioRecognition: AudioRecognition | null = null;
//     private lock = new AsyncLock();
//     private toolChoice: ToolChoice | null = null;
    
//     private started = false;
//     private draining = false;
    
//     private currentSpeech: SpeechHandle | null = null;
//     private speechQueue: Array<[number, number, SpeechHandle]> = [];
//     private queueUpdated = new EventEmitter();
    
//     private mainTask: Promise<void> | null = null;
//     private userTurnCompletedTask: Promise<void> | null = null;
//     private speechTasks: Set<Promise<void>> = new Set();
    
//     constructor(agent: Agent, session: AgentSession) {
//       this.agent = agent;
//       this.session = session;
      
//       this.setupTurnDetection();
//     }
    
//     private setupTurnDetection(): void {
//       // Setup turn detection mode and validate configuration
//     }
    
//     // Properties
//     get isdraining(): boolean {
//       return this.draining;
//     }
    
//     get turnDetection(): TurnDetectionMode | null {
//       return this.agent.turnDetection || this.session.turnDetection;
//     }
    
//     get stt(): STT | null {
//       return this.agent.stt || this.session.stt;
//     }
    
//     get llm(): LLM | RealtimeModel | null {
//       return this.agent.llm || this.session.llm;
//     }
    
//     get tts(): TTS | null {
//       return this.agent.tts || this.session.tts;
//     }
    
//     get vad(): VAD | null {
//       return this.agent.vad || this.session.vad;
//     }
    
//     get allowInterruptions(): boolean {
//       return this.agent.allowInterruptions ?? this.session.options.allowInterruptions;
//     }
    
//     async updateInstructions(instructions: string): Promise<void> {
//       this.agent.instructions = instructions;
      
//       if (this.rtSession) {
//         await this.rtSession.updateInstructions(instructions);
//       } else {
//         // Update instructions in the chat context
//       }
//     }
    
//     async updateTools(tools: FunctionTool[]): Promise<void> {
//       // Deduplicate tools and update agent's tools
//     }
    
//     async updateChatCtx(chatCtx: ChatContext): Promise<void> {
//       // Update chat context in agent and realtime session
//     }
    
//     updateOptions(options: { toolChoice?: ToolChoice | null }): void {
//       if (options.toolChoice !== undefined) {
//         this.toolChoice = options.toolChoice;
//       }
      
//       if (this.rtSession) {
//         this.rtSession.updateOptions({ toolChoice: this.toolChoice });
//       }
//     }
    
//     async start(): Promise<void> {
//       await this.lock.acquire(async () => {
//         this.agent.activity = this;
        
//         // Initialize realtime session if needed
        
//         // Setup audio recognition
//         this.audioRecognition = new AudioRecognition({
//           hooks: this,
//           stt: this.agent.sttNode && this.stt ? this.agent.sttNode : null,
//           vad: this.vad,
//           turnDetector: typeof this.turnDetection !== 'string' ? this.turnDetection : null,
//           minEndpointingDelay: this.session.options.minEndpointingDelay,
//           maxEndpointingDelay: this.session.options.maxEndpointingDelay,
//           manualTurnDetection: this.turnDetection === 'manual'
//         });
        
//         this.audioRecognition.start();
//         this.started = true;
        
//         // Start main task
//         this.mainTask = this.runMainTask();
        
//         // Call agent's onEnter
//         await this.agent.onEnter();
//       });
//     }
    
//     async drain(): Promise<void> {
//       await this.lock.acquire(async () => {
//         if (this.draining) {
//           return;
//         }
        
//         await this.agent.onExit();
        
//         this.wakeUpMainTask();
//         this.draining = true;
        
//         if (this.mainTask) {
//           await this.mainTask;
//         }
//       });
//     }
    
//     async close(): Promise<void> {
//       await this.lock.acquire(async () => {
//         if (!this.draining) {
//           console.warn("Activity closing without draining");
//         }
        
//         // Unregister event handlers
        
//         if (this.rtSession) {
//           await this.rtSession.close();
//         }
        
//         if (this.audioRecognition) {
//           await this.audioRecognition.close();
//         }
        
//         if (this.mainTask) {
//           // Cancel and wait for main task
//         }
        
//         this.agent.activity = null;
//       });
//     }
    
//     pushAudio(frame: AudioFrame): void {
//       if (!this.started) {
//         return;
//       }
      
//       if (this.currentSpeech && 
//           !this.currentSpeech.allowInterruptions &&
//           this.session.options.discardAudioIfUninterruptible) {
//         return;
//       }
      
//       if (this.rtSession) {
//         this.rtSession.pushAudio(frame);
//       }
      
//       if (this.audioRecognition) {
//         this.audioRecognition.pushAudio(frame);
//       }
//     }
    
//     say(
//       text: string | ReadableStream<string>,
//       options?: {
//         audio?: ReadableStream<AudioFrame>;
//         allowInterruptions?: boolean;
//         addToChatCtx?: boolean;
//       }
//     ): SpeechHandle {
//       // Create a speech handle and schedule TTS
//       const handle = SpeechHandle.create({
//         allowInterruptions: options?.allowInterruptions ?? this.allowInterruptions
//       });
      
//       this.createSpeechTask(
//         this.ttsTask(
//           handle,
//           text,
//           options?.audio || null,
//           options?.addToChatCtx ?? true,
//           new ModelSettings()
//         ),
//         handle
//       );
      
//       this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
//       return handle;
//     }
    
//     // RecognitionHooks implementation
//     onStartOfSpeech(ev: VADEvent): void {
//       this.session.updateUserState("speaking");
//     }
    
//     onEndOfSpeech(ev: VADEvent): void {
//       this.session.updateUserState("listening");
//     }
    
//     onVADInferenceDone(ev: VADEvent): void {
//       if (this.turnDetection !== 'vad' && this.turnDetection !== null) {
//         return;
//       }
      
//       if (ev.speechDuration > this.session.options.minInterruptionDuration) {
//         if (this.currentSpeech && 
//             !this.currentSpeech.interrupted &&
//             this.currentSpeech.allowInterruptions) {
//           if (this.rtSession) {
//             this.rtSession.interrupt();
//           }
//           this.currentSpeech.interrupt();
//         }
//       }
//     }
    
//     onInterimTranscript(ev: SpeechEvent): void {
//       if (this.llm instanceof RealtimeModel && this.llm.capabilities.userTranscription) {
//         return;
//       }
      
//       this.session.emit("userInputTranscribed", {
//         transcript: ev.alternatives[0].text,
//         isFinal: false
//       });
//     }
    
//     onFinalTranscript(ev: SpeechEvent): void {
//       if (this.llm instanceof RealtimeModel && this.llm.capabilities.userTranscription) {
//         return;
//       }
      
//       this.session.emit("userInputTranscribed", {
//         transcript: ev.alternatives[0].text,
//         isFinal: true
//       });
//     }
    
//     async onEndOfTurn(info: EndOfTurnInfo): Promise<void> {
//       if (this.draining) {
//         return;
//       }
      
//       const oldTask = this.userTurnCompletedTask;
//       this.userTurnCompletedTask = this.userTurnCompletedTaskImpl(oldTask, info);
//     }
    
//     retrieveChatCtx(): ChatContext {
//       return this.agent.chatCtx;
//     }
    
//     private wakeUpMainTask(): void {
//       this.queueUpdated.emit('updated');
//     }
    
//     private scheduleSpeech(
//       speech: SpeechHandle, 
//       priority: number, 
//       bypassDraining = false
//     ): void {
//       if (this.draining && !bypassDraining) {
//         throw new Error("Cannot schedule new speech, the agent is draining");
//       }
      
//       this.speechQueue.push([priority, Date.now(), speech]);
//       // Sort queue by priority and time
//       this.speechQueue.sort((a, b) => {
//         if (a[0] !== b[0]) return a[0] - b[0];
//         return a[1] - b[1];
//       });
      
//       this.wakeUpMainTask();
//     }
    
//     private async runMainTask(): Promise<void> {
//       while (true) {
//         await new Promise(resolve => this.queueUpdated.once('updated', resolve));
        
//         while (this.speechQueue.length > 0) {
//           const [_, __, speech] = this.speechQueue.shift()!;
//           this.currentSpeech = speech;
//           speech.authorizePlayout();
//           await speech.waitForPlayout();
//           this.currentSpeech = null;
//         }
        
//         if (this.draining && this.speechTasks.size === 0) {
//           break;
//         }
//       }
//     }
    
//     private createSpeechTask(
//       task: Promise<void>, 
//       speechHandle?: SpeechHandle
//     ): void {
//       const promise = task.finally(() => {
//         this.speechTasks.delete(promise);
//         if (speechHandle) {
//           speechHandle.markPlayoutDone();
//         }
//         this.wakeUpMainTask();
//       });
      
//       this.speechTasks.add(promise);
//     }
    
//     private async userTurnCompletedTaskImpl(
//       oldTask: Promise<void> | null,
//       info: EndOfTurnInfo
//     ): Promise<void> {
//       if (oldTask) {
//         await oldTask;
//       }
      
//       // Handle user input and generate reply
//     }
//   }