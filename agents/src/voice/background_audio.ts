// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
  AudioMixer,
  AudioSource,
  LocalAudioTrack,
  type LocalTrackPublication,
  type Room,
  TrackPublishOptions,
} from '@livekit/rtc-node';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioFramesFromFile, loopAudioFramesFromFile } from '../audio.js';
import { log } from '../log.js';
import { Future, Task, cancelAndWait } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type AgentStateChangedEvent } from './events.js';

const TASK_TIMEOUT_MS = 500;

export enum BuiltinAudioClip {
  OFFICE_AMBIENCE = 'office-ambience.ogg',
  KEYBOARD_TYPING = 'keyboard-typing.ogg',
  KEYBOARD_TYPING2 = 'keyboard-typing2.ogg',
}

export function isBuiltinAudioClip(
  source: AudioSourceType | AudioConfig | AudioConfig[],
): source is BuiltinAudioClip {
  return (
    typeof source === 'string' &&
    Object.values(BuiltinAudioClip).includes(source as BuiltinAudioClip)
  );
}

export function getBuiltinAudioPath(clip: BuiltinAudioClip): string {
  const resourcesPath = join(dirname(fileURLToPath(import.meta.url)), '../../resources');
  return join(resourcesPath, clip);
}

export type AudioSourceType = string | BuiltinAudioClip | AsyncIterable<AudioFrame>;

export interface AudioConfig {
  source: AudioSourceType;
  /**
   * Volume scalar applied to the audio (0.0-1.0).
   */
  volume?: number;
  /**
   * Probability that this audio is selected when multiple configs are provided (0.0-1.0).
   */
  probability?: number;
  /**
   * Duration in milliseconds to ramp volume from 0 up to `volume` when playback starts.
   */
  fadeIn?: number;
  /**
   * Duration in milliseconds to ramp volume back down to 0 when `PlayHandle.stop()` is called.
   */
  fadeOut?: number;
}

type NormalizedAudioConfig = {
  source: AudioSourceType;
  volume: number;
  fadeIn: number;
  fadeOut: number;
};

export interface BackgroundAudioPlayerOptions {
  /**
   * Ambient sound to play continuously in the background.
   * Can be a file path, BuiltinAudioClip, or AudioConfig.
   * File paths will be looped automatically.
   */
  ambientSound?: AudioSourceType | AudioConfig | AudioConfig[];

  /**
   * Sound to play when the agent is thinking.
   * Plays when agent state changes to 'thinking' and stops when it changes to other states.
   */
  thinkingSound?: AudioSourceType | AudioConfig | AudioConfig[];

  /**
   * Stream timeout in milliseconds for the audio mixer.
   * Controls how long the mixer waits for a stream to produce data before timing out.
   * Higher values are more tolerant of network latency and processing delays.
   * @defaultValue 2000
   */
  streamTimeoutMs?: number;
}

export interface BackgroundAudioStartOptions {
  room: Room;
  agentSession?: AgentSession;
  trackPublishOptions?: TrackPublishOptions;
}

// Queue size for AudioSource buffer (400ms)
// Kept small to avoid abrupt cutoffs when removing sounds
const AUDIO_SOURCE_BUFFER_MS = 400;
const STREAM_TIMEOUT_MS = 2000;
const BACKGROUND_AUDIO_TRACK_NAME = 'background_audio';

export class PlayHandle {
  private doneFuture = new Future<void>();
  private stopFuture = new Future<void>();

  constructor(private fadeOut = 0) {}

  done(): boolean {
    return this.doneFuture.done;
  }

  stop(): void {
    if (this.done()) return;

    if (!this.stopFuture.done) {
      this.stopFuture.resolve();
    }

    if (this.fadeOut <= 0) {
      this._markPlayoutDone();
    }
  }

  _stopRequested(): boolean {
    return this.stopFuture.done;
  }

  async waitForPlayout(): Promise<void> {
    return this.doneFuture.await;
  }

  _markPlayoutDone(): void {
    if (!this.doneFuture.done) {
      this.doneFuture.resolve();
    }
  }
}

