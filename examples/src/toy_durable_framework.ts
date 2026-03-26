// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Toy Durable Execution Framework
 *
 * Demonstrates how task() memoization + checkpoint/restore can provide durable
 * execution for multi-step tool handlers in LiveKit Agents JS.
 *
 * Key feature: **scoped counters** — each task() creates a child scope so that
 * nested tasks get their own counter namespace. When a parent replays from cache,
 * its inner tasks are never called and the parent's sibling counter stays correct.
 *
 * Inspired by:
 * - LangGraph JS: deterministic replay via scratchpad counters + AsyncLocalStorage
 * - Python LiveKit Agents: EffectCall serialization boundary + DurableScheduler
 *
 * Run: pnpm dlx tsx ./examples/src/toy_durable_framework.ts
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

interface Scratchpad {
  callCounter: number;
  scopePath: string;
  writeLog: Map<string, unknown>;
}

interface CheckpointData {
  entries: [string, unknown][];
}

interface CheckpointTreeNode {
  label: string;
  value: unknown;
  hasValue: boolean;
  children: Map<string, CheckpointTreeNode>;
}

// ---------------------------------------------------------------------------
// DurableEngine — manages checkpoint storage, drives execution with scratchpad
// ---------------------------------------------------------------------------

const durableStorage = new AsyncLocalStorage<Scratchpad>();

class DurableEngine {
  private writeLog = new Map<string, unknown>();

  /** Execute a workflow function with durable task() support. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const scratchpad: Scratchpad = {
      callCounter: 0,
      scopePath: '',
      writeLog: this.writeLog,
    };
    return durableStorage.run(scratchpad, fn);
  }

  /** Serialize the write log to a JSON string (the "checkpoint"). */
  checkpoint(): string {
    const data: CheckpointData = {
      entries: Array.from(this.writeLog.entries()),
    };
    return JSON.stringify(data);
  }

  /** Restore the write log from a previously saved checkpoint. */
  restore(json: string): void {
    const data: CheckpointData = JSON.parse(json);
    this.writeLog = new Map(data.entries);
  }

  /** Number of entries in the write log. */
  get size(): number {
    return this.writeLog.size;
  }
}

// ---------------------------------------------------------------------------
// task(name, fn) — replay-safe function wrapper with scoped counters
//
// Each task call consumes one counter slot in the current scope. When executing
// (cache miss), inner task() calls run in a child scope with its own counter,
// so the parent scope's counter is unaffected by nesting depth.
//
// Write log keys use the full scope path:
//   root level:  "extractEmail:0", "validate:1"
//   nested:      "outerTask:0/innerA:0", "outerTask:0/innerB:1"
// ---------------------------------------------------------------------------

function task<Args extends unknown[], Output>(
  name: string,
  fn: (...args: Args) => Promise<Output>,
): (...args: Args) => Promise<Output> {
  return async (...args: Args): Promise<Output> => {
    const parent = durableStorage.getStore();
    if (!parent) {
      throw new Error(`task("${name}") called outside of DurableEngine.run()`);
    }

    const index = parent.callCounter;
    parent.callCounter += 1;

    const key = parent.scopePath ? `${parent.scopePath}/${name}:${index}` : `${name}:${index}`;

    if (parent.writeLog.has(key)) {
      const cached = parent.writeLog.get(key) as Output;
      return cached;
    }

    const child: Scratchpad = {
      callCounter: 0,
      scopePath: key,
      writeLog: parent.writeLog,
    };

    const result = await durableStorage.run(child, () => fn(...args));
    parent.writeLog.set(key, result);
    return result;
  };
}

// ---------------------------------------------------------------------------
// Simulated side-effecting operations (would be LLM calls, APIs, etc.)
// ---------------------------------------------------------------------------

const extractEmail = task('extractEmail', async (text: string): Promise<string> => {
  await sleep(50);
  const match = text.match(/[\w.-]+@[\w.-]+/);
  return match ? match[0] : 'unknown@example.com';
});

const validateEmail = task('validateEmail', async (email: string): Promise<boolean> => {
  await sleep(50);
  return email.includes('@') && email.includes('.');
});

const submitRegistration = task(
  'submitRegistration',
  async (email: string): Promise<{ id: string; email: string }> => {
    await sleep(50);
    return { id: `reg_${Date.now()}`, email };
  },
);

// ---------------------------------------------------------------------------
// Nested tasks — demonstrate scoped counters
// ---------------------------------------------------------------------------

const geocodeAddress = task(
  'geocode',
  async (addr: string): Promise<{ lat: number; lng: number }> => {
    await sleep(30);
    return { lat: 37.7749, lng: -122.4194 };
  },
);

