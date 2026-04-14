// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AgentServer,
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import type { AgentSession } from 'agents/dist/voice/agent_session.js';
import { fetchWeatherForecast } from 'my-weather-api';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const server: AgentServer = createServer({
  port: process.env.PORT,
  worker: fileURLToPath(import.meta.url),
});

const myAgent = createAgent();

const weatherTool = createTool('getWeather', (toolCtx) => {
  return {
    description: 'Get the weather for a given location.',
    parameters: z.object({
      location: z.string().describe('The location to get the weather for'),
    }),
    execute: async ({ location }) => {
      const weatherPromise = fetchWeatherForecast({ location });
      await toolCtx.session.say('Fetching the weather for you');
      return weatherPromise;
    },
  };
});

const flightBooking = createTask<{
  start: string;
  desiredDestinations: string[];
  startDate: Date;
  endDate: Date;
}>('sunSeekerFlightBooking', async function* (taskCtx, state) {
  taskCtx.generateReply('help the user to book a flight to the sunniest destination');
  const availableFlights = await taskCtx.step(async () => {
    return searchForFlights(state.start, state.desiredDestinations, state.startDate, state.endDate);
  });

  const sunniestDestinations = await taskCtx.step(async () => {
    const sunshineMap = new Map<string, number>();
    for (const flight of availableFlights) {
      const forecast: Array<{ hoursOfSunshine: number; maxTemperature: number }> =
        await fetchWeatherForecast({
          location: flight.destination,
          startDate: state.startDate,
          endDate: state.endDate,
        });
      sunshineMap.set(
        flight.destination,
        forecast.reduce((accHoursOfSun, day) => {
          accHoursOfSun += day.hoursOfSunshine;
          return accHoursOfSun;
        }, 0),
      );
    }
    return Array.from(sunshineMap.entries()).sort((a, b) => a[1] - b[1]);
  });

  yield `The sunniest destination on your travel dates is ${sunniestDestinations[0]}, do you want to go there?`;
  await taskCtx.waitForApproval();
  yield `The following flights are available for ${sunniestDestinations[0]}`;
});

server.on('rtc', (jobContext: JobContext) => {});

// generic event registering for different endpoints, e.g. text mode
// .on(event, endpoint, handler)
server.on('text', 'weather', async (textMessageContext) => {
  const session: AgentSession = createSession({ llm: 'openai/gpt-4.1-mini' });

  // make tools available to the agent on demand, e.g. depending on the endpoint
  myAgent.updateTools(weatherTool);
  const startResult = session.start({ agent: myAgent });

  for await (const ev of startResult) {
    await textMessageContext.sendResponse(ev);
  }

  for await (const ev of session.run({ userInput: textMessageContext.text })) {
    await textMessageContext.sendResponse(ev);
  }
});

export default server;

cli.runApp(server);
