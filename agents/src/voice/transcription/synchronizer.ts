import type { AudioFrame } from '@livekit/rtc-node';
import type { SentenceStream, SentenceTokenizer } from '../../tokenize/index.js';
import { basic } from '../../tokenize/index.js';
import { AudioOutput, TextOutput } from '../io.js';
import { Future, Task } from '../../utils.js';
import { log } from '../../log.js';
import { hrtime } from 'node:process';


interface TextSyncOptions {
  speed: number;
  hyphenateWord: (word: string) => string[];
  splitWords: (words: string) => [string, number, number][];
  sentenceTokenizer: SentenceTokenizer;
  speakingRateDetector: SpeakingRateDetector;
}


// class SpeakingRateData {
//     timestamps: number[] = [];
//     speakingRate: number[] = [];
//     speakIntegrals: number[] = [];
//     private textBuffer: string[] = [];

//     constructor() {}

//     addByRate(timestamp: number, speakingRate: number) {
//         const integral = this.speakIntegrals.at(-1) ?? 0;
//         this.speakIntegrals.push(integral + speakingRate * dt);
//         this.timestamps.push(timestamp);
//         this.speakingRate.push(speakingRate);
//     }

//     get pushedDuration() {
//         return this.timestamps.at(-1) ?? 0;
//     }



// }



interface TextData {
    sentenceStream: SentenceStream;
    pushedText: string;
    done: boolean;
    forwardedHyphens: number;
    forwardedText: string;
}

interface AudioData {
    srStream: SpeakingRateStream;
    pushedDuration: number;
    done: boolean;
    srDataEst: SpeakingRateData;
    srDataAnnotated: SpeakingRateData | null;
}


class SegmentSynchronizerImpl {
    private textData: TextData;
    private audioData: AudioData;

    private startFuture: Future = new Future();
    private closedFuture: Future = new Future();

    private logger = log();


    constructor(public options: TextSyncOptions) {
        this.options = options;
        this.textData = {
            sentenceStream: options.sentenceTokenizer.stream(),
            pushedText: "",
            done: false,
            forwardedHyphens: 0,
            forwardedText: "",
        };
        this.audioData = {
            srStream: options.speakingRateDetector.stream(),
            pushedDuration: 0,
            done: false,
            srDataEst: new SpeakingRateData(),
            srDataAnnotated: null,
        };
    }

    get closed() {
        return this.closedFuture.done;
    }

    get audioInputEnded() {
        return this.audioData.done;
    }


    get textInputEnded() {
        return this.textData.done;
    }

    pushAudio(frame: AudioFrame) {
        if (this.closed) {
            this.logger.warn("SegmentSynchronizerImpl.pushAudio called after close");
            return;
        }
        // TODO(AJS-102): use frame.durationMs once available in rtc-node
        const framDuration = (frame.samplesPerChannel / frame.sampleRate);
        if (!this.startWallTime && framDuration > 0) {
            this.startWallTime = hrtime.
        }
        
    }

    private async mainTasl(signal: AbortSignal) {
        await this.startFuture.await;

        if 
    }




    
}


class SyncedAudioOutput extends AudioOutput {
    private capturing: boolean = false;
    private pushedDuration: number = 0.0;
  
    constructor(public synchronizer: TranscriptionSynchronizer) {
      super();
    }
  
    async captureFrame(frame: AudioFrame): Promise<void> {
      await this.synchronizer.barrier();
  
      this.capturing = true;
      await super.captureFrame(frame);
  
      // TODO(AJS-102): use frame.durationMs once available in rtc-node
      this.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
  
      if (!this.synchronizer.enabled) {
        return;
      }
  
      if (this.synchronizer._impl.audioInputEnded) {
        this.synchronizer._impl.markPlaybackFinished(playbackPosition: this.pushedDuration, interrupted: false);
      }
    }
  }


  class SyncedTextOutput extends TextOutput {
    constructor(public synchronizer: TranscriptionSynchronizer) {
      super();
    }
  }
  export interface TranscriptionSynchronizerOptions {
    speed: number;
    hyphenateWord: (word: string) => string[];
    splitWords: (words: string) => [string, number, number][];
    sentenceTokenizer: SentenceTokenizer;
  }
  
  export const defaultTextSyncOptions: TranscriptionSynchronizerOptions = {
    speed: 1.0,
    hyphenateWord: basic.hyphenateWord,
    splitWords: basic.splitWords,
    sentenceTokenizer: new basic.SentenceTokenizer(),
  };
  

export class TranscriptionSynchronizer {
  private options: TextSyncOptions;
  private audioOutput: SyncedAudioOutput;
//   private textOutput: SyncedTextOutput;    
  private impl: SegmentSynchronizerImpl;
  private rotateSegmentAtask: Task<void>;

  private _enabled: boolean = true;
  private closed: boolean = false;

  constructor(options: TranscriptionSynchronizerOptions = defaultTextSyncOptions) {

    this._audioOutput = new SyncedAudioOutput(this);


    this.options = {
      speed: options.speed,
      hyphenateWord: options.hyphenateWord,
      splitWords: options.splitWords,
      sentenceTokenizer: options.sentenceTokenizer,
      speakingRateDetector: new SpeakingRateDetector(),
    };

    this.impl = new SegmentSynchronizerImpl(this.options);
    this._rotateSegmentAtask = Task.from((controller) => this.rotate_segment_task(controller.signal))
  }

  private async rotate_segment_task(abort:AbortSignal, oldTask?: Task<void>) {
    if (oldTask) {
        if (abort.aborted) {
            return;
        }
        await oldTask.result;
    }

    if (abort.aborted) {
        return;
    } 
    await this.impl.close();
    this.impl = new _SegmentSynchronizerImpl(this.options);
  }
  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(enabled: boolean) {
    if (this._enabled === enabled) {
      return;
    }

    this._enabled = enabled;
    this.rotateSegment();
  }

  rotateSegment() {
    if (this.closed) {
        return;
    }
  }

  async close() {
    this.closed = true;
    await this.barrier();
    await this.impl.aclose();
  }
}