const fetchWeather = task('fetchWeather', async (lat: number, lng: number): Promise<string> => {
  await sleep(30);
  return `72°F, sunny at ${lat.toFixed(2)},${lng.toFixed(2)}`;
});

const enrichWithWeather = task(
  'enrichWithWeather',
  async (
    address: string,
  ): Promise<{ address: string; coords: { lat: number; lng: number }; weather: string }> => {
    const coords = await geocodeAddress(address);
    const weather = await fetchWeather(coords.lat, coords.lng);
    return { address, coords, weather };
  },
);

const notifyUser = task('notifyUser', async (msg: string): Promise<string> => {
  await sleep(20);
  return `notified: ${msg}`;
});

async function nestedWorkflow(address: string) {
  const enriched = await enrichWithWeather(address);
  const notification = await notifyUser(`Weather for ${address}: ${enriched.weather}`);
  return { enriched, notification };
}

// ---------------------------------------------------------------------------
// Flat workflow (no nesting) — multi-step tool handler
// ---------------------------------------------------------------------------

async function registrationWorkflow(userMessage: string) {
  const email = await extractEmail(userMessage);
  const isValid = await validateEmail(email);

  if (!isValid) {
    return { success: false, error: 'Invalid email address' };
  }

  const registration = await submitRegistration(email);
  return { success: true, registration };
}

// ---------------------------------------------------------------------------
// Demo runner
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(title: string): void {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(64));
}

function buildCheckpointTree(checkpoint: string): CheckpointTreeNode {
  const root: CheckpointTreeNode = {
    label: 'root',
    value: undefined,
    hasValue: false,
    children: new Map(),
  };

  const data: CheckpointData = JSON.parse(checkpoint);
  for (const [path, value] of data.entries) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = {
          label: segment,
          value: undefined,
          hasValue: false,
          children: new Map(),
        };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.value = value;
    node.hasValue = true;
  }
  return root;
}

function printCheckpointTree(title: string, checkpoint: string): void {
  const root = buildCheckpointTree(checkpoint);
  console.log(`\n  ${title}`);
  if (root.children.size === 0) {
    console.log('  (empty)');
    return;
  }

  const walk = (node: CheckpointTreeNode, depth: number) => {
    const indent = '  ' + '  '.repeat(depth);
    const valueSuffix = node.hasValue ? ` -> ${JSON.stringify(node.value)}` : '';
    console.log(`${indent}- ${node.label}${valueSuffix}`);
    for (const child of node.children.values()) {
      walk(child, depth + 1);
    }
  };

  for (const child of root.children.values()) {
    walk(child, 0);
  }
}

