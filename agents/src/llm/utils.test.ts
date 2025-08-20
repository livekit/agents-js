// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContext, ChatMessage, type ImageContent } from './chat_context.js';
import { computeChatCtxDiff, serializeImage } from './utils.js';

function createChatMessage(
  id: string,
  content: string,
  role: 'user' | 'assistant' | 'system' = 'user',
): ChatMessage {
  return ChatMessage.create({
    id,
    content,
    role,
  });
}

function createChatContext(messages: ChatMessage[]): ChatContext {
  const ctx = new ChatContext();
  for (const message of messages) {
    ctx.items.push(message);
  }
  return ctx;
}

function createImageContent(
  image: string | VideoFrame,
  inferenceDetail: 'auto' | 'high' | 'low' = 'auto',
  options?: {
    mimeType?: string;
    inferenceWidth?: number;
    inferenceHeight?: number;
  },
): ImageContent {
  return {
    id: 'test-id',
    type: 'image_content',
    image,
    inferenceDetail,
    mimeType: options?.mimeType,
    inferenceWidth: options?.inferenceWidth,
    inferenceHeight: options?.inferenceHeight,
    _cache: {},
  };
}

async function decodeImageToRaw(base64Data: string) {
  const imageBuffer = Buffer.from(base64Data, 'base64');
  const decodedImage = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });
  return { imageBuffer, decodedImage };
}

function createSolidColorFrame(
  width: number,
  height: number,
  color: { r: number; g: number; b: number; a?: number },
  bufferType: VideoBufferType = VideoBufferType.RGBA,
): VideoFrame {
  const channels = bufferType === VideoBufferType.RGB24 ? 3 : 4;
  const frameData = new Uint8Array(width * height * channels);

  for (let i = 0; i < frameData.length; i += channels) {
    frameData[i] = color.r;
    frameData[i + 1] = color.g;
    frameData[i + 2] = color.b;
    if (channels === 4 && color.a !== undefined) {
      frameData[i + 3] = color.a;
    }
  }

  return new VideoFrame(frameData, width, height, bufferType);
}

function createGradientFrame(width: number, height: number): VideoFrame {
  const channels = 4;
  const frameData = new Uint8Array(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      frameData[idx] = Math.floor((x / (width - 1)) * 255);
      frameData[idx + 1] = Math.floor((y / (height - 1)) * 255);
      frameData[idx + 2] = 128;
      frameData[idx + 3] = 255;
    }
  }

  return new VideoFrame(frameData, width, height, VideoBufferType.RGBA);
}

function createPatternFrame(width: number, height: number, patterns: number[][]): VideoFrame {
  const channels = 4;
  const frameData = new Uint8Array(width * height * channels);

  for (let i = 0; i < patterns.length; i++) {
    const offset = i * 4;
    const pattern = patterns[i]!;
    frameData[offset] = pattern[0]!;
    frameData[offset + 1] = pattern[1]!;
    frameData[offset + 2] = pattern[2]!;
    frameData[offset + 3] = pattern[3]!;
  }

  return new VideoFrame(frameData, width, height, VideoBufferType.RGBA);
}

function verifyPngHeader(imageBuffer: Buffer) {
  expect(imageBuffer[0]).toBe(0x89);
  expect(imageBuffer[1]).toBe(0x50);
  expect(imageBuffer[2]).toBe(0x4e);
  expect(imageBuffer[3]).toBe(0x47);
}

function expectPixel(
  data: Buffer,
  index: number,
  expected: { r: number; g: number; b: number; a: number },
) {
  expect(data[index]).toBe(expected.r);
  expect(data[index + 1]).toBe(expected.g);
  expect(data[index + 2]).toBe(expected.b);
  expect(data[index + 3]).toBe(expected.a);
}

