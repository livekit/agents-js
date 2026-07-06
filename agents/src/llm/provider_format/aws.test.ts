// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext, createImageContent } from '../chat_context.js';
import { toChatCtx } from './aws.js';

const IMAGE_BYTES = Buffer.from('fake image bytes');

describe('AWS Provider Format - toChatCtx', () => {
  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
  ])('uses serialized image format for %s', async (mimeType, expectedFormat) => {
    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        createImageContent({
          image: `data:${mimeType};base64,${IMAGE_BYTES.toString('base64')}`,
        }),
      ],
    });

    const [messages] = await toChatCtx(ctx);

    const content = messages[0]?.content as Record<string, unknown>[];
    const image = content[0]?.image as { format: string; source: { bytes: Buffer } };
    expect(image.format).toBe(expectedFormat);
    expect(image.source.bytes).toEqual(IMAGE_BYTES);
  });

  it('rejects external URL images', async () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({
      role: 'user',
      content: [
        createImageContent({
          image: 'https://example.com/image.png',
          mimeType: 'image/png',
        }),
      ],
    });

    await expect(toChatCtx(ctx)).rejects.toThrow('externalUrl is not supported by AWS Bedrock');
  });
});
