// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';
import type { ZodObject } from 'zod';
import { z } from 'zod';
import type { UnknownUserData } from '../voice/run_context.js';
import { FunctionCall, FunctionCallOutput, type ImageContent } from './chat_context.js';
import type { ToolContext, ToolExecutionOptions } from './tool_context.js';

export interface SerializedImage {
  inferenceDetail: 'auto' | 'high' | 'low';
  mimeType?: string;
  base64Data?: string;
  externalUrl?: string;
}

function getChannelsFromVideoBufferType(type: VideoBufferType): 3 | 4 {
  switch (type) {
    case VideoBufferType.RGBA:
    case VideoBufferType.ABGR:
    case VideoBufferType.ARGB:
    case VideoBufferType.BGRA:
      return 4;
    case VideoBufferType.RGB24:
      return 3;
    default:
      // YUV formats (I420, I420A, I422, I444, I010, NV12) need conversion
      throw new Error(`Unsupported VideoBufferType: ${type}. Only RGB/RGBA formats are supported.`);
  }
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
        channels: getChannelsFromVideoBufferType(image.image.type),
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

/** Raw OpenAI-adherent function parameters. */
export type OpenAIFunctionParameters = {
  type: 'object';
  properties: { [id: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  required: string[];
  additionalProperties?: boolean;
};

// TODO(brian): remove this helper once we have the real RunContext user data
export const createToolOptions = <UserData extends UnknownUserData>(
  toolCallId: string,
  userData: UserData = {} as UserData,
): ToolExecutionOptions<UserData> => {
  return { ctx: { userData }, toolCallId } as unknown as ToolExecutionOptions<UserData>;
};

// XXX: Zod is victim to the dual-package hazard. this is a hacky sorta-fix
// until Zod v4.0.0 is released.
// https://github.com/colinhacks/zod/issues/2241#issuecomment-2142688925
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const looksLikeInstanceof = <T>(value: unknown, target: new (...args: any[]) => T): value is T => {
  let current = value?.constructor;
  do {
    if (current?.name === target.name) return true;
    // eslint-disable-next-line @typescript-eslint/ban-types
    current = Object.getPrototypeOf(current) as Function;
  } while (current?.name);
  return false;
};

/** @internal */
export const oaiParams = (p: ZodObject<any>): OpenAIFunctionParameters => {
  const properties: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const requiredProperties: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processZodType = (field: z.ZodTypeAny): any => {
    const isOptional = field instanceof z.ZodOptional;
    const nestedField = isOptional ? field._def.innerType : field;
    const description = field._def.description;

    if (looksLikeInstanceof(nestedField, z.ZodEnum)) {
      return {
        type: typeof nestedField._def.values[0],
        ...(description && { description }),
        enum: nestedField._def.values,
      };
    } else if (looksLikeInstanceof(nestedField, z.ZodArray)) {
      const elementType = nestedField._def.type;
      return {
        type: 'array',
        ...(description && { description }),
        items: processZodType(elementType),
      };
    } else if (looksLikeInstanceof(nestedField, z.ZodObject)) {
      const { properties, required } = oaiParams(nestedField);
      return {
        type: 'object',
        ...(description && { description }),
        properties,
        required,
      };
    } else {
      let type = nestedField._def.typeName.toLowerCase();
      type = type.includes('zod') ? type.substring(3) : type;
      return {
        type,
        ...(description && { description }),
      };
    }
  };

  for (const key in p.shape) {
    const field = p.shape[key];
    properties[key] = processZodType(field);

    if (!(field instanceof z.ZodOptional)) {
      requiredProperties.push(key);
    }
  }

  const type = 'object' as const;
  return {
    type,
    properties,
    required: requiredProperties,
  };
};

/** @internal */
export const oaiBuildFunctionInfo = (
  toolCtx: ToolContext,
  toolCallId: string,
  toolName: string,
  rawArgs: string,
): FunctionCall => {
  const tool = toolCtx[toolName];
  if (!tool) {
    throw new Error(`AI tool ${toolName} not found`);
  }

  return FunctionCall.create({
    callId: toolCallId,
    name: toolName,
    args: rawArgs,
  });
};

export async function executeToolCall(
  toolCall: FunctionCall,
  toolCtx: ToolContext,
): Promise<FunctionCallOutput> {
  const tool = toolCtx[toolCall.name]!;
  let args: object | undefined;
  let params: object | undefined;

  // Ensure valid JSON
  try {
    args = JSON.parse(toolCall.args);
  } catch (error) {
    return FunctionCallOutput.create({
      callId: toolCall.callId,
      output: `Invalid JSON: ${error}`,
      isError: true,
    });
  }

  // Ensure valid arguments schema
  try {
    params = tool.parameters.parse(args);
  } catch (error) {
    return FunctionCallOutput.create({
      callId: toolCall.callId,
      output: `Arguments parsing failed: ${error}`,
      isError: true,
    });
  }

  try {
    const result = await tool.execute(params, createToolOptions(toolCall.callId));
    return FunctionCallOutput.create({
      callId: toolCall.callId,
      output: JSON.stringify(result),
      isError: false,
    });
  } catch (error) {
    return FunctionCallOutput.create({
      callId: toolCall.callId,
      output: `Tool execution failed: ${error}`,
      isError: true,
    });
  }
}
