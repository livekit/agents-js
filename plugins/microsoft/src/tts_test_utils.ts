// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export function wavBytes(
  pcm: Uint8Array,
  options: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const output = new Uint8Array(44 + pcm.length);
  const view = new DataView(output.buffer);
  output.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, output.length - 8, true);
  output.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  output.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, pcm.length, true);
  output.set(pcm, 44);
  return output;
}

export function wavResponse(
  pcm: Uint8Array,
  options: {
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    status?: number;
    contentType?: string;
    contentLength?: number;
  } = {},
): Response {
  const body = wavBytes(pcm, options);
  const headers = new Headers({ 'Content-Type': options.contentType ?? 'audio/wav' });
  if (options.contentLength !== undefined)
    headers.set('Content-Length', String(options.contentLength));
  return new Response(Buffer.from(body), { status: options.status ?? 200, headers });
}