/**
 * Manages background audio playback for LiveKit agent sessions
 *
 * This class handles playing ambient sounds and manages audio track publishing.
 * It supports:
 * - Continuous ambient sound playback with looping
 * - Thinking sound playback during agent processing
 * - Multiple simultaneous audio streams via AudioMixer
 * - Volume control and probability-based sound selection
 * - Integration with LiveKit rooms and agent sessions
 *
 * @example
 * ```typescript
 * const player = new BackgroundAudioPlayer({
 *   ambientSound: { source: BuiltinAudioClip.OFFICE_AMBIENCE, volume: 0.8 },
 *   thinkingSound: { source: BuiltinAudioClip.KEYBOARD_TYPING, volume: 0.6 },
 * });
 *
 * await player.start({ room, agentSession });
 * ```
 */
export class BackgroundAudioPlayer {
  private ambientSound?: AudioSourceType | AudioConfig | AudioConfig[];
  private thinkingSound?: AudioSourceType | AudioConfig | AudioConfig[];
  private streamTimeoutMs: number;

  private playTasks: Task<void>[] = [];
  private audioSource = new AudioSource(48000, 1, AUDIO_SOURCE_BUFFER_MS);
  private audioMixer: AudioMixer;
  private mixerTask?: Task<void>;

  private room?: Room;
  private agentSession?: AgentSession;
  private publication?: LocalTrackPublication;
  private trackPublishOptions?: TrackPublishOptions;

  private ambientHandle?: PlayHandle;
  private thinkingHandle?: PlayHandle;

  private closed = true;

  // TODO (Brian): add lock

  #logger = log();

  constructor(options?: BackgroundAudioPlayerOptions) {
    const { ambientSound, thinkingSound, streamTimeoutMs = STREAM_TIMEOUT_MS } = options || {};

    this.ambientSound = ambientSound;
    this.thinkingSound = thinkingSound;
    this.streamTimeoutMs = streamTimeoutMs;

    this.audioMixer = new AudioMixer(48000, 1, {
      blocksize: 4800, // 100ms at 48kHz
      capacity: 1,
      streamTimeoutMs: this.streamTimeoutMs,
    });
  }

  /**
   * Select a sound from a list of background sound based on probability weights
   * Return undefined if no sound is selected (when sum of probabilities is below 1.0).
   */
  private selectSoundFromList(sounds: AudioConfig[]): AudioConfig | undefined {
    const totalProbability = sounds.reduce((sum, sound) => sum + (sound.probability ?? 1.0), 0);

    if (totalProbability <= 0) {
      return undefined;
    }

    if (totalProbability < 1.0 && Math.random() > totalProbability) {
      return undefined;
    }

    const normalizeFactor = totalProbability <= 1.0 ? 1.0 : totalProbability;
    const r = Math.random() * Math.min(totalProbability, 1.0);
    let cumulative = 0.0;

    for (const sound of sounds) {
      const prob = sound.probability ?? 1.0;
      if (prob <= 0) {
        continue;
      }

      const normProb = prob / normalizeFactor;
      cumulative += normProb;

      if (r <= cumulative) {
        return sound;
      }
    }

    return sounds[sounds.length - 1];
  }

  private normalizeSoundSource(
    source?: AudioSourceType | AudioConfig | AudioConfig[],
  ): NormalizedAudioConfig | undefined {
    if (source === undefined) {
      return undefined;
    }

    if (typeof source === 'string') {
      return {
        source: this.normalizeBuiltinAudio(source),
        volume: 1.0,
        fadeIn: 0,
        fadeOut: 0,
      };
    }

    if (Array.isArray(source)) {
      const selected = this.selectSoundFromList(source);
      if (selected === undefined) {
        return undefined;
      }

      return {
        source: this.normalizeBuiltinAudio(selected.source),
        volume: selected.volume ?? 1.0,
        fadeIn: selected.fadeIn ?? 0,
        fadeOut: selected.fadeOut ?? 0,
      };
    }

    if (typeof source === 'object' && 'source' in source) {
      return {
        source: this.normalizeBuiltinAudio(source.source),
        volume: source.volume ?? 1.0,
        fadeIn: source.fadeIn ?? 0,
        fadeOut: source.fadeOut ?? 0,
      };
    }

    return { source, volume: 1.0, fadeIn: 0, fadeOut: 0 };
  }

  private normalizeBuiltinAudio(source: AudioSourceType): AudioSourceType {
    if (isBuiltinAudioClip(source)) {
      return getBuiltinAudioPath(source);
    }
    return source;
  }

