// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as grpc from '@grpc/grpc-js';

export function createRivaCredentials(useSsl: boolean): grpc.ChannelCredentials {
  return useSsl ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

export function createRivaMetadata(apiKey: string | undefined, functionId: string): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (apiKey) metadata.set('authorization', `Bearer ${apiKey}`);
  metadata.set('function-id', functionId);
  return metadata;
}
