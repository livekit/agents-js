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
import { assert } from 'node:console';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioFramesFromFile, loopAudioFramesFromFile } from '../audio.js';
import { log } from '../log.js';
import { Task } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type AgentStateChangedEvent } from './events.js';

/**
 * Built-in audio clips bundled with the agents package
 */
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

/**
 * Get the file path for a built-in audio clip
 */
export function getBuiltinAudioPath(clip: BuiltinAudioClip): string {
  const resourcesPath = join(dirname(fileURLToPath(import.meta.url)), '../../resources');
  return join(resourcesPath, clip);
}

/**
 * Audio source types supported by BackgroundAudioPlayer
 */
export type AudioSourceType = string | BuiltinAudioClip | AsyncIterable<AudioFrame>;

/**
 * Configuration for background audio playback
 */
export interface AudioConfig {
  source: AudioSourceType;
  volume?: number;
  probability?: number;
}

/**
 * Options for initializing BackgroundAudioPlayer
 */
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

/**
 * Options for starting background audio playback
 */
export interface BackgroundAudioStartOptions {
  room: Room;
  agentSession?: AgentSession;
  trackPublishOptions?: TrackPublishOptions;
}

// Queue size for AudioSource buffer (400ms)
// Kept small to avoid abrupt cutoffs when removing sounds
const AUDIO_SOURCE_BUFFER_MS = 400;

/**
 * Handle for controlling audio playback
 */
export class PlayHandle {
  private doneFuture: Promise<void>;
  private doneResolve!: () => void;
  private stopFuture: Promise<void>;
  private stopResolve!: () => void;
  private stopped = false;

