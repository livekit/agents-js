// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

interface RequestId {
  value: string;
}

export interface ModelConfigResponse {
  modelConfig: { modelName: string; parameters: Record<string, string> }[];
}

export interface StreamingRecognizeResponse {
  results: {
    alternatives: {
      transcript: string;
      confidence: number;
      words: { startTime: number; endTime: number; word: string; confidence: number }[];
    }[];
    isFinal: boolean;
  }[];
  id: RequestId | null;
}

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

export interface SynthesizeSpeechRequest {
  text: string;
  languageCode: string;
  encoding: 'LINEAR_PCM';
  sampleRateHz: number;
  voiceName: string;
}

export interface SynthesizeSpeechResponse {
  audio: Buffer;
  id: RequestId | null;
}

export interface RivaSpeechRecognitionClient extends grpc.Client {
  StreamingRecognize(
    metadata: grpc.Metadata,
  ): grpc.ClientDuplexStream<StreamingRecognizeRequest, StreamingRecognizeResponse>;
  GetRivaSpeechRecognitionConfig(
    request: { modelName?: string },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ModelConfigResponse) => void,
  ): grpc.ClientUnaryCall;
}

export interface RivaSpeechSynthesisClient extends grpc.Client {
  SynthesizeOnline(
    request: SynthesizeSpeechRequest,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<SynthesizeSpeechResponse>;
  GetRivaSynthesisConfig(
    request: { modelName?: string },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ModelConfigResponse) => void,
  ): grpc.ClientUnaryCall;
}

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
