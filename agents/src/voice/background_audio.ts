// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
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
  volume?: number;
  probability?: number;
}

export interface BackgroundAudioPlayerOptions {
  /**
   * Ambient sound to play continuously in the background.
   * Can be a file path, BuiltinAudioClip, or AudioConfig.
   * File paths will be looped automatically.
   */
  ambientSound?: AudioSourceType | AudioConfig | AudioConfig[];

  /**
   * Sound to play when the agent is thinking.
   * TODO (Brian): Implement thinking sound when AudioMixer becomes available
   */
  thinkingSound?: AudioSourceType | AudioConfig | AudioConfig[];

  /**
   * Stream timeout in milliseconds
   * @defaultValue 200
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

export class PlayHandle {
  private doneFuture = new Future<void>();
  private stopFuture = new Future<void>();

  done(): boolean {
    return this.doneFuture.done;
  }

  stop(): void {
    if (this.done()) return;

    if (!this.stopFuture.done) {
      this.stopFuture.resolve();
    }

    this._markPlayoutDone();
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
 * - Volume control and probability-based sound selection
 * - Integration with LiveKit rooms and agent sessions
 *
 * Note: Thinking sound not yet supported
 *
 * @example
 * ```typescript
 * const player = new BackgroundAudioPlayer({
 *   ambientSound: { source: BuiltinAudioClip.OFFICE_AMBIENCE, volume: 0.8 },
 * });
 *
 * await player.start({ room, agentSession });
 * ```
 */
export class BackgroundAudioPlayer {
  private ambientSound?: AudioSourceType | AudioConfig | AudioConfig[];
  private thinkingSound?: AudioSourceType | AudioConfig | AudioConfig[];

  private playTasks: Task<void>[] = [];
  private audioSource = new AudioSource(48000, 1, AUDIO_SOURCE_BUFFER_MS);

  private room?: Room;
  private agentSession?: AgentSession;
  private publication?: LocalTrackPublication;
  private trackPublishOptions?: TrackPublishOptions;
  private republishTask?: Task<void>;

  private ambientHandle?: PlayHandle;
  private thinkingHandle?: PlayHandle;

  // TODO (Brian): add lock

  #logger = log();

  constructor(options?: BackgroundAudioPlayerOptions) {
    const { ambientSound, thinkingSound } = options || {};

    this.ambientSound = ambientSound;
    this.thinkingSound = thinkingSound;

    if (this.thinkingSound) {
      this.#logger.warn('thinkingSound is not yet supported');
      // TODO: Implement thinking sound when AudioMixer becomes available
    }
  }

  /**
   * Select a sound from a list of background sound based on probability weights
   * Return undefined if no sound is selected (when sum of probabilities < 1.0).
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
  ): { source: AudioSourceType; volume: number } | undefined {
    if (source === undefined) {
      return undefined;
    }

    if (typeof source === 'string') {
      return {
        source: this.normalizeBuiltinAudio(source),
        volume: 1.0,
      };
    }

    if (Array.isArray(source)) {
      const selected = this.selectSoundFromList(source);
      if (selected === undefined) {
        return undefined;
      }

      return {
        source: selected.source,
        volume: selected.volume ?? 1.0,
      };
    }

    if (typeof source === 'object' && 'source' in source) {
      return {
        source: this.normalizeBuiltinAudio(source.source),
        volume: source.volume ?? 1.0,
      };
    }

    return { source, volume: 1.0 };
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

    const { source, volume } = normalized;
    const playHandle = new PlayHandle();

    const task = Task.from(async ({ signal }) => {
      await this.playTask({ playHandle, sound: source, volume, loop, signal });
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

    await this.publishTrack();

    // TODO (Brian): check job context is not fake

    // TODO (Brian): start audio mixer task
    this.room.on('reconnected', this.onReconnected);

    this.agentSession?.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);

    if (!this.ambientSound) return;

    const normalized = this.normalizeSoundSource(this.ambientSound);
    if (!normalized) return;

    const { source, volume } = normalized;
    const selectedSound: AudioConfig = { source, volume, probability: 1.0 };
    this.ambientHandle = this.play(selectedSound, typeof source === 'string');
  }

  /**
   * Close and cleanup the background audio system
   */
  async close(): Promise<void> {
    await cancelAndWait(this.playTasks, TASK_TIMEOUT_MS);

    if (this.republishTask) {
      await this.republishTask.cancelAndWait(TASK_TIMEOUT_MS);
    }

    // TODO (Brian): cancel audio mixer task and close audio mixer

    await this.audioSource.close();

    this.agentSession?.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    this.room?.off('reconnected', this.onReconnected);

    if (this.publication && this.publication.sid) {
      await this.room?.localParticipant?.unpublishTrack(this.publication.sid);
    }
  }

  /**
   * Get the current track publication
   */
  getPublication(): LocalTrackPublication | undefined {
    return this.publication;
  }

  private async publishTrack(): Promise<void> {
    if (this.publication !== undefined) {
      return;
    }

    const track = LocalAudioTrack.createAudioTrack('background_audio', this.audioSource);

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

  private onReconnected = (): void => {
    if (this.republishTask) {
      this.republishTask.cancel();
    }

    this.publication = undefined;
    this.republishTask = Task.from(async () => {
      await this.republishTrackTask();
    });
  };

  private async republishTrackTask(): Promise<void> {
    // TODO (Brian): add lock protection when implementing lock
    await this.publishTrack();
  }

  private onAgentStateChanged = (ev: AgentStateChangedEvent): void => {
    if (!this.thinkingSound) {
      return;
    }

    if (ev.newState === 'thinking') {
      if (this.thinkingHandle && !this.thinkingHandle.done()) {
        return;
      }

      // TODO (Brian): play thinking sound and assign to thinkingHandle
    } else {
      this.thinkingHandle?.stop();
    }
  };

  private async playTask({
    playHandle,
    sound,
    volume,
    loop,
    signal,
  }: {
    playHandle: PlayHandle;
    sound: AudioSourceType;
    volume: number;
    loop: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    if (isBuiltinAudioClip(sound)) {
      sound = getBuiltinAudioPath(sound);
    }

    if (typeof sound === 'string') {
      sound = loop
        ? loopAudioFramesFromFile(sound, { abortSignal: signal })
        : audioFramesFromFile(sound, { abortSignal: signal });
    }

    try {
      for await (const frame of sound) {
        if (signal.aborted || playHandle.done()) break;

        let processedFrame: AudioFrame;

        if (volume !== 1.0) {
          const int16Data = new Int16Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength / 2,
          );
          const float32Data = new Float32Array(int16Data.length);

          for (let i = 0; i < int16Data.length; i++) {
            float32Data[i] = int16Data[i]!;
          }

          const volumeFactor = 10 ** Math.log10(volume);
          for (let i = 0; i < float32Data.length; i++) {
            float32Data[i]! *= volumeFactor;
          }

          const outputData = new Int16Array(float32Data.length);
          for (let i = 0; i < float32Data.length; i++) {
            const clipped = Math.max(-32768, Math.min(32767, float32Data[i]!));
            outputData[i] = Math.round(clipped);
          }

          processedFrame = new AudioFrame(
            outputData,
            frame.sampleRate,
            frame.channels,
            frame.samplesPerChannel,
          );
        } else {
          processedFrame = frame;
        }

        // TODO (Brian): use AudioMixer to add/remove frame streams
        await this.audioSource.captureFrame(processedFrame);
      }
    } finally {
      // TODO: the waitForPlayout() may be innaccurate by 400ms
      playHandle._markPlayoutDone();
    }
  }
}
