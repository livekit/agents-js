// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Agent, AgentSession, VADEventType, stt, voice } from '@livekit/agents';
import { expect, it, vi } from 'vitest';
import type {
  AudioRecognition,
  RecognitionHooks,
} from '../../../agents/dist/voice/audio_recognition.js';
import { STT } from './stt.js';
import * as bridge from './stt_sdk.js';
import { Detector, deferred, provider } from './stt_test_helpers.js';

interface RecognitionInternals {
  onSTTEvent(event: stt.SpeechEvent): Promise<void>;
  hooks: RecognitionHooks;
  speaking: boolean;
  audioTranscript: string;
}

for (const contract of ['revised_hypotheses', 'append_fragments'] as const) {
  for (const secondFinishesFirst of [false, true]) {
    for (const commitBetweenEvents of [false, true]) {
      it(`real AgentSession/AudioRecognition: ${contract}, second first=${secondFinishesFirst}, commit between=${commitBetweenEvents}`, async () => {
        const release = [deferred(), deferred()];
        const uploaded = [deferred(), deferred()];
        const mock = provider(async function* (self) {
          const index = mock.streams.indexOf(self);
          const text = index ? 'second' : 'first';
          for await (const _chunk of self.chunks())
            yield self.options.outputContract === 'append_fragments'
              ? { kind: 'delta', text }
              : { kind: 'partial', text };
          uploaded[index]!.resolve();
          await self.wait(release[index]!.promise);
          yield { kind: 'final', text, language: 'en' };
        });
        const loader = vi.spyOn(bridge, 'loadSDK').mockResolvedValue(mock.module);
        const detector = new Detector();
        const owner = new STT({
          apiKey: 'test-key',
          vad: detector,
          outputContract: contract,
          connOptions: { timeoutMs: 3000 },
        });
        owner.on('error', () => {});
        const session = new AgentSession({
          vad: null,
          stt: new stt.testing.FakeSTT(),
          llm: new voice.testing.FakeLLM(),
          turnHandling: {
            turnDetection: 'stt',
            endpointing: { minDelay: 0, maxDelay: 0 },
            interruption: { mode: 'vad' },
          },
        });
        const agent = new Agent({ instructions: 'Testing speech order.' });
        let stream: stt.SpeechStream | undefined;
        let reader: Promise<void> | undefined;
        try {
          await session.start({ agent });
          const recognition = (
            session as unknown as { activity: { audioRecognition: AudioRecognition } }
          ).activity.audioRecognition;
          const internal = recognition as unknown as RecognitionInternals;
          const turns: string[] = [];
          const finals: string[] = [];
          vi.spyOn(internal.hooks, 'onEndOfTurn').mockImplementation(async (info) => {
            turns.push(info.newTranscript);
            return true;
          });
          vi.spyOn(internal.hooks, 'onFinalTranscript').mockImplementation((event) => {
            finals.push(event.alternatives![0].text);
          });
          stream = owner.stream();
          const observed: stt.SpeechEvent[] = [];
          reader = (async () => {
            for await (const event of stream!) {
              observed.push(event);
              await internal.onSTTEvent(event);
              if (commitBetweenEvents && event.type === stt.SpeechEventType.END_OF_SPEECH)
                await recognition.waitForEndOfTurnTask();
            }
          })();
          await vi.waitFor(() => expect(detector.streams).toHaveLength(1));
          const vad = detector.streams[0]!;
          for (let i = 0; i < 2; i++) {
            await vad.send(VADEventType.START_OF_SPEECH);
            await vad.send(VADEventType.END_OF_SPEECH);
            await uploaded[i]!.promise;
          }
          stream.endInput();
          if (secondFinishesFirst) {
            release[1]!.resolve();
            await vi.waitFor(() => expect(mock.streams[1]!.closed).toBe(true));
          }
          release[0]!.resolve();
          if (!secondFinishesFirst) {
            await vi.waitFor(() => expect(observed.filter((e) => e.type === 0)).toHaveLength(2));
            expect(internal.speaking).toBe(true);
            release[1]!.resolve();
          }
          await reader;
          await recognition.waitForEndOfTurnTask();
          expect(finals).toEqual(['first', 'second']);
          expect(turns.join(' ')).toBe('first second');
          expect(internal.audioTranscript).toBe('');
          if (commitBetweenEvents) expect(turns).toEqual(['first', 'second']);
          expect(observed.filter((e) => [0, 2, 3].includes(e.type)).map((e) => e.type)).toEqual([
            0, 2, 3, 0, 2, 3,
          ]);
        } finally {
          await owner.close();
          await reader;
          await session.close();
          loader.mockRestore();
        }
      });
    }
  }
}
