// import {
//   Participant,
//   Room,
//   Track,
//   TrackPublication,
//   Transcription,
//   TranscriptionSegment,
// } from '@livekit/rtc-node';
// import { log } from '../log.js';
// import { SpeechEvent, SpeechEventType } from '../stt';
// import { findMicroTrackId, segmentUuid } from './utils.js';

// type BeforeForwardCallback = (
//   fwd: STTSegmentsForwarder,
//   transcription: Transcription,
// ) => Transcription | Promise<Transcription | null | undefined>;

// type WillForwardTranscription = BeforeForwardCallback;

// function defaultBeforeForwardCb(
//   _fwd: STTSegmentsForwarder,
//   transcription: Transcription,
// ): Transcription {
//   return transcription;
// }

// export class STTSegmentsForwarder {
//   private room: Room;
//   private participantIdentity: string;
//   private trackId: string;
//   private beforeForwardCb: BeforeForwardCallback;
//   private queue: AsyncQueue<TranscriptionSegment | null>;
//   private mainTask: Promise<void>;
//   private currentId: string;

//   constructor({
//     room,
//     participant,
//     track,
//     beforeForwardCb = defaultBeforeForwardCb,
//     willForwardTranscription,
//   }: {
//     room: Room;
//     participant: Participant | string;
//     track?: Track | TrackPublication | string;
//     beforeForwardCb?: BeforeForwardCallback;
//     willForwardTranscription?: WillForwardTranscription;
//   }) {
//     const identity = typeof participant === 'string' ? participant : participant.identity;

//     if (!track) {
//       track = findMicroTrackId(room, identity);
//     } else if (track instanceof Track || track instanceof TrackPublication) {
//       track = track.sid;
//     }

//     if (willForwardTranscription !== undefined) {
//       logger.warn(
//         'will_forward_transcription is deprecated and will be removed in 1.5.0, use before_forward_cb instead',
//       );
//       beforeForwardCb = willForwardTranscription;
//     }

//     this.room = room;
//     this.participantIdentity = identity;
//     this.trackId = track;
//     this.beforeForwardCb = beforeForwardCb;
//     this.queue = new AsyncQueue<TranscriptionSegment | null>();
//     this.mainTask = this.run();
//     this.currentId = segmentUuid();
//   }

//   private async run(): Promise<void> {
//     try {
//       while (true) {
//         const seg = await this.queue.get();
//         if (seg === null) break;

//         const baseTranscription = new Transcription({
//           participantIdentity: this.participantIdentity,
//           trackSid: this.trackId,
//           segments: [seg], // no history for now
//         });

//         let transcription = this.beforeForwardCb(this, baseTranscription);
//         if (transcription instanceof Promise) {
//           transcription = await transcription;
//         }

//         if (!(transcription instanceof Transcription)) {
//           transcription = defaultBeforeForwardCb(this, baseTranscription);
//         }

//         if (transcription.segments && this.room.isConnected) {
//           await this.room.localParticipant?.publishTranscription(transcription);
//         }
//       }
//     } catch (error) {
//       logger.error('error in stt transcription', error);
//     }
//   }

//   update(ev: SpeechEvent): void {
//     if (ev.type === SpeechEventType.INTERIM_TRANSCRIPT) {
//       // TODO: We always take the first alternative, we should maybe expose option to the user?
//       const text = ev.alternatives[0].text;
//       this.queue.put(
//         new TranscriptionSegment({
//           id: this.currentId,
//           text,
//           startTime: 0,
//           endTime: 0,
//           isFinal: false,
//           language: '', // TODO
//         }),
//       );
//     } else if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
//       const text = ev.alternatives[0].text;
//       this.queue.put(
//         new TranscriptionSegment({
//           id: this.currentId,
//           text,
//           startTime: 0,
//           endTime: 0,
//           isFinal: true,
//           language: '', // TODO
//         }),
//       );

//       this.currentId = segmentUuid();
//     }
//   }

//   async close(wait: boolean = true): Promise<void> {
//     this.queue.put(null);

//     if (!wait) {
//       // Note: There's no direct equivalent to Python's asyncio.Task.cancel() in TypeScript
//       // You might need to implement a cancellation mechanism if required
//     }

//     try {
//       await this.mainTask;
//     } catch (error) {
//       if (error instanceof Error && error.name === 'AbortError') {
//         // Equivalent to suppressing asyncio.CancelledError
//         return;
//       }
//       throw error;
//     }
//   }
// }

// // Helper class to mimic Python's asyncio.Queue
// class AsyncQueue<T> {
//   private queue: T[] = [];
//   private resolvers: ((value: T | PromiseLike<T>) => void)[] = [];

//   put(item: T): void {
//     if (this.resolvers.length > 0) {
//       const resolve = this.resolvers.shift()!;
//       resolve(item);
//     } else {
//       this.queue.push(item);
//     }
//   }

//   async get(): Promise<T> {
//     if (this.queue.length > 0) {
//       return this.queue.shift()!;
//     }
//     return new Promise<T>((resolve) => {
//       this.resolvers.push(resolve);
//     });
//   }
// }