  play(audio: AudioSourceType | AudioConfig | AudioConfig[], loop = false): PlayHandle {
    const normalized = this.normalizeSoundSource(audio);
    if (normalized === undefined) {
      const handle = new PlayHandle();
      handle._markPlayoutDone();
      return handle;
    }

    const { source, volume, fadeIn, fadeOut } = normalized;
    const playHandle = new PlayHandle(fadeOut);

    const task = Task.from(async ({ signal }) => {
      await this.playTask({ playHandle, sound: source, volume, fadeIn, fadeOut, loop, signal });
    });

    task.addDoneCallback(() => {
      playHandle._markPlayoutDone();
      this.playTasks.splice(this.playTasks.indexOf(task), 1);
    });

    this.playTasks.push(task);
    return playHandle;
  }

  /**
   * Start the background audio system, publishing the audio track
   * and beginning playback of any configured ambient sound.
   *
   * If `ambientSound` is provided (and contains file paths), they will loop
   * automatically. If `ambientSound` contains AsyncIterators, they are assumed
   * to be already infinite or looped.
   *
   * @param options - Options for starting background audio playback
   */
  async start(options: BackgroundAudioStartOptions): Promise<void> {
    const { room, agentSession, trackPublishOptions } = options;
    this.room = room;
    this.agentSession = agentSession;
    this.trackPublishOptions = trackPublishOptions;

    this.closed = false;

    await this.publishTrack();

    // TODO (Brian): check job context is not fake

    this.mixerTask = Task.from(async () => {
      try {
        await this.runMixerTask();
      } catch (err) {
        if (this.closed) return; // expected when AudioSource is closed
        throw err;
      }
    });

    this.agentSession?.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    if (!this.ambientSound) return;

    const normalized = this.normalizeSoundSource(this.ambientSound);
    if (!normalized) return;

    const { source, volume, fadeIn, fadeOut } = normalized;
    const selectedSound: AudioConfig = { source, volume, probability: 1.0, fadeIn, fadeOut };
    this.ambientHandle = this.play(selectedSound, typeof source === 'string');
  }

  /**
   * Close and cleanup the background audio system
   */
  async close(): Promise<void> {
    this.closed = true;

    await cancelAndWait(this.playTasks, TASK_TIMEOUT_MS);

    await this.audioMixer.aclose();
    await this.audioSource.close();

    if (this.mixerTask) {
      await this.mixerTask.cancelAndWait(TASK_TIMEOUT_MS);
    }

    this.agentSession?.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);

