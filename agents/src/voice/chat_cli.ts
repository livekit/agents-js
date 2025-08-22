import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import process from 'node:process';
import readline from 'node:readline';
import { setInterval as setIntervalSafe, clearInterval as clearIntervalSafe } from 'node:timers';
import { log } from '../log.js';
import { AsyncIterableQueue } from '../utils.js';
import type { Agent } from './agent.js';
import type { AgentSession } from './agent_session.js';
import { AudioInput, AudioOutput, TextOutput, type PlaybackFinishedEvent } from './io.js';
import { TranscriptionSynchronizer } from './transcription/synchronizer.js';
import { ReadableStream } from 'node:stream/web';

const require = createRequire(import.meta.url);

const MAX_AUDIO_BAR = 30;
const INPUT_DB_MIN = -70.0;
const INPUT_DB_MAX = 0.0;
const FPS = 16;
const MIN_RMS = 2.0;

function esc(...codes: number[]): string {
  return `\u001b[${codes.join(';')}m`;
}

function clampNormalizeDb(amplitudeDb: number, dbMin: number, dbMax: number): number {
  amplitudeDb = Math.max(dbMin, Math.min(amplitudeDb, dbMax));
  return (amplitudeDb - dbMin) / (dbMax - dbMin);
}

class ConsoleAudioInput extends AudioInput {
  private sampleRate: number;
  private numChannels: number;
  private framesPerBuffer: number;
  private deviceId: number | undefined;
  private ai: any | null = null;
  private started = false;
  private queue = new AsyncIterableQueue<AudioFrame>();
  private sourceSet = false;
  private logger = log();
  private mockInterval: NodeJS.Timeout | null = null;

  microDb: number = INPUT_DB_MIN;
  receivedAudio: boolean = false;

  constructor({ sampleRate = 24000, numChannels = 1, framesPerBuffer = 240, deviceId }: { sampleRate?: number; numChannels?: number; framesPerBuffer?: number; deviceId?: number } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.framesPerBuffer = framesPerBuffer;
    this.deviceId = deviceId;
  }

  async onAttached(): Promise<void> {

    if (!this.sourceSet) {
      const stream = new ReadableStream<AudioFrame>({
        start: async (controller) => {
          (async () => {
            for await (const frame of this.queue) {
              controller.enqueue(frame);
            }
            controller.close();
          })().catch((error) => {
            this.logger.error({ error }, 'ConsoleAudioInput stream error');
          });
        },
        cancel: async () => {
          // noop
        },
      });
      this.deferredStream.setSource(stream);
      this.sourceSet = true;
    }

    if (this.started) return;
    await this.startDevice();
  }

  onDetached(): void {
    if (!this.started) return;
    try {
      this.stopDevice();
    } catch (error) {
      this.logger.warn({ error }, 'ConsoleAudioInput stopDevice error');
    }
  }

  private async startDevice() {
    try {
      // Try to use our native audio implementation
      const { AudioIO, SampleFormat16Bit } = await import('./native_audio.js');
      
      this.ai = new AudioIO({
        inOptions: {
          channelCount: this.numChannels,
          sampleFormat: SampleFormat16Bit,
          sampleRate: this.sampleRate,
          framesPerBuffer: this.framesPerBuffer,
        },
        outOptions: undefined, // input only
      });

      this.ai.on('data', (buf: Buffer) => {
        // Convert to AudioFrame
        const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
        const frame = new AudioFrame(int16, this.sampleRate, this.numChannels, int16.length);

        // Calculate audio level
        const maxInt16 = 32767;
        let rms = 0;
        for (let i = 0; i < int16.length; i++) {
          const v = int16[i]! / maxInt16;
          rms += v * v;
        }
        rms = Math.sqrt(rms / int16.length) * maxInt16;
        const db = 20.0 * Math.log10(rms / maxInt16 + 1e-6);
        this.microDb = db;
        if (rms > MIN_RMS) {
          this.receivedAudio = true;
        }

        this.queue.put(frame);
      });

      this.ai.on('error', (err: Error) => {
        this.logger.error({ error: err }, 'Audio input error');
      });

      this.ai.start();
      this.started = true;
      // Audio input started successfully
    } catch (error) {
      // Fallback to mock audio
      this.logger.warn('Native audio failed, using mock audio input');
      
      const frameSize = this.framesPerBuffer;
      const intervalMs = (frameSize / this.sampleRate) * 1000;
      
      this.mockInterval = setInterval(() => {
        const silentData = new Int16Array(frameSize * this.numChannels);
        const frame = new AudioFrame(silentData, this.sampleRate, this.numChannels, frameSize);
        
        this.microDb = INPUT_DB_MIN + Math.random() * 10;
        this.receivedAudio = true;
        this.queue.put(frame);
      }, intervalMs);
      
      this.started = true;
    }
  }

