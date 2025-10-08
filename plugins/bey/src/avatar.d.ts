import type { APIConnectOptions } from '@livekit/agents';
import { type AgentSession } from '@livekit/agents';
import { type Room } from '@livekit/rtc-node';

export declare class BeyException extends Error {
  constructor(message: string);
}
export interface AvatarSessionOptions {
  avatarId?: string | null;
  apiUrl?: string;
  apiKey?: string;
  avatarParticipantIdentity?: string;
  avatarParticipantName?: string;
  connOptions?: APIConnectOptions;
}
export interface StartOptions {
  livekitUrl?: string;
  livekitApiKey?: string;
  livekitApiSecret?: string;
}
/**
 * A Beyond Presence avatar session
 */
export declare class AvatarSession {
  #private;
  private avatarId;
  private apiUrl;
  private apiKey;
  private avatarParticipantIdentity;
  private avatarParticipantName;
  private connOptions;
  constructor(options?: AvatarSessionOptions);
  start(agentSession: AgentSession, room: Room, options?: StartOptions): Promise<void>;
  private startAgent;
}
//# sourceMappingURL=avatar.d.ts.map
