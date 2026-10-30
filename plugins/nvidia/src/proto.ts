// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

/** Provider request identifier; absent message fields decode to null. */
interface RequestId {
  /** Identifier assigned by Riva to correlate a request with its responses. */
  value: string;
}

/** Model-discovery response. The loader supplies empty arrays and maps for omitted fields. */
export interface ModelConfigResponse {
  modelConfig: { modelName: string; parameters: Record<string, string> }[];
}

/** A decoded ASR response. Word offsets are milliseconds from the start of the RPC. */
export interface StreamingRecognizeResponse {
  results: {
    alternatives: {
      transcript: string;
      confidence: number;
      words: {
        /** Word start offset in milliseconds. */
        startTime: number;
        /** Word end offset in milliseconds. */
        endTime: number;
        word: string;
        confidence: number;
      }[];
    }[];
    isFinal: boolean;
  }[];
  /** Provider request ID, or null when Riva omits it. */
  id: RequestId | null;
}

/** ASR input: one configuration message followed by mono, signed 16-bit PCM chunks. */
export type StreamingRecognizeRequest =
  | {
      streamingConfig: {
        config: {
          encoding: 'LINEAR_PCM';
          sampleRateHertz: number;
          languageCode: string;
          maxAlternatives: number;
          audioChannelCount: number;
          enableWordTimeOffsets: boolean;
          enableAutomaticPunctuation: boolean;
          model: string;
        };
        interimResults: boolean;
      };
    }
  | { audioContent: Buffer };

/** One sentence-synthesis request; sampleRateHz specifies the returned PCM sample rate. */
export interface SynthesizeSpeechRequest {
  text: string;
  languageCode: string;
  encoding: 'LINEAR_PCM';
  sampleRateHz: number;
  voiceName: string;
}

/** A decoded synthesis chunk; the loader supplies an empty buffer for omitted audio. */
export interface SynthesizeSpeechResponse {
  /** Signed 16-bit little-endian PCM at the requested sample rate. */
  audio: Buffer;
  /** Provider request ID, or null when Riva omits it. */
  id: RequestId | null;
}

/** Typed ASR RPCs from the vendored riva_asr.proto service. */
export interface RivaSpeechRecognitionClient extends grpc.Client {
  /** Open a bidirectional recognition RPC; send configuration before audio. */
  StreamingRecognize(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<StreamingRecognizeRequest, StreamingRecognizeResponse>;
  /** Discover ASR model names and their configuration parameters. */
  GetRivaSpeechRecognitionConfig(
    request: { modelName?: string },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ModelConfigResponse) => void,
  ): grpc.ClientUnaryCall;
}

/** Typed synthesis RPCs from the vendored riva_tts.proto service. */
export interface RivaSpeechSynthesisClient extends grpc.Client {
  /** Synthesize one sentence as a server stream of PCM chunks. */
  SynthesizeOnline(
    request: SynthesizeSpeechRequest,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<SynthesizeSpeechResponse>;
  /** Discover TTS voices and their configuration parameters. */
  GetRivaSynthesisConfig(
    request: { modelName?: string },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ModelConfigResponse) => void,
  ): grpc.ClientUnaryCall;
}

/** grpc-js constructor with the methods of one Riva service. */
export type RivaClientConstructor<T extends grpc.Client> = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => T;

const includeDirs = [fileURLToPath(new URL('../proto', import.meta.url))];
const loaderOptions: protoLoader.Options = {
  defaults: true,
  includeDirs,
  oneofs: true,
};

function loadClient<T extends grpc.Client>(
  proto: string,
  service: string,
): RivaClientConstructor<T> {
  const filename = fileURLToPath(new URL(`../proto/riva/proto/${proto}`, import.meta.url));
  const definition = protoLoader.loadSync(filename, loaderOptions);
  return grpc.makeClientConstructor(
    definition[service] as grpc.ServiceDefinition,
    service,
  ) as unknown as RivaClientConstructor<T>;
}

export const RivaSpeechRecognition = loadClient<RivaSpeechRecognitionClient>(
  'riva_asr.proto',
  'nvidia.riva.asr.RivaSpeechRecognition',
);
export const RivaSpeechSynthesis = loadClient<RivaSpeechSynthesisClient>(
  'riva_tts.proto',
  'nvidia.riva.tts.RivaSpeechSynthesis',
);