    // The cached publication SID may be stale if the SDK auto-republished it
    // during a full reconnect, so resolve the current publication by track
    // name before unpublishing.
    const current = this.findCurrentPublication();
    if (current && current.sid) {
      await this.room?.localParticipant?.unpublishTrack(current.sid);
    }
  }

  private findCurrentPublication(): LocalTrackPublication | undefined {
    const pubs = this.room?.localParticipant?.trackPublications;
    if (!pubs) return undefined;
    for (const pub of pubs.values()) {
      if (pub.name === BACKGROUND_AUDIO_TRACK_NAME) return pub;
    }
    return undefined;
  }

  /**
   * Get the current track publication
   */
  getPublication(): LocalTrackPublication | undefined {
    return this.findCurrentPublication() ?? this.publication;
  }

  private async publishTrack(): Promise<void> {
    if (this.publication !== undefined) {
      return;
    }

    const track = LocalAudioTrack.createAudioTrack(BACKGROUND_AUDIO_TRACK_NAME, this.audioSource);

    if (this.room?.localParticipant === undefined) {
      throw new Error('Local participant not available');
    }

    const publication = await this.room.localParticipant.publishTrack(
      track,
      this.trackPublishOptions ?? new TrackPublishOptions(),
    );

    this.publication = publication;
    this.#logger.debug(`Background audio track published: ${this.publication.sid}`);
  }

  private async runMixerTask(): Promise<void> {
    for await (const frame of this.audioMixer) {
      await this.audioSource.captureFrame(frame);
    }
  }

  private onAgentStateChanged = (ev: AgentStateChangedEvent): void => {
    if (!this.thinkingSound) {
      return;
    }

    if (ev.newState === 'thinking') {
      if (this.thinkingHandle && !this.thinkingHandle.done()) {
        return;
      }

      const normalized = this.normalizeSoundSource(this.thinkingSound);
      if (normalized) {
        const { source, volume, fadeIn, fadeOut } = normalized;
        const selectedSound: AudioConfig = { source, volume, probability: 1.0, fadeIn, fadeOut };
        // Loop thinking sound while in thinking state (same as ambient)
        this.thinkingHandle = this.play(selectedSound, typeof source === 'string');
      }
    } else {
      this.thinkingHandle?.stop();
    }
  };

  private frameGain({
    t,
    n,
    stopT,
    fadeIn,
    fadeOut,
    sampleRate,
    volume,
  }: {
    t: number;
    n: number;
    stopT?: number;
    fadeIn: number;
    fadeOut: number;
    sampleRate: number;
    volume: number;
  }): Float32Array | undefined {
    const fadeInSamples = fadeIn > 0 ? Math.trunc((fadeIn / 1000) * sampleRate) : 0;
    const fadeOutSamples = fadeOut > 0 ? Math.trunc((fadeOut / 1000) * sampleRate) : 0;
    const needsFadeIn = fadeInSamples > 0 && t < fadeInSamples;
    const needsFadeOut = fadeOutSamples > 0 && stopT !== undefined;

    if (!needsFadeIn && !needsFadeOut && volume === 1.0) {
      return undefined;
    }

    const gain = new Float32Array(n).fill(volume);
    for (let i = 0; i < n; i++) {
      const idx = t + i;

      if (needsFadeIn) {
        const phase = Math.max(0, Math.min(1, idx / fadeInSamples));
        gain[i]! *= Math.sin(phase * (Math.PI / 2));
      }

      if (stopT !== undefined && fadeOutSamples > 0) {
        const phase = Math.max(0, Math.min(1, (idx - stopT) / fadeOutSamples));
        gain[i]! *= Math.cos(phase * (Math.PI / 2));
      }
    }

    return gain;
  }

  // Note: Python uses numpy, TS uses typed arrays for equivalent logic.
  private applyGainToFrame(frame: AudioFrame, gain?: Float32Array): AudioFrame {
    if (gain === undefined) {
      return frame;
    }

    const int16Data = new Int16Array(
      frame.data.buffer,
      frame.data.byteOffset,
      frame.data.byteLength / 2,
    );
    const outputData = new Int16Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      const clipped = Math.max(
        -32768,
        Math.min(32767, int16Data[i]! * gain[Math.floor(i / frame.channels)]!),
      );
      outputData[i] = Math.round(clipped);
    }

    return new AudioFrame(outputData, frame.sampleRate, frame.channels, frame.samplesPerChannel);
  }

  private async playTask({
    playHandle,
    sound,
    volume,
    fadeIn,
    fadeOut,
    loop,
    signal,
  }: {
    playHandle: PlayHandle;
    sound: AudioSourceType;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    loop: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    if (isBuiltinAudioClip(sound)) {
      sound = getBuiltinAudioPath(sound);
    }

    let audioStream: AsyncIterable<AudioFrame>;
    if (typeof sound === 'string') {
      audioStream = loop
        ? loopAudioFramesFromFile(sound, { abortSignal: signal })
        : audioFramesFromFile(sound, { abortSignal: signal });
    } else {
      audioStream = sound;
    }

    const frameGain = this.frameGain.bind(this);
    const applyGain = this.applyGainToFrame.bind(this);
    async function* genWrapper(): AsyncGenerator<AudioFrame> {
      let t = 0;
      let stopT: number | undefined;

      for await (const frame of audioStream) {
        if (signal.aborted || (fadeOut <= 0 && playHandle.done())) break;
        if (stopT === undefined && fadeOut > 0 && playHandle._stopRequested()) {
          stopT = t;
        }

        const n = frame.samplesPerChannel;
        const gain = frameGain({
          t,
          n,
          stopT,
          fadeIn,
          fadeOut,
          sampleRate: frame.sampleRate,
          volume,
        });
        yield applyGain(frame, gain);

        t += n;
        if (stopT !== undefined && t - stopT >= Math.trunc((fadeOut / 1000) * frame.sampleRate)) {
          break;
        }
      }
      playHandle._markPlayoutDone();
    }

    const gen = genWrapper();
    try {
      this.audioMixer.addStream(gen);
      await playHandle.waitForPlayout();
    } finally {
      this.audioMixer.removeStream(gen);
      playHandle._markPlayoutDone();

      if (playHandle.done()) {
        await gen.return(undefined);
      }
    }
  }
}
