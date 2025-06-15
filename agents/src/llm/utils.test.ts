import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ImageContent } from './chat_context.js';
import { serializeImage } from './utils.js';

// Mock sharp module
vi.mock('sharp', () => {
  return {
    default: vi.fn(() => ({
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('mocked-image-data')),
    })),
  };
});

describe('serializeImage', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('Data URL handling', () => {
    it('should serialize a valid JPEG data URL', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        inferenceDetail: 'high',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: '/9j/4AAQSkZJRg==',
        mimeType: 'image/jpeg',
        inferenceDetail: 'high',
      });
    });

    it('should serialize a valid PNG data URL', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        inferenceDetail: 'low',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        mimeType: 'image/png',
        inferenceDetail: 'low',
      });
    });

    it('should serialize a valid WebP data URL', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAA',
        inferenceDetail: 'auto',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'UklGRiQAAABXRUJQVlA4IBgAAAA',
        mimeType: 'image/webp',
        inferenceDetail: 'auto',
      });
    });

    it('should serialize a valid GIF data URL', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
        inferenceDetail: 'auto',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
        mimeType: 'image/gif',
        inferenceDetail: 'auto',
      });
    });

    it('should warn and use provided mimeType when it differs from data URL mime type', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        mimeType: 'image/png', // Different from data URL
        inferenceDetail: 'auto',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Provided mimeType 'image/png' does not match data URL mime type 'image/jpeg'. Using provided mimeType."
      );
      expect(result).toEqual({
        base64Data: '/9j/4AAQSkZJRg==',
        mimeType: 'image/png',
        inferenceDetail: 'auto',
      });
    });

    it('should throw error for invalid data URL format', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:;base64,/9j/4AAQSkZJRg==', // Missing mime type
        inferenceDetail: 'auto',
        _cache: {},
      };

      await expect(serializeImage(imageContent)).rejects.toThrow('Invalid data URL format');
    });

    it('should throw error for unsupported mime type', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'data:image/bmp;base64,Qk06AAAAAAAAADYAAAAoAAAA',
        inferenceDetail: 'auto',
        _cache: {},
      };

      await expect(serializeImage(imageContent)).rejects.toThrow(
        'Unsupported mimeType image/bmp. Must be jpeg, png, webp, or gif'
      );
    });
  });

  describe('External URL handling', () => {
    it('should serialize an external URL without mimeType', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        inferenceDetail: 'high',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        mimeType: undefined,
        inferenceDetail: 'high',
        externalUrl: 'https://example.com/image.jpg',
      });
    });

    it('should serialize an external URL with mimeType', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 'https://example.com/image.jpg',
        mimeType: 'image/jpeg',
        inferenceDetail: 'low',
        _cache: {},
      };

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
      // Create a real VideoFrame instance
      const frameData = new Uint8Array(1920 * 1080 * 4); // RGBA buffer
      const videoFrame = new VideoFrame(frameData, 1920, 1080, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'auto',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: 'bW9ja2VkLWltYWdlLWRhdGE=', // base64 of 'mocked-image-data'
        mimeType: 'image/jpeg',
        inferenceDetail: 'auto',
      });
    });

    it('should serialize a VideoFrame with resize parameters', async () => {
      // Create a real VideoFrame instance
      const frameData = new Uint8Array(256 * 128 * 4); // RGBA buffer
      const videoFrame = new VideoFrame(frameData, 256, 128, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'high',
        inferenceWidth: 800,
        inferenceHeight: 600,
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      // Get the sharp mock
      const sharp = (await import('sharp')).default as unknown as Mock;
      
      // Verify sharp was called with the video frame data
      expect(sharp).toHaveBeenCalledWith(videoFrame.data);
      
      // Get the last call to sharp and verify resize was called
      const lastSharpCall = sharp.mock.results[sharp.mock.results.length - 1];
      expect(lastSharpCall?.value.resize).toHaveBeenCalledWith(800, 600);
      
      expect(result).toEqual({
        base64Data: 'bW9ja2VkLWltYWdlLWRhdGE=',
        mimeType: 'image/jpeg',
        inferenceDetail: 'high',
      });
    });
  });

  describe('Error handling', () => {
    it('should throw error for unsupported image type', async () => {
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: 123 as any, // Invalid type
        inferenceDetail: 'auto',
        _cache: {},
      };

      await expect(serializeImage(imageContent)).rejects.toThrow('Unsupported image type');
    });
  });
});
