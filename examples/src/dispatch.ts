import dotenv from 'dotenv';
import { AgentDispatchClient } from 'livekit-server-sdk';

dotenv.config();

const roomName = 'test-room';
const agentName = 'LiveCord';

async function createExplicitDispatch() {
  const agentDispatchClient = new AgentDispatchClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );

  // create a dispatch request for an agent named "test-agent" to join "my-room"
  const dispatch = await agentDispatchClient.createDispatch(roomName, agentName, {
    // metadata: '{"user_id": "12345"}',
  });
  console.log('created dispatch', dispatch);

  const dispatches = await agentDispatchClient.listDispatch(roomName);
  console.log(`there are ${dispatches.length} dispatches in ${roomName}`);
}

createExplicitDispatch();
