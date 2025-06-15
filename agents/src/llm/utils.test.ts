import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageContent } from './chat_context.js';
import { serializeImage } from './utils.js';

describe('serializeImage', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('Data URL handling', () => {
    it('should serialize a valid JPEG data URL', async () => {
      const originalBase64 = '/9j/4AAQSkZJRg==';
      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: `data:image/jpeg;base64,${originalBase64}`,
        inferenceDetail: 'high',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toEqual({
        base64Data: originalBase64,
        mimeType: 'image/jpeg',
        inferenceDetail: 'high',
      });

      // Verify the base64 data is unchanged
      expect(result.base64Data).toBe(originalBase64);
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
        "Provided mimeType 'image/png' does not match data URL mime type 'image/jpeg'. Using provided mimeType.",
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
        'Unsupported mimeType image/bmp. Must be jpeg, png, webp, or gif',
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
      // Create a real VideoFrame instance with raw pixel data
      const width = 4;
      const height = 4;
      const channels = 4; // RGBA
      const frameData = new Uint8Array(width * height * channels);

      // Fill with test data (create a simple pattern)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          frameData[idx] = 255; // R
          frameData[idx + 1] = 0; // G
          frameData[idx + 2] = 0; // B
          frameData[idx + 3] = 255; // A
        }
      }

      const videoFrame = new VideoFrame(frameData, width, height, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'auto',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toMatchObject({
        mimeType: 'image/png',
        inferenceDetail: 'auto',
      });
      expect(result.base64Data).toBeDefined();
      expect(result.base64Data).toMatch(/^[A-Za-z0-9+/]+=*$/); // Valid base64
      expect(result.externalUrl).toBeUndefined();

      // Verify it's a valid PNG by checking the header
      const imageBuffer = Buffer.from(result.base64Data!, 'base64');
      expect(imageBuffer[0]).toBe(0x89); // PNG signature
      expect(imageBuffer[1]).toBe(0x50); // P
      expect(imageBuffer[2]).toBe(0x4e); // N
      expect(imageBuffer[3]).toBe(0x47); // G

      // Decode the PNG back to raw pixels and verify the content
      const decodedImage = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });

      // PNG is lossless, so we should get exact values
      expect(decodedImage.info.width).toBe(width);
      expect(decodedImage.info.height).toBe(height);
      expect(decodedImage.info.channels).toBe(4); // PNG supports alpha

      // Check that all pixels are exactly red
      const decodedData = decodedImage.data;
      for (let i = 0; i < decodedData.length; i += 4) {
        expect(decodedData[i]).toBe(255); // R
        expect(decodedData[i + 1]).toBe(0); // G
        expect(decodedData[i + 2]).toBe(0); // B
        expect(decodedData[i + 3]).toBe(255); // A
      }
    });

    it('should serialize a VideoFrame with a gradient pattern', async () => {
      // Create a real VideoFrame instance with gradient
      const width = 8;
      const height = 8;
      const channels = 4; // RGBA
      const frameData = new Uint8Array(width * height * channels);

      // Fill with a gradient pattern
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * channels;
          frameData[idx] = Math.floor((x / (width - 1)) * 255); // R gradient
          frameData[idx + 1] = Math.floor((y / (height - 1)) * 255); // G gradient
          frameData[idx + 2] = 128; // B constant
          frameData[idx + 3] = 255; // A full
        }
      }

      const videoFrame = new VideoFrame(frameData, width, height, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'high',
        // No resize parameters
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      expect(result).toMatchObject({
        mimeType: 'image/png',
        inferenceDetail: 'high',
      });

      // Decode and verify exact pixel values
      const imageBuffer = Buffer.from(result.base64Data!, 'base64');
      const decodedImage = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });

      expect(decodedImage.info.width).toBe(width);
      expect(decodedImage.info.height).toBe(height);

      const decodedData = decodedImage.data;

      // Verify the exact gradient values are preserved
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const expectedR = Math.floor((x / (width - 1)) * 255);
          const expectedG = Math.floor((y / (height - 1)) * 255);

          expect(decodedData[idx]).toBe(expectedR); // R
          expect(decodedData[idx + 1]).toBe(expectedG); // G
          expect(decodedData[idx + 2]).toBe(128); // B
          expect(decodedData[idx + 3]).toBe(255); // A
        }
      }
    });

    it('should preserve exact pixel data through serialization', async () => {
      // Create a test pattern that's easy to verify
      const width = 2;
      const height = 2;
      const channels = 4;
      const frameData = new Uint8Array(width * height * channels);

      // Create a specific pattern:
      // Top-left: Red, Top-right: Green
      // Bottom-left: Blue, Bottom-right: White
      const patterns = [
        [255, 0, 0, 255], // Red
        [0, 255, 0, 255], // Green
        [0, 0, 255, 255], // Blue
        [255, 255, 255, 255], // White
      ];

      for (let i = 0; i < patterns.length; i++) {
        const offset = i * 4;
        const pattern = patterns[i]!;
        frameData[offset] = pattern[0]!;
        frameData[offset + 1] = pattern[1]!;
        frameData[offset + 2] = pattern[2]!;
        frameData[offset + 3] = pattern[3]!;
      }

      const videoFrame = new VideoFrame(frameData, width, height, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'low',
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      // Decode and verify the pattern
      const imageBuffer = Buffer.from(result.base64Data!, 'base64');
      const decodedImage = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });

      const decoded = decodedImage.data;

      // Check each pixel - PNG is lossless so values should be exact
      // Top-left (red)
      expect(decoded[0]).toBe(255); // R
      expect(decoded[1]).toBe(0); // G
      expect(decoded[2]).toBe(0); // B
      expect(decoded[3]).toBe(255); // A

      // Top-right (green)
      expect(decoded[4]).toBe(0); // R
      expect(decoded[5]).toBe(255); // G
      expect(decoded[6]).toBe(0); // B
      expect(decoded[7]).toBe(255); // A

      // Bottom-left (blue)
      const bottomLeftIdx = width * 4;
      expect(decoded[bottomLeftIdx]).toBe(0); // R
      expect(decoded[bottomLeftIdx + 1]).toBe(0); // G
      expect(decoded[bottomLeftIdx + 2]).toBe(255); // B
      expect(decoded[bottomLeftIdx + 3]).toBe(255); // A

      // Bottom-right (white)
      const bottomRightIdx = (width + 1) * 4;
      expect(decoded[bottomRightIdx]).toBe(255); // R
      expect(decoded[bottomRightIdx + 1]).toBe(255); // G
      expect(decoded[bottomRightIdx + 2]).toBe(255); // B
      expect(decoded[bottomRightIdx + 3]).toBe(255); // A
    });

    it('should handle resize parameters correctly', async () => {
      // Simple test to verify resize functionality works
      const width = 2;
      const height = 2;
      const channels = 4;
      const frameData = new Uint8Array(width * height * channels);

      // Fill with solid color for simple verification
      frameData.fill(100); // Gray color
      for (let i = 3; i < frameData.length; i += 4) {
        frameData[i] = 255; // Full alpha
      }

      const videoFrame = new VideoFrame(frameData, width, height, VideoBufferType.RGBA);

      const imageContent: ImageContent = {
        id: 'test-id',
        type: 'image_content',
        image: videoFrame,
        inferenceDetail: 'auto',
        inferenceWidth: 4,
        inferenceHeight: 4,
        _cache: {},
      };

      const result = await serializeImage(imageContent);

      // Decode and verify it was resized
      const imageBuffer = Buffer.from(result.base64Data!, 'base64');
      const decodedImage = await sharp(imageBuffer).raw().toBuffer({ resolveWithObject: true });

      expect(decodedImage.info.width).toBe(4);
      expect(decodedImage.info.height).toBe(4);

      // All pixels should still be gray (allowing small variation due to interpolation)
      const decodedData = decodedImage.data;
      for (let i = 0; i < decodedData.length; i += 4) {
        expect(decodedData[i]).toBeCloseTo(100, -1); // R
        expect(decodedData[i + 1]).toBeCloseTo(100, -1); // G
        expect(decodedData[i + 2]).toBeCloseTo(100, -1); // B
        expect(decodedData[i + 3]).toBe(255); // A
      }
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