describe('computeChatCtxDiff', () => {
  it('should return empty operations for identical contexts', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');

    const oldCtx = createChatContext([msg1, msg2]);
    const newCtx = createChatContext([msg1, msg2]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle empty old context', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');

    const oldCtx = createChatContext([]);
    const newCtx = createChatContext([msg1, msg2]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([
      [null, '1'], // first item goes to root
      ['1', '2'],
    ]);
  });

  it('should handle empty new context', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');

    const oldCtx = createChatContext([msg1, msg2]);
    const newCtx = createChatContext([]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['1', '2']);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle adding items to the end', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');

    const oldCtx = createChatContext([msg1, msg2]);
    const newCtx = createChatContext([msg1, msg2, msg3]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([['2', '3']]);
  });

  it('should handle removing items from the end', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');

    const oldCtx = createChatContext([msg1, msg2, msg3]);
    const newCtx = createChatContext([msg1, msg2]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['3']);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle adding items to the beginning', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');

    const oldCtx = createChatContext([msg2, msg3]);
    const newCtx = createChatContext([msg1, msg2, msg3]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([[null, '1']]);
  });

  it('should handle removing items from the beginning', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');

    const oldCtx = createChatContext([msg1, msg2, msg3]);
    const newCtx = createChatContext([msg2, msg3]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['1']);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle adding items in the middle', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');
    const msg4 = createChatMessage('4', 'Fine thanks', 'assistant');

    const oldCtx = createChatContext([msg1, msg3, msg4]);
    const newCtx = createChatContext([msg1, msg2, msg3, msg4]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([['1', '2']]);
  });

  it('should handle removing items from the middle', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');
    const msg4 = createChatMessage('4', 'Fine thanks', 'assistant');

    const oldCtx = createChatContext([msg1, msg2, msg3, msg4]);
    const newCtx = createChatContext([msg1, msg3, msg4]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['2']);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle complex mixed operations', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');
    const msg4 = createChatMessage('4', 'Fine thanks', 'assistant');
    const msg5 = createChatMessage('5', 'Good to hear', 'user');
    const msg6 = createChatMessage('6', 'Anything else?', 'assistant');

    // Old: [1, 2, 3, 4]
    // New: [1, 5, 3, 6]
    // Remove: [2, 4]
    // Create: [5 after 1, 6 after 3]

    const oldCtx = createChatContext([msg1, msg2, msg3, msg4]);
    const newCtx = createChatContext([msg1, msg5, msg3, msg6]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['2', '4']);
    expect(result.toCreate).toEqual([
      ['1', '5'],
      ['3', '6'],
    ]);
  });

  it('should handle reordering items', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');

    // Old: [1, 2, 3]
    // New: [3, 1, 2]
    // This should remove all and recreate in new order

    const oldCtx = createChatContext([msg1, msg2, msg3]);
    const newCtx = createChatContext([msg3, msg1, msg2]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    // Since order changed completely, should have some operations
    expect(result.toRemove.length + result.toCreate.length).toBeGreaterThan(0);
  });

  it('should handle identical single item contexts', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');

    const oldCtx = createChatContext([msg1]);
    const newCtx = createChatContext([msg1]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle longest common subsequence correctly', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');
    const msg4 = createChatMessage('4', 'Fine thanks', 'assistant');
    const msg5 = createChatMessage('5', 'Good to hear', 'user');

    // Old: [1, 2, 3, 4, 5]
    // New: [1, 3, 5]
    // LCS should be [1, 3, 5], remove [2, 4]

    const oldCtx = createChatContext([msg1, msg2, msg3, msg4, msg5]);
    const newCtx = createChatContext([msg1, msg3, msg5]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual(['2', '4']);
    expect(result.toCreate).toEqual([]);
  });

  it('should handle interleaved additions and common subsequence', () => {
    const msg1 = createChatMessage('1', 'Hello', 'user');
    const msg2 = createChatMessage('2', 'Hi there', 'assistant');
    const msg3 = createChatMessage('3', 'How are you?', 'user');
    const msg4 = createChatMessage('4', 'Fine thanks', 'assistant');
    const msg5 = createChatMessage('5', 'Good to hear', 'user');
    const msg6 = createChatMessage('6', 'Anything else?', 'assistant');

    // Old: [1, 3, 5]
    // New: [1, 2, 3, 4, 5, 6]
    // LCS: [1, 3, 5], add [2 after 1, 4 after 3, 6 after 5]

    const oldCtx = createChatContext([msg1, msg3, msg5]);
    const newCtx = createChatContext([msg1, msg2, msg3, msg4, msg5, msg6]);

    const result = computeChatCtxDiff(oldCtx, newCtx);

    expect(result.toRemove).toEqual([]);
    expect(result.toCreate).toEqual([
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });
});

