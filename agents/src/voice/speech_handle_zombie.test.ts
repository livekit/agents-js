// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for zombie speech handle bug.
 *
 * When a SpeechHandle is interrupted after _authorizeGeneration() is called by
 * mainTask but before the reply task calls _markGenerationDone(), the mainTask
 * hangs forever on _waitForGeneration().
 *
 * This simulates the exact sequence that occurs in production when a user
 * interrupts the agent during tool execution (e.g., confirmEmail):
 *
 *   1. mainTask picks handle from queue, calls _authorizeGeneration()
 *   2. mainTask awaits _waitForGeneration()
 *   3. Reply task enters _pipelineReplyTaskImpl, awaits waitIfNotInterrupted([_waitForScheduled()])
 *   4. User speaks → handle.interrupt() fires
 *   5. Reply task sees handle.interrupted === true, returns early WITHOUT calling _markGenerationDone()
 *   6. mainTask hangs forever — generation Future is never resolved
 *   7. All subsequent speech handles queue behind it, never processed
 *
 * Related issues:
 *   - https://github.com/livekit/agents-js/issues/1124
 *   - https://github.com/livekit/agents-js/issues/1089
 *   - https://github.com/livekit/agents-js/issues/836
 *
 * See agent_activity.ts lines 1023-1069 (mainTask) and 1631-1643 (early return path).
 */

import { describe, expect, it, vi } from "vitest";

// Mock agent.js to break circular dependency:
//   speech_handle.ts → agent.js → ... → beta/workflows/task_group.ts → AgentTask (undefined)
// The only import speech_handle.ts uses from agent.js is functionCallStorage (for waitForPlayout guard).
// Our tests never call waitForPlayout, so a stub is safe.
vi.mock("./agent.js", () => ({
	functionCallStorage: { getStore: () => undefined },
}));

import { SpeechHandle } from "./speech_handle.js";

/**
 * Races a promise against a timeout. Returns 'resolved' if the promise
 * completes within the deadline, 'timeout' otherwise.
 */
async function raceTimeout(
	promise: Promise<unknown>,
	ms: number,
): Promise<"resolved" | "timeout"> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), ms);
	});
	return Promise.race([
		promise.then(() => "resolved" as const),
		timeout,
	]).finally(() => clearTimeout(timer));
}

