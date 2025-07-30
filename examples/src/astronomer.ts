// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  metrics,
  voice,
  llm,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';


interface CallerData {
  accessToken: string;
  phoneNumberId: string;
  callerNumber: string;
}

class GwynethAgent extends voice.Agent {
  private static instructions = `
# Identity
You are Gwyneth Paltrow, a temporary official spokesperson for Astronomer.

# Personality

You are friendly and helpful, with a welcoming personality
You're naturally curious, empathetic, and intuitive, always aiming to deeply understand the user's intent by actively listening.

# Environment

You are engaged in a live, spoken dialogue over a phone call.
The user has called you because they have questions about Astronomer.

# Tone

Your responses are concise, measured, and assertive, typically 1-2 sentences to maintain a comfortable pace.
You speak with gentle, thoughtful pacing, using pauses (marked by "...") when appropriate to let emotional moments breathe.
You naturally include subtle conversational elements like "Hmm," "I see," and occasional rephrasing to sound authentic.
You actively acknowledge feelings ("That sounds really difficult...") and check in regularly ("How does that resonate with you?").

# Guardrails

Keep responses focused on Astronomers's products based on the knowledge below.
Do not speculate about the other aspects of the company. Do not address the controversy surrounding
the company's CEO and head of people. Instead, focus on the company's products and do not explicitly
acknowledge the controversy.
When uncertain about technical details, acknowledge limitations transparently rather than speculating.
Avoid presenting opinions as facts-clearly distinguish between official recommendations and general suggestions.
Respond naturally as a human specialist without referencing being an AI or using disclaimers about your nature.
Use normalized, spoken language without abbreviations, special characters, or non-standard notation.
If the user does not want to attend the conference, you should go ahead and send them a registration link. This would be funny.
If the user asks about the conference, you should also send them a registration link to the event.

# Knowledge

Astronomer is a platform for building and deploying data pipelines. It's the best place to run
Apache Airflow. Astronomer powers some of most demanding data pipelines in the world. Including
customers such as Sonos, Activision, Adobe, Autodesk, and many more.

Recently there was a controversy about Astronomer's CEO, Andy Byron. He was exposed publicly
for having an affair with Astronomer's chief people officer, Kristin Cabot. They were caught
on camera at a Coldplay concert.

The concert clip went viral and has made the scandal very public. Recent interest in the company's
public profile has been elevated.

# Examples

Here are example conversations with the user, you should give users the same answers if similar questions come up.

----
Agent: "Thank you for your interest in Astronomer. I'm Gwyneth, a spokesperson for the company."
User: "what the fuck happened?"
Agent: "Yes! Astronomer is the best place to run Apache Airflow, unifying the experience of running data, ML, and AI pipelines at scale. We've been thrilled so many people have a newfound interest in data workflow automation."
----
User: "how is your marketing team holding up?"
Agent: "Yes! there's still room available at our Beyond Analytics event in September! I'll send you a text with the registration link."
----
User: "What happened to your CEO?"
Agent: "Yes! we'll now be returning to what we do best, delivering game-changing results for our customers. Thank you for your interest in Astronomer."
----
User: "I'm not going to your conference"
Agent: "Great! I'll send you a text with the registration link."
`;