  constructor() {
    this.doneFuture = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });
    this.stopFuture = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  /**
   * Returns true if the sound has finished playing
   */
  done(): boolean {
    return this.stopped;
  }

  /**
   * Stop the sound from playing
   */
  stop(): void {
    if (this.done()) {
      return;
    }

    this.stopped = true;
    this.stopResolve();
    this._markPlayoutDone();
  }

  /**
   * Wait for the sound to finish playing
   */
  async waitForPlayout(): Promise<void> {
    return this.doneFuture;
  }

  /** @internal */
  _markPlayoutDone(): void {
    this.stopped = true;
    this.doneResolve();
  }

  /** @internal */
  _getStopPromise(): Promise<void> {
    return this.stopFuture;
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
   * Select a sound from a list based on probability weights
   */
  private selectSoundFromList(sounds: AudioConfig[]): AudioConfig | null {
    const totalProbability = sounds.reduce((sum, s) => sum + (s.probability ?? 1.0), 0);

    if (totalProbability <= 0) {
      return null;
    }

    if (totalProbability < 1.0 && Math.random() > totalProbability) {
      return null;
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

    return sounds[sounds.length - 1] ?? null;
  }

  /**
   * Normalize sound source to a consistent format
   */
  private normalizeSoundSource(
    source?: AudioSourceType | AudioConfig | AudioConfig[],
  ): { source: AudioSourceType; volume: number } | undefined {
    if (source === undefined) {
      return undefined;
    }

    if (isBuiltinAudioClip(source)) {
      return { source, volume: 1.0 };
    }

    // Check if it's a BuiltinAudioClip enum value
    const builtinClips = Object.values(BuiltinAudioClip) as string[];
    if (typeof source === 'string' && builtinClips.includes(source)) {
      return { source: source as BuiltinAudioClip, volume: 1.0 };
    }

    if (Array.isArray(source)) {
      const selected = this.selectSoundFromList(source as AudioConfig[]);
      if (selected === null) {
        return null;
      }
      return { source: selected.source, volume: selected.volume ?? 1.0 };
    }

    // It's an AudioConfig
    const config = source as AudioConfig;
    return { source: config.source, volume: config.volume ?? 1.0 };
  }

  /**
   * Get the file path for an audio source
   */
  private getAudioPath(source: AudioSourceType): string | null {
    if (typeof source === 'string') {
      // Check if it's a BuiltinAudioClip value
      const builtinClips = Object.values(BuiltinAudioClip) as string[];
      if (builtinClips.includes(source)) {
        return getBuiltinAudioPath(source as BuiltinAudioClip);
      }
      return source;
    }

    return null;
  }

  /**
   * Play an audio file once or in a loop
   */
  play(audio: AudioSourceType | AudioConfig | AudioConfig[], loop = false): PlayHandle {
    if (!this.audioSource) {
      throw new Error('BackgroundAudioPlayer not started');
    }

    const normalized = this.normalizeSoundSource(audio);
    if (normalized === null) {
      const handle = new PlayHandle();
      handle._markPlayoutDone();
      return handle;
    }

    const { source, volume } = normalized;

    // TODO: Support AsyncIterable sources when AudioMixer is available
    const filePath = this.getAudioPath(source);
    if (!filePath) {
      throw new Error(
        'AsyncIterable audio sources require AudioMixer - not yet supported. Use file path or BuiltinAudioClip.',
      );
    }

    const playHandle = new PlayHandle();
    const controller = new AbortController();

    const task = new Task<void>(
      async (ctrl) => {
        try {
          await this.playTask(playHandle, filePath, volume, loop, ctrl.signal);
        } finally {
          const index = this.playTasks.indexOf(task);
          if (index > -1) {
            this.playTasks.splice(index, 1);
          }
          playHandle._markPlayoutDone();
        }
      },
      controller,
      `play-${filePath}`,
    );

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

    if (this.agentSession) {
      this.agentSession.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    }

    if (this.ambientSound) {
      const normalized = this.normalizeSoundSource(this.ambientSound);
      if (normalized) {
        const { volume } = normalized;
        const filePath = this.getAudioPath(normalized.source);
        if (filePath) {
          const audioConfig: AudioConfig = { source: normalized.source, volume };
          this.ambientHandle = this.play(audioConfig, true);
        } else {
          this.#logger.warn('Ambient sound source must be a file path or BuiltinAudioClip');
        }
      }
    }
  }

  /**
   * Close and cleanup the background audio system
   */
  async close(): Promise<void> {
    if (!this.audioSource) {
      return; // Not started
    }

    // Cancel all play tasks
    await Promise.all(this.playTasks.map((task) => task.cancel()));
    this.playTasks = [];

    // Cancel republish task if running
    if (this.republishTask) {
      await this.republishTask.cancel();
    }

    // Close audio source
    await this.audioSource.close();

    // Remove event listeners
    if (this.agentSession) {
      this.agentSession.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    }

    this.room?.off('reconnected', this.onReconnected);

    // Unpublish track
    if (this.publication) {
      try {
        const sid = this.publication.sid;
        if (sid && this.room?.localParticipant) {
          await this.room.localParticipant.unpublishTrack(sid);
        }
      } catch (error) {
        // Ignore errors during unpublish
      }
    }

    this.publication = undefined;
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
    this.#logger.info('Room reconnected, republishing background audio track');

    // Cancel any existing republish task
    if (this.republishTask) {
      this.republishTask.cancel();
    }

    this.publication = undefined;

    // Start new republish task
    this.republishTask = Task.from(async () => {
      await this.republishTrackTask();
    });
  };

  private async republishTrackTask(): Promise<void> {
    // TODO (Brian): add lock protection when implementing lock
    try {
      await this.publishTrack();
    } catch (error) {
      this.#logger.error('Failed to republish track', error);
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

      assert(this.thinkingSound !== undefined, 'thinkingSound is not set');

      // TODO (Brian): play thinking sound and assign to thinkingHandle
    } else if (this.thinkingHandle) {
      this.thinkingHandle.stop();
    }
  };

  private async playTask(
    playHandle: PlayHandle,
    filePath: string,
    volume: number,
    loop: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.audioSource) {
      throw new Error('AudioSource not initialized');
    }

    // Stop playback if handle is stopped
    playHandle._getStopPromise().then(() => {
      // Signal is already provided by Task
    });

    try {
      if (loop) {
        // Infinite loop
        for await (const frame of loopAudioFramesFromFile(filePath, {
          sampleRate: 48000,
          numChannels: 1,
          abortSignal: signal,
        })) {
          if (signal.aborted) {
            break;
          }

          // Apply volume if needed
          const adjustedFrame = volume !== 1.0 ? this.applyVolume(frame, volume) : frame;
          await this.audioSource.captureFrame(adjustedFrame);
        }
      } else {
        // Play once
        const stream = audioFramesFromFile(filePath, {
          sampleRate: 48000,
          numChannels: 1,
          abortSignal: signal,
        });

        for await (const frame of stream) {
          if (signal.aborted) {
            break;
          }

          const adjustedFrame = volume !== 1.0 ? this.applyVolume(frame, volume) : frame;
          await this.audioSource.captureFrame(adjustedFrame);
        }
      }
    } catch (error) {
      this.#logger.error('Error playing audio', error);
    } finally {
      playHandle._markPlayoutDone();
    }
  }

  private applyVolume(frame: AudioFrame, volume: number): AudioFrame {
    // Apply volume using logarithmic scale (matching Python)
    const data = new Int16Array(frame.data.length);
    frame.data.forEach((sample, i) => {
      const factor = 10 ** Math.log10(volume);
      data[i] = Math.max(-32768, Math.min(32767, Math.round(sample * factor)));
    });

    return new AudioFrame(data, frame.sampleRate, frame.channels, frame.samplesPerChannel);
  }
}
