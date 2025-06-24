// This file was generated from JSON Schema using quicktype, do not modify it directly.
// The code generation lives at https://github.com/livekit/attribute-definitions
//
// To parse this data:
//
//   import { Convert, AgentAttributes, TranscriptionAttributes } from "./file";
//
//   const agentAttributes = Convert.toAgentAttributes(json);
//   const transcriptionAttributes = Convert.toTranscriptionAttributes(json);

export interface AgentAttributes {
  'lk.agent.inputs'?: AgentInput[];
  'lk.agent.outputs'?: AgentOutput[];
  'lk.agent.state'?: AgentState;
  'lk.publish_on_behalf'?: string;
  [property: string]: any;
}

export type AgentInput = 'audio' | 'video' | 'text';

export type AgentOutput = 'transcription' | 'audio';

export type AgentState = 'idle' | 'initializing' | 'listening' | 'thinking' | 'speaking';

/**
 * Schema for transcription-related attributes
 */
export interface TranscriptionAttributes {
  /**
   * The segment id of the transcription
   */
  'lk.segment_id'?: string;
  /**
   * The associated track id of the transcription
   */
  'lk.transcribed_track_id'?: string;
  /**
   * Whether the transcription is final
   */
  'lk.transcription_final'?: boolean;
  [property: string]: any;
}

// Converts JSON strings to/from your types
export class Convert {
  public static toAgentAttributes(attributes: Record<string, string>): AgentAttributes {
    const agentAttributes: AgentAttributes = {};
    for (const key in attributes) {
      const value = attributes[key];
      if (value !== undefined) {
        agentAttributes[key] = JSON.parse(value);
      }
    }
    return agentAttributes;
  }

  public static agentAttributesToRaw(attributes: AgentAttributes): Record<string, string> {
    const rawAttributes: Record<string, string> = {};
    for (const key in attributes) {
      rawAttributes[key] = JSON.stringify(attributes[key]);
    }
    return rawAttributes;
  }

  public static toTranscriptionAttributes(
    attributes: Record<string, string>,
  ): TranscriptionAttributes {
    const transcriptionAttributes: TranscriptionAttributes = {};
    for (const key in attributes) {
      const value = attributes[key];
      if (value !== undefined) {
        transcriptionAttributes[key] = JSON.parse(value);
      }
    }
    return transcriptionAttributes;
  }

  public static transcriptionAttributesToRaw(
    attributes: TranscriptionAttributes,
  ): Record<string, string> {
    const rawAttributes: Record<string, string> = {};
    for (const key in attributes) {
      rawAttributes[key] = JSON.stringify(attributes[key]);
    }
    return rawAttributes;
  }
}
