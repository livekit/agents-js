'use client';

import {
  LiveKitRoom as LiveKitRoomCore,
  RoomAudioRenderer,
  useConnectionState
} from '@livekit/components-react';
import '@livekit/components-styles';
import { useEffect, useState } from 'react';

interface ConnectionDetails {
  serverUrl: string;
  roomName: string;
  participantToken: string;
}

interface LiveKitRoomProps {
  roomName: string;
  userId: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

async function fetchToken(roomName: string, userId: string): Promise<ConnectionDetails> {
  const response = await fetch('/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      roomName,
      userId,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch token: ${response.statusText}`);
  }

  return response.json();
}

function ConnectionStatus() {
  const connectionState = useConnectionState();
  
  return (
    <div className="connection-status">
      Status: {connectionState}
    </div>
  );
}

export const LiveKitRoom = ({ 
  roomName, 
  userId, 
  onConnected, 
  onDisconnected 
}: LiveKitRoomProps) => {
  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getToken = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const details = await fetchToken(roomName, userId);
        setConnectionDetails(details);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch token';
        setError(errorMessage);
        console.error('Error fetching token:', err);
      } finally {
        setIsLoading(false);
      }
    };

    if (roomName && userId) {
      getToken();
    }
  }, [roomName, userId]);

  const handleConnected = () => {
    console.log('Connected to LiveKit room');
    onConnected?.();
  };

  const handleDisconnected = () => {
    console.log('Disconnected from LiveKit room');
    onDisconnected?.();
  };

  if (isLoading) {
    return (
      <div className="livekit-loading">
        <p>Connecting to room...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="livekit-error">
        <p>Error: {error}</p>
        <button 
          onClick={() => window.location.reload()}
          className="retry-button"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!connectionDetails) {
    return (
      <div className="livekit-error">
        <p>No connection details available</p>
      </div>
    );
  }

  return (
    <div className="livekit-room-container">
      <LiveKitRoomCore
        serverUrl={connectionDetails.serverUrl}
        token={connectionDetails.participantToken}
        connect={true}
        onConnected={handleConnected}
        onDisconnected={handleDisconnected}
        audio={true}
        video={true}
      >
        <ConnectionStatus />
        <RoomAudioRenderer />
        
        <div className="room-info">
          <p>Room: {connectionDetails.roomName}</p>
          <p>User: {userId}</p>
        </div>
      </LiveKitRoomCore>
    </div>
  );
}; 