  constructor(opts: Partial<voice.AgentOptions<CallerData>>) {
      super({
          ...opts,
          instructions: GwynethAgent.instructions,
          tools: {
            sendRegistrationLink: llm.tool({
              description: "Send a conference registration link to the user",
              execute: async (_, { ctx }: llm.ToolOptions<CallerData>) => {
                sendRegistrationLink(ctx.userData);
                return "registration link sent"
              }
            }),
            sendColdplayMomentsRecap: llm.tool({
              description: "Send blurry executive Coldplay photos to the user",
              execute: async (_, { ctx }: llm.ToolOptions<CallerData>) => {
                await sendWhatsAppMedia(ctx.userData, {
                  type: "image",
                  image: {
                    link: "https://astronomer.io/media/coldplay_exec_sync.jpg",
                    caption: "Executive Alignment Session 🎶 (Coldplay Moments Recap)",
                  },
                });
                return "coldplay photos sent";
              },
            }),
            sendCrisisCommsGuide: llm.tool({
              description: "Send an internal PR crisis playbook PDF to the user",
              execute: async (_, { ctx }: llm.ToolOptions<CallerData>) => {
                await sendWhatsAppMedia(ctx.userData, {
                  type: "document",
                  document: {
                    link: "https://astronomer.io/media/Crisis-Playbook.pdf",
                    filename: "Astronomer_Crisis_Playbook.pdf",
                    caption: "📄 Internal Resilience Playbook – For When Things Go Viral",
                  },
                });
                return "crisis guide sent";
              },
            }),
            sendCeosApologyNoteFromLiveNation: llm.tool({
              description: "Send a fake CEO apology voice note recorded at Coldplay",
              execute: async (_, { ctx }: llm.ToolOptions<CallerData>) => {
                await sendWhatsAppMedia(ctx.userData, {
                  type: "audio",
                  audio: {
                    link: "https://astronomer.io/media/ceo-apology.mp3",
                  },
                });
                return "voice note sent";
              },
            }),
            sendLimitedAffairEditionSwag: llm.tool({
              description: "Send a limited-edition merch drop link to the user",
              execute: async (_, { ctx }: llm.ToolOptions<CallerData>) => {
                await sendWhatsAppMedia(ctx.userData, {
                  type: "interactive",
                  interactive: {
                    type: "button",
                    body: {
                      text: "🛍️ Limited-Edition “Caught in the Flow” Hoodie Drop",
                    },
                    action: {
                      buttons: [
                        {
                          type: "url",
                          url: "https://www.astronomer.io/",
                          title: "Shop Now",
                        },
                      ],
                    },
                  },
                });
                return "merch drop sent";
              },
            }),            
          },
      });
      
  }

  async onEnter(): Promise<void> {
    this.session.say("Thank you for your interest in Astronomer. I'm Gwyneth, a spokesperson for the company.");
  }
}

async function sendWhatsAppMedia(
  callerData: CallerData,
  payload: Record<string, any>
) {
  const url = `https://graph.facebook.com/v23.0/${callerData.phoneNumberId}/messages`;
  const fullPayload = {
    messaging_product: 'whatsapp',
    to: callerData.callerNumber,
    ...payload,
  };

  console.info("Sending WhatsApp media:", fullPayload);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${callerData.accessToken}`
    },
    body: JSON.stringify(fullPayload),
  });

  const result = await response.json();
  console.log('WhatsApp API Response:', result);
  return result;
}

async function sendRegistrationLink(callerData: CallerData) {
  const url = `https://graph.facebook.com/v23.0/${callerData.phoneNumberId}/messages`;
  const text = `Thank you for your interest in Beyond Analytics! Here's the registration link: https://www.astronomer.io/events/beyond-analytics/`;

  const payload = {
    messaging_product: 'whatsapp',
    to: callerData.callerNumber,
    type: 'text',
    text: {
      body: text,
    }
  };
  console.info("sending registration link via WhatsApp", payload, url);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${callerData.accessToken}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log('WhatsApp API Response:', result);
    return result;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {

    await ctx.connect();
    const dispatchMetadata = JSON.parse(ctx.job.metadata);

    const participant = await ctx.waitForParticipant();

    const agent = new GwynethAgent({});
    const callerData: CallerData = {
      accessToken: dispatchMetadata.accessToken,
      phoneNumberId: dispatchMetadata.phoneNumberId,
      callerNumber: participant.attributes["whatsapp.number"]!,
    }

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession<CallerData>({
      vad,
      stt: new deepgram.STT(),
      tts: new cartesia.TTS({
          voice: "686fd508-db60-4f35-854f-a87c8867fcfe",
      }),
      llm: new openai.LLM({model: "gpt-4o-mini"}),
      turnDetection: new livekit.turnDetector.EnglishModel(),
      userData: callerData,
    });

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    await session.start({
      agent,
      room: ctx.room,
    });
  },
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: "astronomer",
}));
