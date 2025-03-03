// SPDX-FileCopyrightText: 2024 Josiah Bryan, LLC
//
// SPDX-License-Identifier: Apache-2.0
import { type AudioBuffer, AudioByteStream, AudioEnergyFilter, log, stt } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { AssemblyAI } from 'assemblyai';
import type { RealtimeTranscriber } from 'assemblyai';

export interface STTOptions {
	apiKey?: string;
	interimResults: boolean;
	sampleRate: number;
	keywords: [string, number][];
	endUtteranceSilenceThreshold?: number;
}

const defaultSTTOptions: STTOptions = {
	apiKey: process.env.ASSEMBLY_AI_KEY,
	interimResults: true,
	sampleRate: 16000,
	keywords: [],
	// NOTE:
	// The default is 700ms from AssemblyAI.
	// I use a low default of 300ms here because I also use
	// the new end-of-utterance model from LiveKit to handle
	// turn detection in my agent. Which means that even though
	// this will quickly return a final transcript EVEN THOUGH
	// USER IS NOT DONE SPEAKING, the EOU model from LiveKit
	// DOES properly differentiate and doesn't interrupt (magically!)
	// Ref: https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection/
	endUtteranceSilenceThreshold: 200,
};

export class STT extends stt.STT {
	#opts: STTOptions;
	#logger = log();
	label = 'assemblyai.STT';

	constructor(opts: Partial<STTOptions> = defaultSTTOptions) {
		super({
			streaming: true,
			interimResults: opts.interimResults ?? defaultSTTOptions.interimResults,
		});
		if (opts.apiKey === undefined && defaultSTTOptions.apiKey === undefined) {
			throw new Error(
				'AssemblyAI API key is required, whether as an argument or as $ASSEMBLY_AI_KEY',
			);
		}

		this.#opts = { ...defaultSTTOptions, ...opts };
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
		throw new Error('Recognize is not supported on AssemblyAI STT');
	}

	stream(): stt.SpeechStream {
		return new SpeechStream(this, this.#opts);
	}
}

export class SpeechStream extends stt.SpeechStream {
	#opts: STTOptions;
	#audioEnergyFilter: AudioEnergyFilter;
	#logger = log();
	#speaking = false;
	#client: AssemblyAI;
	#transcriber?: RealtimeTranscriber;
	label = 'assemblyai.SpeechStream';

	constructor(stt: STT, opts: STTOptions) {
		super(stt);
		this.#opts = opts;
		this.closed = false;
		this.#audioEnergyFilter = new AudioEnergyFilter();
		this.#client = new AssemblyAI({
			apiKey: this.#opts.apiKey || '',
		});

		this.#run();
	}

	async #run() {
		try {
			// Create the realtime transcriber with parameters that AssemblyAI supports
			this.#transcriber = this.#client.realtime.transcriber({
				sampleRate: this.#opts.sampleRate,
				wordBoost: this.#opts.keywords.map((k) => k[0]),
				endUtteranceSilenceThreshold: this.#opts.endUtteranceSilenceThreshold,
			});

			// Set up event handlers
			this.#transcriber.on('open', (data) => {
				this.#logger.debug(
					`AssemblyAI session opened: ${data.sessionId}, expires at: ${data.expiresAt}`,
				);
			});

			this.#transcriber.on('close', (code, reason) => {
				this.#logger.debug(`AssemblyAI session closed: ${code}, reason: ${reason}`);
				if (!this.closed) {
					// Try to reconnect if not intentionally closed
					this.#run();
				}
			});

			this.#transcriber.on('error', (error) => {
				this.#logger.error(`AssemblyAI error: ${error.message}`);
			});

			this.#transcriber.on('transcript', (transcript) => {
				if (this.closed) return;

				if (!transcript.text || transcript.text.trim() === '') {
					return;
				}

				// If we haven't started speaking yet, emit a start of speech event
				if (!this.#speaking) {
					this.#speaking = true;
					this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
				}

				// Handle partial and final transcripts
				if (transcript.message_type === 'PartialTranscript') {
					this.queue.put({
						type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
						alternatives: [assemblyTranscriptToSpeechData(transcript)],
					});
				} else if (transcript.message_type === 'FinalTranscript') {
					this.queue.put({
						type: stt.SpeechEventType.FINAL_TRANSCRIPT,
						alternatives: [assemblyTranscriptToSpeechData(transcript)],
					});
				}
			});

			// Connect to the AssemblyAI service
			await this.#transcriber.connect();

			// Process audio data from the input stream
			const sendTask = async () => {
				const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
				const stream = new AudioByteStream(this.#opts.sampleRate, 1, samples100Ms);

				for await (const data of this.input) {
					if (this.closed) break;

					let frames: AudioFrame[];
					if (data === SpeechStream.FLUSH_SENTINEL) {
						frames = stream.flush();
					} else if (data.sampleRate === this.#opts.sampleRate) {
						frames = stream.write(data.data.buffer);
					} else {
						throw new Error(`Sample rate or channel count of frame does not match`);
					}

					for await (const frame of frames) {
						if (this.#audioEnergyFilter.pushFrame(frame)) {
							// Send audio data to AssemblyAI
							this.#transcriber?.sendAudio(new Uint8Array(frame.data.buffer));
						}
					}
				}

				// Close the connection when done
				if (this.#transcriber) {
					await this.#transcriber.close();
				}
			};

			// Start processing audio
			await sendTask();
		} catch (error) {
			this.#logger.error(`Error in AssemblyAI STT: ${error}`);

			// Try to reconnect after a delay if not intentionally closed
			if (!this.closed) {
				setTimeout(() => this.#run(), 5000);
			}
		}
	}
}

// Helper function to convert AssemblyAI transcript to SpeechData
const assemblyTranscriptToSpeechData = (transcript: any): stt.SpeechData => {
	return {
		language: 'en-US',
		startTime: transcript.audio_start || 0,
		endTime: transcript.audio_end || 0,
		confidence: transcript.confidence || 1.0,
		text: transcript.text || '',
	};
};