  private stopDevice() {
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
    if (this.ai) {
      try {
        this.ai.quit?.();
      } catch {
        try {
          this.ai.stop?.();
        } catch {}
      }
      this.ai = null;
    }
    this.started = false;
  }
}

class StdoutTextOutput extends TextOutput {
  private capturing = false;
  private enabled = true;

  async captureText(text: string): Promise<void> {
    if (!this.enabled) return;
    if (!this.capturing) {
      this.capturing = true;
      process.stdout.write('\r');
      process.stdout.write(esc(36));
    }
    process.stdout.write(text);
  }

  flush(): void {
    if (this.capturing) {
      process.stdout.write(esc(0));
      process.stdout.write('\n');
      this.capturing = false;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.capturing = false;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }
}

class ConsoleAudioOutput extends AudioOutput {
  private outputSampleRate: number;
  private numChannels: number;
  private ao: any | null = null;
  private started = false;
  private pushedDuration = 0.0;
  private captureStart = 0;
  private dispatchTimer: NodeJS.Timeout | null = null;
  private _logger = log();

  constructor({ sampleRate = 24000, numChannels = 1 }: { sampleRate?: number; numChannels?: number } = {}) {
    super(sampleRate);
    this.outputSampleRate = sampleRate;
    this.numChannels = numChannels;
  }

  async onAttached(): Promise<void> {
    if (this.started) return;
    
    try {
      // Try to use our native audio implementation
      const { AudioIO } = await import('./native_audio.js');
      
      this.ao = new AudioIO({
        inOptions: undefined, // output only
        outOptions: {
          channelCount: this.numChannels,
          sampleRate: this.outputSampleRate,
        },
      });
      
      this.ao.start();
      this.started = true;
      this._logger.info('Using native audio output via command-line tools');
    } catch (error) {
      // Fallback to mock audio output
      this._logger.warn('Native audio failed, using mock audio output', error);
      
      this.ao = {
        write: (data: Buffer) => {
          const frameCount = data.length / (2 * this.numChannels);
          const durationMs = (frameCount / this.outputSampleRate) * 1000;
          
          setTimeout(() => {
            this.emit('playbackFinished');
          }, durationMs);
        },
        end: () => {},
      };
      
      this.started = true;
    }
  }

  onDetached(): void {
    if (!this.started) return;
    try {
      this.ao?.end?.();
    } catch {}
    this.ao = null;
    this.started = false;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (!this.captureStart) {
      this.captureStart = Date.now();
    }
    this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
    if (this.ao) {
      const view = new Int16Array(frame.data);
      const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      this.ao.write(buf);
    }
  }

  flush(): void {
    super.flush();
    if (this.pushedDuration > 0) {
      const elapsed = (Date.now() - this.captureStart) / 1000;
      const toWait = Math.max(0, this.pushedDuration - elapsed);
      if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
      this.dispatchTimer = setTimeout(() => this.dispatchPlaybackFinished(), toWait * 1000);
    }
  }

  clearBuffer(): void {
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = null;
    }
    const played = Math.min((Date.now() - this.captureStart) / 1000, this.pushedDuration);
    this.onPlaybackFinished({ playbackPosition: played, interrupted: played + 1.0 < this.pushedDuration });
    this.pushedDuration = 0;
    this.captureStart = 0;
  }

  private dispatchPlaybackFinished(): void {
    const ev: PlaybackFinishedEvent = { playbackPosition: this.pushedDuration, interrupted: false };
    this.onPlaybackFinished(ev);
    this.pushedDuration = 0;
    this.captureStart = 0;
  }
}

export class ChatCLI extends EventEmitter {
  private loop: NodeJS.Timeout | null = null;
  private session: AgentSession;
  private textSink: StdoutTextOutput;
  private audioSink: ConsoleAudioOutput;
  private transcriptSyncer: TranscriptionSynchronizer | null = null;
  private inputAudio: ConsoleAudioInput;
  private mode: 'text' | 'audio' = 'audio';
  private textBuf: string[] = [];
  private micName: string = 'Microphone';
  private logger = log();
  private micCheckTimer: NodeJS.Timeout | null = null;
  private currentAudioLine: string = '';
  private isLogging: boolean = false;


  constructor(agentSession: AgentSession, { syncTranscription = true }: { syncTranscription?: boolean } = {}) {
    super();
    this.session = agentSession;
    this.textSink = new StdoutTextOutput();
    this.audioSink = new ConsoleAudioOutput();
    this.inputAudio = new ConsoleAudioInput();
    
    if (syncTranscription) {
      this.transcriptSyncer = new TranscriptionSynchronizer(this.audioSink, this.textSink);
    }

    // Set logger to only show warnings and errors in console mode
    this.logger.level = 'warn';
  }

