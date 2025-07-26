'use client';

import { LiveKitRoom } from "./livekit-room";

export const BasicRoomLayout = () => {
  // You can make these dynamic based on your needs
  const roomName = "demo-room";
  const userId = `user-${Math.random().toString(36).substr(2, 9)}`;

  const handleConnected = () => {
    console.log("Successfully connected to LiveKit room");
  };

  const handleDisconnected = () => {
    console.log("Disconnected from LiveKit room");
  };

  return (
    <div className="room-layout">
      <h1 className="text-2xl font-bold mb-4">LiveKit Voice Agent Demo</h1>
      <LiveKitRoom 
        roomName={roomName}
        userId={userId}
        onConnected={handleConnected}
        onDisconnected={handleDisconnected}
      />
    </div>
  );
};