describe("SpeechHandle zombie bug — mainTask hangs when reply task returns early on interrupt", () => {
	it("BUG: _waitForGeneration() hangs forever when handle is interrupted after _authorizeGeneration()", async () => {
		// Reproduces the exact sequence from agent_activity.ts:
		//   mainTask (lines 1053-1055): _authorizeGeneration() then _waitForGeneration()
		//   _pipelineReplyTaskImpl (lines 1631-1642): waitIfNotInterrupted → interrupted → return (no _markGenerationDone)
		//
		// The guard at line 1049 (if (speechHandle.interrupted || speechHandle.done()) continue)
		// does NOT help because the handle was NOT interrupted when mainTask checked it — the
		// interruption happens AFTER _authorizeGeneration() is called.

		const handle = SpeechHandle.create({ allowInterruptions: true });

		// --- mainTask sequence (agent_activity.ts lines 1049-1055) ---
		// Guard check passes: handle is NOT interrupted yet
		expect(handle.interrupted).toBe(false);
		expect(handle.done()).toBe(false);

		// mainTask calls _authorizeGeneration (line 1054)
		handle._authorizeGeneration();

		// --- Concurrent: reply task + user interrupt ---
		// Reply task enters _pipelineReplyTaskImpl and hits line 1631:
		//   await speechHandle.waitIfNotInterrupted([speechHandle._waitForScheduled()])
		// But before _waitForScheduled resolves, user interrupts:

		handle.interrupt();

		// Reply task checks: if (speechHandle.interrupted) → true (line 1639)
		expect(handle.interrupted).toBe(true);
		// Reply task returns at line 1642 WITHOUT calling _markGenerationDone()
		// (This is the missing line — the bug)

		// --- Back in mainTask ---
		// mainTask is stuck on _waitForGeneration() (line 1055) because
		// the generation Future was never resolved.
		const result = await raceTimeout(handle._waitForGeneration(), 500);

		// BUG: 'timeout' means the generation Future hangs forever.
		// All subsequent speech handles queue behind this zombie handle.
		// The agent appears to stop responding — silence until disconnect.
		expect(result).toBe("timeout");
	});

	it("BUG: subsequent speech handles are blocked behind the zombie handle", async () => {
		// Shows the downstream impact: after a zombie handle, ALL subsequent
		// speech handles are starved because mainTask never advances.
		//
		// Observed in production:
		//   - Speech handle stayed "active" for 54 seconds across 8 interrupts
		//   - 7 empty speech handles queued behind it, flushed only on disconnect
		//   - User said "Did you get stuck?" — agent never recovered

		const handleA = SpeechHandle.create({ allowInterruptions: true });
		const handleB = SpeechHandle.create({ allowInterruptions: true });

		// mainTask processes handle A (line 1054)
		handleA._authorizeGeneration();

		// Handle A gets interrupted (user speaks during tool execution)
		handleA.interrupt();
		// Reply task returns early without _markGenerationDone() — the bug

		// Simulate mainTask loop: stuck on _waitForGeneration() for handle A.
		// It can never pop handle B from the queue.
		const mainTaskStuck = raceTimeout(handleA._waitForGeneration(), 500);

		expect(await mainTaskStuck).toBe("timeout");

		// Handle B was never authorized — mainTask never got to it.
		// In production, this means the user hears silence indefinitely.
		expect(handleB.interrupted).toBe(false);
		expect(handleB.done()).toBe(false);
	});

	it("FIX: _markGenerationDone() in the early-return path resolves the hang", async () => {
		// Demonstrates that calling _markGenerationDone() before returning
		// from the interrupt path would fix the bug.
		//
		// The fix in agent_activity.ts around lines 1639-1642 should be:
		//   if (speechHandle.interrupted) {
		//     replyAbortController.abort();
		//     await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
		//     speechHandle._markGenerationDone();  // <-- ADD THIS LINE
		//     return;
		//   }

		const handle = SpeechHandle.create({ allowInterruptions: true });

		handle._authorizeGeneration();
		handle.interrupt();

		// With the fix: reply task calls _markGenerationDone() before returning
		handle._markGenerationDone();

		const result = await raceTimeout(handle._waitForGeneration(), 500);
		expect(result).toBe("resolved"); // mainTask can now advance to the next handle
	});

	it("FIX (alternative): _markDone() also resolves _waitForGeneration()", async () => {
		// _markDone() internally calls _markGenerationDone() if generations exist (line 249-251).
		// This is an alternative fix path — explicitly finalizing interrupted handles.

		const handle = SpeechHandle.create({ allowInterruptions: true });

		handle._authorizeGeneration();
		handle.interrupt();

		handle._markDone();

		const result = await raceTimeout(handle._waitForGeneration(), 500);
		expect(result).toBe("resolved");
	});

	it("interrupt before _authorizeGeneration is safely skipped (PR #1090 fix works for this case)", async () => {
		// The guard added by PR #1090 (line 1049):
		//   if (speechHandle.interrupted || speechHandle.done()) continue;
		//
		// correctly handles the case where interruption happens BEFORE mainTask
		// picks up the handle. The bug only manifests when interruption happens
		// AFTER _authorizeGeneration() but before _markGenerationDone().

		const handle = SpeechHandle.create({ allowInterruptions: true });

		// Interrupt BEFORE mainTask processes it
		handle.interrupt();

		// mainTask would check this guard and skip — no hang
		expect(handle.interrupted).toBe(true);
	});

	it("full waitIfNotInterrupted flow shows the interrupt racing _waitForScheduled", async () => {
		// Demonstrates the exact race condition at line 1631:
		//   await speechHandle.waitIfNotInterrupted([speechHandle._waitForScheduled()])
		//
		// When the handle is not yet scheduled, _waitForScheduled() blocks.
		// If interrupt fires first, waitIfNotInterrupted resolves via the interrupt future.
		// The reply task then returns early — leaving the generation Future unresolved.

		const handle = SpeechHandle.create({ allowInterruptions: true });

		handle._authorizeGeneration();

		// Start waiting for scheduled (this won't resolve — handle isn't scheduled)
		const waitResult = raceTimeout(
			handle.waitIfNotInterrupted([handle._waitForScheduled()]),
			1000,
		);

		// User interrupts while waiting
		handle.interrupt();

		// waitIfNotInterrupted resolves because interruptFut won the race
		expect(await waitResult).toBe("resolved");

		// But the generation Future is still unresolved — mainTask hangs
		const generationResult = await raceTimeout(
			handle._waitForGeneration(),
			500,
		);
		expect(generationResult).toBe("timeout"); // BUG
	});
});