  async start(): Promise<void> {
    if (this.transcriptSyncer) {
      this.updateTextOutput({ enable: true, stdoutEnable: false });
    }

    this.updateMicrophone(true);
    this.updateSpeaker(true);
    this.renderLoopStart();
    this.stdinStart();
  }

  stop(): void {
    this.renderLoopStop();
    this.stdinStop();
    this.updateMicrophone(false);
    this.updateSpeaker(false);
  }

  private renderLoopStart() {
    const interval = 1000 / FPS;
    this.loop = setIntervalSafe(() => {
      if (this.mode === 'audio' && !this.textSink.isCapturing) {
        this.printAudioMode();
      } else if (this.mode === 'text' && !this.textSink.isCapturing) {
        this.printTextMode();
      }
    }, interval);
  }

  private renderLoopStop() {
    if (this.loop) clearIntervalSafe(this.loop);
    this.loop = null;
  }

  private stdinStart() {
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this.onStdinData);
    readline.emitKeypressEvents(process.stdin);
  }

  private stdinStop() {
    try {
      process.stdin.off('data', this.onStdinData);
      process.stdin.setRawMode?.(false);
    } catch {}
  }

  private onStdinData = (chunk: string) => {
    for (const ch of chunk) {
      if (ch === '\u0003') {
        this.stop();
        process.exit(0);
        return;
      }

      if (ch === '\u0002') {
        if (this.mode === 'audio') {
          this.mode = 'text';
          this.updateTextOutput({ enable: true, stdoutEnable: true });
          this.updateMicrophone(false);
          this.updateSpeaker(false);
          process.stdout.write('\nSwitched to Text Input Mode.');
        } else {
          this.mode = 'audio';
          this.updateTextOutput({ enable: true, stdoutEnable: false });
          this.updateMicrophone(true);
          this.updateSpeaker(true);
          this.textBuf = [];
          process.stdout.write('\nSwitched to Audio Input Mode.');
        }
        continue;
      }

      if (this.mode === 'text') {
        if (ch === '\r' || ch === '\n') {
          const text = this.textBuf.join('');
          if (text) {
            this.textBuf = [];
            try {
              this.session.interrupt();
            } catch {}
            this.session.generateReply({ userInput: text });
            process.stdout.write('\n');
          }
        } else if (ch === '\u007f') {
          if (this.textBuf.length) {
            this.textBuf.pop();
            process.stdout.write('\b \b');
          }
        } else if (isPrintable(ch)) {
          this.textBuf.push(ch);
          process.stdout.write(ch);
        }
      }
    }
  };

  private updateMicrophone(enable: boolean) {
    if (enable) {
      this.session.input.audio = this.inputAudio;
      if (this.micCheckTimer) clearTimeout(this.micCheckTimer);
      this.micCheckTimer = setTimeout(() => this.checkMicReceivedAudio(), 5000);
    } else {
      this.session.input.audio = null;
    }
  }

  private updateSpeaker(enable: boolean) {
    if (enable) {
      this.session.output.audio = this.transcriptSyncer ? this.transcriptSyncer.audioOutput : this.audioSink;
    } else {
      this.session.output.audio = null;
    }
  }

  private updateTextOutput({ enable, stdoutEnable }: { enable: boolean; stdoutEnable: boolean }) {
    if (enable) {
      this.session.output.transcription = this.transcriptSyncer ? this.transcriptSyncer.textOutput : this.textSink;
      this.textSink.setEnabled(stdoutEnable);
    } else {
      this.session.output.transcription = null;
      this.textBuf = [];
    }
  }

  private checkMicReceivedAudio() {
    if (!this.inputAudio.receivedAudio) {
      this.logger.error('No audio input detected. Check microphone permissions.');
    }
  }

  private printAudioMode() {
    const amplitude = clampNormalizeDb(this.inputAudio.microDb, INPUT_DB_MIN, INPUT_DB_MAX);
    const nbBar = Math.round(amplitude * MAX_AUDIO_BAR);
    const colorCode = amplitude > 0.75 ? 31 : amplitude > 0.5 ? 33 : 32;
    const bar = '#'.repeat(nbBar) + '-'.repeat(MAX_AUDIO_BAR - nbBar);
    this.currentAudioLine = `[Audio] ${this.micName.slice(-20)} [${this.inputAudio.microDb.toFixed(2)} dBFS] ${esc(colorCode)}[${bar}]${esc(0)}`;
    process.stdout.write(`\r${this.currentAudioLine}`);
  }

  private printTextMode() {
    process.stdout.write('\r');
    const prompt = 'Enter your message: ';
    process.stdout.write(`[Text ${prompt}${this.textBuf.join('')}`);
  }
}

function isPrintable(ch: string) {
  if (ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return code >= 32 && code !== 127;
}