async function main() {
  const userMessage = 'Please register me, my email is alice@example.com';

  // ── Run 1: Fresh execution (flat) ───────────────────────────────────
  header('Run 1: Fresh execution (all tasks execute)');

  const engine1 = new DurableEngine();
  const result1 = await engine1.run(() => registrationWorkflow(userMessage));
  console.log(`\n  Result: ${JSON.stringify(result1)}`);

  const checkpoint = engine1.checkpoint();
  console.log(`  Checkpoint saved (${checkpoint.length} bytes, ${engine1.size} entries)`);
  printCheckpointTree('Checkpoint tree:', checkpoint);

  // ── Run 2: Full restore (flat) ──────────────────────────────────────
  header('Run 2: Restore from checkpoint (all tasks replay from cache)');

  const engine2 = new DurableEngine();
  engine2.restore(checkpoint);
  const result2 = await engine2.run(() => registrationWorkflow(userMessage));
  console.log(`\n  Result: ${JSON.stringify(result2)}`);
  printCheckpointTree('Checkpoint tree:', engine2.checkpoint());

  // ── Run 3: Partial restore (flat) ───────────────────────────────────
  header('Run 3: Partial checkpoint (first 2 cached, 3rd re-executes)');

  const engine3 = new DurableEngine();
  const partialData: CheckpointData = {
    entries: JSON.parse(checkpoint).entries.slice(0, 2),
  };
  engine3.restore(JSON.stringify(partialData));
  const result3 = await engine3.run(() => registrationWorkflow(userMessage));
  console.log(`\n  Result: ${JSON.stringify(result3)}`);
  printCheckpointTree('Checkpoint tree:', engine3.checkpoint());

  // ── Run 4: Nested tasks — fresh ─────────────────────────────────────
  header('Run 4: Nested tasks — fresh execution');
  console.log('  Scope tree: enrichWithWeather:0/geocode:0');
  console.log('              enrichWithWeather:0/fetchWeather:1');
  console.log('              notifyUser:1\n');

  const engine4 = new DurableEngine();
  const nested1 = await engine4.run(() => nestedWorkflow('San Francisco, CA'));
  console.log(`\n  Result: ${JSON.stringify(nested1)}`);

  const nestedCheckpoint = engine4.checkpoint();
  console.log(`  Checkpoint saved (${nestedCheckpoint.length} bytes, ${engine4.size} entries)`);
  printCheckpointTree('Checkpoint tree:', nestedCheckpoint);

  // ── Run 5: Nested tasks — full replay ───────────────────────────────
  header('Run 5: Nested tasks — full replay from checkpoint');

  const engine5 = new DurableEngine();
  engine5.restore(nestedCheckpoint);
  const nested2 = await engine5.run(() => nestedWorkflow('San Francisco, CA'));
  console.log(`\n  Result: ${JSON.stringify(nested2)}`);
  printCheckpointTree('Checkpoint tree:', engine5.checkpoint());

  // ── Run 6: Nested tasks — partial (parent cached, sibling executes) ─
  header('Run 6: Nested — only parent cached, sibling re-executes');
  console.log('  (enrichWithWeather cached → inner tasks skipped, notifyUser re-executes)\n');

  const engine6 = new DurableEngine();
  const parentOnlyEntries = JSON.parse(nestedCheckpoint).entries.filter(
    ([k]: [string, unknown]) => !k.includes('/'),
  );
  engine6.restore(JSON.stringify({ entries: parentOnlyEntries.slice(0, 1) }));
  const nested3 = await engine6.run(() => nestedWorkflow('San Francisco, CA'));
  console.log(`\n  Result: ${JSON.stringify(nested3)}`);
  printCheckpointTree('Checkpoint tree:', engine6.checkpoint());

  // ── Run 7: Nested — drop one child cache, keep the other ───────────
  header('Run 7: Nested — delete geocode cache, keep fetchWeather');
  console.log('  (parent must re-execute → geocode re-runs, fetchWeather replays)\n');

  const engine7 = new DurableEngine();
  const patchedEntries = JSON.parse(nestedCheckpoint).entries.filter(
    ([k]: [string, unknown]) =>
      k !== 'enrichWithWeather:0/geocode:0' && k !== 'enrichWithWeather:0',
  );
  engine7.restore(JSON.stringify({ entries: patchedEntries }));
  const nested4 = await engine7.run(() => nestedWorkflow('San Francisco, CA'));
  console.log(`\n  Result: ${JSON.stringify(nested4)}`);
  printCheckpointTree('Checkpoint tree:', engine7.checkpoint());

  // ── Run 8: Nested parallel tasks ────────────────────────────────────
  header('Run 8: Nested parallel tasks');

  const fetchPrice = task('fetchPrice', async (item: string): Promise<number> => {
    await sleep(30);
    const prices: Record<string, number> = { apple: 1.5, banana: 0.75, cherry: 3.0 };
    return prices[item] ?? 0;
  });

  const applyDiscount = task(
    'applyDiscount',
    async (price: number, pct: number): Promise<number> => {
      await sleep(10);
      return Math.round(price * (1 - pct) * 100) / 100;
    },
  );

  const fetchDiscountedPrice = task(
    'fetchDiscountedPrice',
    async (item: string, discountPct: number): Promise<{ item: string; price: number }> => {
      const raw = await fetchPrice(item);
      const final = await applyDiscount(raw, discountPct);
      return { item, price: final };
    },
  );

  async function priceWorkflow() {
    const orders = [
      { item: 'apple', discount: 0.1 },
      { item: 'banana', discount: 0.2 },
      { item: 'cherry', discount: 0 },
    ];
    const results = await Promise.all(orders.map((o) => fetchDiscountedPrice(o.item, o.discount)));
    const total = results.reduce((sum, r) => sum + r.price, 0);
    return { results, total };
  }

  const engine8 = new DurableEngine();
  console.log('\n  First run (execute all):');
  const pr1 = await engine8.run(priceWorkflow);
  console.log(`  Result: ${JSON.stringify(pr1)}`);

  const priceCheckpoint = engine8.checkpoint();
  printCheckpointTree('Checkpoint tree:', priceCheckpoint);

  console.log('\n  Second run (replay all from checkpoint):');
  const engine8b = new DurableEngine();
  engine8b.restore(priceCheckpoint);
  const pr2 = await engine8b.run(priceWorkflow);
  console.log(`  Result: ${JSON.stringify(pr2)}`);
  printCheckpointTree('Checkpoint tree:', engine8b.checkpoint());

  header('Done');
}

main().catch(console.error);
