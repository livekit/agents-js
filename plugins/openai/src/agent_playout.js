import { EventEmitter } from 'events';
import { AudioByteStream } from '../../../agents/src/audio.js';
import { NUM_CHANNELS, OUTPUT_PCM_FRAME_SIZE, SAMPLE_RATE } from './realtime/api_proto.js';

var __classPrivateFieldSet =
  (this && this.__classPrivateFieldSet) ||
  function (receiver, state, value, kind, f) {
    if (kind === 'm') throw new TypeError('Private method is not writable');
    if (kind === 'a' && !f) throw new TypeError('Private accessor was defined without a setter');
    if (typeof state === 'function' ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        'Cannot write private member to an object whose class did not declare it',
      );
    return (
      kind === 'a' ? f.call(receiver, value) : f ? (f.value = value) : state.set(receiver, value),
      value
    );
  };
var __classPrivateFieldGet =
  (this && this.__classPrivateFieldGet) ||
  function (receiver, state, kind, f) {
    if (kind === 'a' && !f) throw new TypeError('Private accessor was defined without a getter');
    if (typeof state === 'function' ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        'Cannot read private member from an object whose class did not declare it',
      );
    return kind === 'm' ? f : kind === 'a' ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
var _AgentPlayout_audioSource, _AgentPlayout_currentPlayoutHandle, _AgentPlayout_currentPlayoutTask;

export class AgentPlayout {
  constructor(audioSource) {
    _AgentPlayout_audioSource.set(this, void 0);
    _AgentPlayout_currentPlayoutHandle.set(this, void 0);
    _AgentPlayout_currentPlayoutTask.set(this, void 0);
    __classPrivateFieldSet(this, _AgentPlayout_audioSource, audioSource, 'f');
    __classPrivateFieldSet(this, _AgentPlayout_currentPlayoutHandle, null, 'f');
    __classPrivateFieldSet(this, _AgentPlayout_currentPlayoutTask, null, 'f');
  }
  play(messageId, transcriptionFwd, playoutQueue) {
    if (__classPrivateFieldGet(this, _AgentPlayout_currentPlayoutHandle, 'f')) {
      __classPrivateFieldGet(this, _AgentPlayout_currentPlayoutHandle, 'f').interrupt();
    }
    __classPrivateFieldSet(
      this,
      _AgentPlayout_currentPlayoutHandle,
      new PlayoutHandle(messageId, transcriptionFwd, playoutQueue),
      'f',
    );
    __classPrivateFieldSet(
      this,
      _AgentPlayout_currentPlayoutTask,
      this.playoutTask(
        __classPrivateFieldGet(this, _AgentPlayout_currentPlayoutTask, 'f'),
        __classPrivateFieldGet(this, _AgentPlayout_currentPlayoutHandle, 'f'),
      ),
      'f',
    );
    return __classPrivateFieldGet(this, _AgentPlayout_currentPlayoutHandle, 'f');
  }
  async playoutTask(oldTask, handle) {
    let firstFrame = true;
    try {
      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, OUTPUT_PCM_FRAME_SIZE);
      while (!handle.interrupted) {
        const frame = await handle.playoutQueue.get();
        if (frame === null) break;
        if (firstFrame) {
          handle.transcriptionFwd.start();
          firstFrame = false;
        }
        for (const f of bstream.write(frame.data.buffer)) {
          handle.playedAudioSamples += f.samplesPerChannel;
          if (handle.interrupted) break;
          await __classPrivateFieldGet(this, _AgentPlayout_audioSource, 'f').captureFrame(f);
        }
      }
      if (!handle.interrupted) {
        for (const f of bstream.flush()) {
          await __classPrivateFieldGet(this, _AgentPlayout_audioSource, 'f').captureFrame(f);
        }
      }
    } finally {
      if (!firstFrame && !handle.interrupted) {
        handle.transcriptionFwd.markTextComplete();
      }
      await handle.transcriptionFwd.close(handle.interrupted);
      handle.complete();
    }
  }
}
(_AgentPlayout_audioSource = new WeakMap()),
  (_AgentPlayout_currentPlayoutHandle = new WeakMap()),
  (_AgentPlayout_currentPlayoutTask = new WeakMap());
export class PlayoutHandle extends EventEmitter {
  constructor(messageId, transcriptionFwd, playoutQueue) {
    super();
    this.messageId = messageId;
    this.transcriptionFwd = transcriptionFwd;
    this.playedAudioSamples = 0;
    this.done = false;
    this.interrupted = false;
    this.playoutQueue = playoutQueue;
  }
  // pushAudio(data: Uint8Array) {
  //   const frame = new AudioFrame(
  //     new Int16Array(data.buffer),
  //     SAMPLE_RATE,
  //     NUM_CHANNELS,
  //     data.length / 2,
  //   );
  //   this.transcriptionFwd.pushAudio(frame);
  //   this.playoutQueue.put(frame);
  // }
  // pushText(text: string) {
  //   this.transcriptionFwd.pushText(text);
  // }
  endInput() {
    this.transcriptionFwd.markAudioComplete();
    this.transcriptionFwd.markTextComplete();
    this.playoutQueue.put(null);
  }
  interrupt() {
    if (this.done) return;
    this.interrupted = true;
  }
  publishedTextChars() {
    return this.transcriptionFwd.currentCharacterIndex;
  }
  complete() {
    if (this.done) return;
    this.done = true;
    this.emit('complete', this.interrupted);
  }
}
// # livekit-agents/livekit/agents/omni_assistant/agent_playout.py
// class PlayoutHandle:
//     def __init__(self, *, audio_source: rtc.AudioSource, item_id: str, content_index: int, transcription_fwd: transcription.TTSSegmentsForwarder) -> None
//     @property
//     def item_id(self) -> str
//     @property
//     def audio_samples(self) -> int
//     @property
//     def text_chars(self) -> int
//     @property
//     def content_index(self) -> int
//     @property
//     def interrupted(self) -> bool
//     def done(self) -> bool
//     def interrupt(self) -> None
// class AgentPlayout:
//     def __init__(self, *, audio_source: rtc.AudioSource) -> None
//     def play(self, *, item_id: str, content_index: int, transcription_fwd: transcription.TTSSegmentsForwarder, text_stream: AsyncIterable[str], audio_stream: AsyncIterable[rtc.AudioFrame]) -> PlayoutHandle
//# sourceMappingURL=agent_playout.js.map
