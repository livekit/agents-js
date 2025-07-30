import dotenv from 'dotenv';
import { AgentDispatchClient } from 'livekit-server-sdk';

dotenv.config();

const roomName = 'test-room';

async function createExplicitDispatch() {
  const agentDispatchClient = new AgentDispatchClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );

  // create a dispatch request for an agent named "test-agent" to join "my-room"
  const dispatches = await agentDispatchClient.listDispatch(roomName);

  for (const dispatch of dispatches) {
    await agentDispatchClient.deleteDispatch(dispatch.id, roomName);
  }
}

createExplicitDispatch();