describe('serializeImage', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('Data URL handling', () => {
    it('should serialize a valid JPEG data URL', async () => {
      const originalBase64 = '/9j/4AAQSkZJRg==';
      const imageContent = createImageContent(`data:image/jpeg;base64,${originalBase64}`, 'high');

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: originalBase64,
        mimeType: 'image/jpeg',
        inferenceDetail: 'high',
      });

      expect(result.base64Data).toBe(originalBase64);
    });

    it('should serialize a valid PNG data URL', async () => {
      const imageContent = createImageContent(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        'low',
      );

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        mimeType: 'image/png',
        inferenceDetail: 'low',
      });
    });

    it('should serialize a valid WebP data URL', async () => {
      const imageContent = createImageContent(
        'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAA',
        'auto',
      );

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'UklGRiQAAABXRUJQVlA4IBgAAAA',
        mimeType: 'image/webp',
        inferenceDetail: 'auto',
      });
    });

    it('should serialize a valid GIF data URL', async () => {
      const imageContent = createImageContent(
        'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
        'auto',
      );

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
        mimeType: 'image/gif',
        inferenceDetail: 'auto',
      });
    });

    it('should warn and use provided mimeType when it differs from data URL mime type', async () => {
      const imageContent = createImageContent('data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'auto', {
        mimeType: 'image/png',
      });

      const result = await serializeImage(imageContent);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Provided mimeType 'image/png' does not match data URL mime type 'image/jpeg'. Using provided mimeType.",
      );
      expect(result).toEqual({
        base64Data: '/9j/4AAQSkZJRg==',
        mimeType: 'image/png',
        inferenceDetail: 'auto',
      });
    });

    it('should throw error for invalid data URL format', async () => {
      const imageContent = createImageContent('data:;base64,/9j/4AAQSkZJRg==', 'auto');

      await expect(serializeImage(imageContent)).rejects.toThrow('Invalid data URL format');
    });

    it('should throw error for unsupported mime type', async () => {
      const imageContent = createImageContent(
        'data:image/bmp;base64,Qk06AAAAAAAAADYAAAAoAAAA',
        'auto',
      );

      await expect(serializeImage(imageContent)).rejects.toThrow(
        'Unsupported mimeType image/bmp. Must be jpeg, png, webp, or gif',
      );
    });
  });

  describe('External URL handling', () => {
    it('should serialize an external URL without mimeType', async () => {
      const imageContent = createImageContent('https://example.com/image.jpg', 'high');

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        mimeType: undefined,
        inferenceDetail: 'high',
        externalUrl: 'https://example.com/image.jpg',
      });
    });

    it('should serialize an external URL with mimeType', async () => {
      const imageContent = createImageContent('https://example.com/image.jpg', 'low', {
        mimeType: 'image/jpeg',
      });

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        mimeType: 'image/jpeg',
        inferenceDetail: 'low',
        externalUrl: 'https://example.com/image.jpg',
      });
    });
  });

  describe('VideoFrame handling', () => {
    it('should serialize a VideoFrame without resize parameters', async () => {
      const width = 4;
      const height = 4;
      const videoFrame = createSolidColorFrame(width, height, { r: 255, g: 0, b: 0, a: 255 });
      const imageContent = createImageContent(videoFrame, 'auto');

      const result = await serializeImage(imageContent);

      expect(result).toMatchObject({
        mimeType: 'image/png',
        inferenceDetail: 'auto',
      });
      expect(result.base64Data).toBeDefined();
      expect(result.base64Data).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(result.externalUrl).toBeUndefined();

      const { imageBuffer, decodedImage } = await decodeImageToRaw(result.base64Data!);

      verifyPngHeader(imageBuffer);

      expect(decodedImage.info.width).toBe(width);
      expect(decodedImage.info.height).toBe(height);
      expect(decodedImage.info.channels).toBe(4);

      const decodedData = decodedImage.data;
      for (let i = 0; i < decodedData.length; i += 4) {
        expectPixel(decodedData, i, { r: 255, g: 0, b: 0, a: 255 });
      }
    });

    it('should serialize a VideoFrame with a gradient pattern', async () => {
      const width = 8;
      const height = 8;
      const videoFrame = createGradientFrame(width, height);
      const imageContent = createImageContent(videoFrame, 'high');

      const result = await serializeImage(imageContent);

      expect(result).toMatchObject({
        mimeType: 'image/png',
        inferenceDetail: 'high',
      });

      const { decodedImage } = await decodeImageToRaw(result.base64Data!);

      expect(decodedImage.info.width).toBe(width);
      expect(decodedImage.info.height).toBe(height);

      const decodedData = decodedImage.data;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const expectedR = Math.floor((x / (width - 1)) * 255);
          const expectedG = Math.floor((y / (height - 1)) * 255);

          expectPixel(decodedData, idx, { r: expectedR, g: expectedG, b: 128, a: 255 });
        }
      }
    });

    it('should preserve exact pixel data through serialization', async () => {
      const width = 2;
      const height = 2;

      const patterns = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
      ];

      const videoFrame = createPatternFrame(width, height, patterns);
      const imageContent = createImageContent(videoFrame, 'low');

      const result = await serializeImage(imageContent);

      const { decodedImage } = await decodeImageToRaw(result.base64Data!);
      const decoded = decodedImage.data;

      expectPixel(decoded, 0, { r: 255, g: 0, b: 0, a: 255 });
      expectPixel(decoded, 4, { r: 0, g: 255, b: 0, a: 255 });
      expectPixel(decoded, width * 4, { r: 0, g: 0, b: 255, a: 255 });
      expectPixel(decoded, (width + 1) * 4, { r: 255, g: 255, b: 255, a: 255 });
    });

    it('should handle resize parameters correctly', async () => {
      const width = 2;
      const height = 2;
      const videoFrame = createSolidColorFrame(width, height, { r: 100, g: 100, b: 100, a: 255 });

      const imageContent = createImageContent(videoFrame, 'auto', {
        inferenceWidth: 4,
        inferenceHeight: 4,
      });

      const result = await serializeImage(imageContent);

      const { decodedImage } = await decodeImageToRaw(result.base64Data!);

      expect(decodedImage.info.width).toBe(4);
      expect(decodedImage.info.height).toBe(4);

      const decodedData = decodedImage.data;
      for (let i = 0; i < decodedData.length; i += 4) {
        expect(decodedData[i]).toBeCloseTo(100, -1);
        expect(decodedData[i + 1]).toBeCloseTo(100, -1);
        expect(decodedData[i + 2]).toBeCloseTo(100, -1);
        expect(decodedData[i + 3]).toBe(255);
      }
    });

    it('should handle RGB24 VideoBufferType correctly', async () => {
      const width = 2;
      const height = 2;
      const channels = 3;
      const frameData = new Uint8Array(width * height * channels);

      for (let i = 0; i < frameData.length; i += channels) {
        frameData[i] = 255;
        frameData[i + 1] = 128;
        frameData[i + 2] = 64;
      }

      const videoFrame = new VideoFrame(frameData, width, height, VideoBufferType.RGB24);
      const imageContent = createImageContent(videoFrame, 'auto');

      const result = await serializeImage(imageContent);

      expect(result.mimeType).toBe('image/png');

      const { decodedImage } = await decodeImageToRaw(result.base64Data!);

      expect(decodedImage.info.channels).toBeGreaterThanOrEqual(3);

      const decodedData = decodedImage.data;
      const decodedChannels = decodedImage.info.channels;

      for (let i = 0; i < decodedData.length; i += decodedChannels) {
        expect(decodedData[i]).toBe(255);
        expect(decodedData[i + 1]).toBe(128);
        expect(decodedData[i + 2]).toBe(64);
        if (decodedChannels === 4) {
          expect(decodedData[i + 3]).toBe(255);
        }
      }
    });

    it('should handle different RGBA-like formats correctly', async () => {
      const width = 1;
      const height = 1;
      const testFormats = [
        VideoBufferType.RGBA,
        VideoBufferType.BGRA,
        VideoBufferType.ARGB,
        VideoBufferType.ABGR,
      ];

      for (const format of testFormats) {
        const frameData = new Uint8Array([100, 150, 200, 250]);
        const videoFrame = new VideoFrame(frameData, width, height, format);
        const imageContent = createImageContent(videoFrame, 'auto');

        const result = await serializeImage(imageContent);

        expect(result.mimeType).toBe('image/png');
        expect(result.base64Data).toBeDefined();
      }
    });
  });

  describe('Error handling', () => {
    it('should throw error for unsupported image type', async () => {
      const imageContent = createImageContent(123 as any, 'auto'); // eslint-disable-line @typescript-eslint/no-explicit-any

      await expect(serializeImage(imageContent)).rejects.toThrow('Unsupported image type');
    });
  });
});
