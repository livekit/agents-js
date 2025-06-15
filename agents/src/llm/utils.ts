import { VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import type { ImageContent } from './chat_context.js';

export interface SerializedImage {
  inferenceDetail: 'auto' | 'high' | 'low';
  mimeType?: string;
  base64Data?: string;
  externalUrl?: string;
}

export async function serializeImage(image: ImageContent): Promise<SerializedImage> {
  if (typeof image.image === 'string') {
    if (image.image.startsWith('data:')) {
      const [header, base64Data] = image.image.split(',', 2) as [string, string];
      const headerParts = header.split(';');
      const mimeParts = headerParts[0]?.split(':');
      const headerMime = mimeParts?.[1];

      if (!headerMime) {
        throw new Error('Invalid data URL format');
      }

      let mimeType: string;
      if (image.mimeType && image.mimeType !== headerMime) {
        console.warn(
          `Provided mimeType '${image.mimeType}' does not match data URL mime type '${headerMime}'. Using provided mimeType.`,
        );
        mimeType = image.mimeType;
      } else {
        mimeType = headerMime;
      }

      const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
      if (!supportedTypes.has(mimeType)) {
        throw new Error(`Unsupported mimeType ${mimeType}. Must be jpeg, png, webp, or gif`);
      }

      return {
        base64Data,
        mimeType: mimeType,
        inferenceDetail: image.inferenceDetail,
      };
    }

    // External URL
    return {
      mimeType: image.mimeType,
      inferenceDetail: image.inferenceDetail,
      externalUrl: image.image,
    };
  } else if (image.image instanceof VideoFrame) {
    // Sharp needs to know the format of raw pixel data
    let encoded = sharp(Buffer.from(image.image.data), {
      raw: {
        width: image.image.width,
        height: image.image.height,
        channels: 4, // RGBA
      },
    });

    if (image.inferenceWidth && image.inferenceHeight) {
      encoded = encoded.resize(image.inferenceWidth, image.inferenceHeight);
    }

    const base64Data = await encoded
      .png()
      .toBuffer()
      .then((buffer) => buffer.toString('base64'));

    return {
      base64Data,
      mimeType: 'image/png',
      inferenceDetail: image.inferenceDetail,
    };
  } else {
    throw new Error('Unsupported image type');
  }
}
