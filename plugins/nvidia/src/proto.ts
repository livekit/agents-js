// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';

export type ProtoRecord = Record<string, unknown>;

export interface RivaClient extends grpc.Client {
  StreamingRecognize(metadata: grpc.Metadata): grpc.ClientDuplexStream<ProtoRecord, ProtoRecord>;
  SynthesizeOnline(
    request: ProtoRecord,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<ProtoRecord>;
  GetRivaSpeechRecognitionConfig(
    request: ProtoRecord,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ProtoRecord) => void,
  ): grpc.ClientUnaryCall;
  GetRivaSynthesisConfig(
    request: ProtoRecord,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: ProtoRecord) => void,
  ): grpc.ClientUnaryCall;
}

type RivaClientConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => RivaClient;

const includeDirs = [fileURLToPath(new URL('../proto', import.meta.url))];
const loaderOptions: protoLoader.Options = {
  defaults: true,
  includeDirs,
  oneofs: true,
};

function loadClient(proto: string, namespace: 'asr' | 'tts', service: string) {
  const filename = fileURLToPath(new URL(`../proto/riva/proto/${proto}`, import.meta.url));
  const definition = protoLoader.loadSync(filename, loaderOptions);
  const root = grpc.loadPackageDefinition(definition) as ProtoRecord;
  const nvidia = root['nvidia'] as ProtoRecord;
  const riva = nvidia['riva'] as ProtoRecord;
  const packageNamespace = riva[namespace] as ProtoRecord;
  return packageNamespace[service] as RivaClientConstructor;
}

export const RivaSpeechRecognition = loadClient('riva_asr.proto', 'asr', 'RivaSpeechRecognition');
export const RivaSpeechSynthesis = loadClient('riva_tts.proto', 'tts', 'RivaSpeechSynthesis');
