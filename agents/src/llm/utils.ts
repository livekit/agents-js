// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import type { JSONSchema7 } from 'json-schema';
import sharp from 'sharp';
import type { UnknownUserData } from '../voice/run_context.js';
import type { ChatContext } from './chat_context.js';
import {
  type ChatItem,
  FunctionCall,
  FunctionCallOutput,
  type ImageContent,
} from './chat_context.js';
import type { ToolContext, ToolInputSchema, ToolOptions } from './tool_context.js';
import { isZodSchema, parseZodSchema, zodSchemaToJsonSchema } from './zod-utils.js';

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

function ensureRGBCompatible(frame: VideoFrame): VideoFrame {
  // If the frame is already in an RGB/RGBA-compatible format, return it directly
  if (
    frame.type === VideoBufferType.RGBA ||
    frame.type === VideoBufferType.BGRA ||
    frame.type === VideoBufferType.ARGB ||
    frame.type === VideoBufferType.ABGR ||
    frame.type === VideoBufferType.RGB24
  ) {
    return frame;
  }

  // Otherwise, attempt conversion for other formats (like YUV)
  try {
    return frame.convert(VideoBufferType.RGBA);
  } catch (error) {
    throw new Error(
      `Failed to convert format ${frame.type} to RGB: ${error}. ` +
        `Consider using RGB/RGBA formats or converting on the client side.`,
    );
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
    const frame = ensureRGBCompatible(image.image);
    const channels = getChannelsFromVideoBufferType(frame.type);

    // Sharp needs to know the format of raw pixel data
    let encoded = sharp(frame.data, {
      raw: {
        width: frame.width,
        height: frame.height,
        channels,
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
): ToolOptions<UserData> => {
  return { ctx: { userData }, toolCallId } as unknown as ToolOptions<UserData>;
};

/** @internal */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const oaiParams = (schema: any, isOpenai: boolean = true): OpenAIFunctionParameters => {
  // Adapted from https://github.com/vercel/ai/blob/56eb0ee9/packages/provider-utils/src/zod-schema.ts
  const jsonSchema = zodSchemaToJsonSchema(schema, isOpenai);
  const { properties, required, additionalProperties } = jsonSchema as OpenAIFunctionParameters;

  return {
    type: 'object',
    properties,
    required,
    additionalProperties,
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
    if (isZodSchema(tool.parameters)) {
      const result = await parseZodSchema<object>(tool.parameters, args);
      if (result.success) {
        params = result.data;
      } else {
        return FunctionCallOutput.create({
          callId: toolCall.callId,
          output: `Arguments parsing failed: ${result.error}`,
          isError: true,
        });
      }
    } else {
      params = args;
    }
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

/**
 * Standard dynamic-programming LCS to get the common subsequence
 * of IDs (in order) that appear in both old_ids and new_ids.
 *
 * @param oldIds - The old list of IDs.
 * @param newIds - The new list of IDs.
 * @returns The longest common subsequence of the two lists of IDs.
 */
function computeLCS(oldIds: string[], newIds: string[]): string[] {
  const n = oldIds.length;
  const m = newIds.length;
  const dp: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  // Fill DP table
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldIds[i - 1] === newIds[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to find the actual LCS sequence
  const lcsIds: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldIds[i - 1] === newIds[j - 1]) {
      lcsIds.push(oldIds[i - 1]!);
      i--;
      j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return lcsIds.reverse();
}

interface DiffOps {
  toRemove: string[];
  toCreate: Array<[string | null, string]>; // (previous_item_id, id), if previous_item_id is null, add to the root
}

/**
 * Compute the minimal list of create/remove operations to transform oldCtx into newCtx.
 *
 * @param oldCtx - The old chat context.
 * @param newCtx - The new chat context.
 * @returns The minimal list of create/remove operations to transform oldCtx into newCtx.
 */
export function computeChatCtxDiff(oldCtx: ChatContext, newCtx: ChatContext): DiffOps {
  const oldIds = oldCtx.items.map((item: ChatItem) => item.id);
  const newIds = newCtx.items.map((item: ChatItem) => item.id);
  const lcsIds = new Set(computeLCS(oldIds, newIds));

  const toRemove = oldCtx.items.filter((msg) => !lcsIds.has(msg.id)).map((msg) => msg.id);
  const toCreate: Array<[string | null, string]> = [];

  let lastIdInSequence: string | null = null;
  for (const newItem of newCtx.items) {
    if (lcsIds.has(newItem.id)) {
      lastIdInSequence = newItem.id;
    } else {
      const prevId = lastIdInSequence; // null if root
      toCreate.push([prevId, newItem.id]);
      lastIdInSequence = newItem.id;
    }
  }

  return {
    toRemove,
    toCreate,
  };
}

export function toJsonSchema(
  schema: ToolInputSchema<any>,
  isOpenai: boolean = true,
  strict: boolean = false,
): JSONSchema7 {
  if (isZodSchema(schema)) {
    return zodSchemaToJsonSchema(schema, isOpenai, strict);
  }

  return schema as JSONSchema7;
}
