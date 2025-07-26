import { getLiveKitCredentialsFromRequest } from '@/lib/utils';
import { AccessToken, AccessTokenOptions, VideoGrant } from 'livekit-server-sdk';
import { NextResponse } from 'next/server';

export type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantToken: string;
};

export async function POST(request: Request) {
  try {
    const req = await request.json();
    const { roomName, userId } = req;
    const { API_KEY, API_SECRET, LIVEKIT_URL } = await getLiveKitCredentialsFromRequest(req);

    if (!roomName || !userId) {
      throw new Error('Missing roomName or userId parameters');
    }

    // Generate participant token with provided values
    const participantToken = await createParticipantToken(
      { identity: userId },
      roomName,
      API_KEY,
      API_SECRET,
    );

    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantToken,
    };

    return NextResponse.json(data, { headers: new Headers({ 'Cache-Control': 'no-store' }) });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  apiKey: string,
  apiSecret: string,
) {
  const at = new AccessToken(apiKey, apiSecret, {
    ...userInfo,
    ttl: '60m',
  });

  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };

  at.addGrant(grant);
  return at.toJwt();
}
