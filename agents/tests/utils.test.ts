import { describe, expect, it } from 'vitest';

import { Event, isPending, sleep } from '../src/utils.js';


describe('Event', () => {
  it('wait resolves immediately when the event is already set', async () => {
    const event = new Event();
    event.set();

    const result = await event.wait();
    expect(result).toBe(true);
  });

  it('wait resolves after set is called', async () => {
    // check promise is pending
    const event = new Event();
    const waiterPromise = event.wait();

    await sleep(10);
    expect(await isPending(waiterPromise)).toBe(true);

    // check promise is resolved after set is called
    event.set();
    const result = await waiterPromise;
    expect(result).toBe(true);
  });

  it('all waiters resolve once set is called', async () => {
    const event = new Event();
    const waiters = [event.wait(), event.wait(), event.wait()];

    await sleep(10);
    const pendings = await Promise.all(waiters.map((w) => isPending(w)));
    expect(pendings).toEqual([true, true, true]);

    event.set();
    const results = await Promise.all(waiters);
    expect(results).toEqual([true, true, true]);
  });

  it('wait after 2 seconds is still pending before set', async () => {
    const event = new Event();
    const waiter = event.wait();

    await sleep(2000);
    expect(await isPending(waiter)).toBe(true);

    event.set();
    const result = await waiter;
    expect(result).toBe(true);
  });

  it('wait after set and clear should be pending', async () => {
    const event = new Event();
    const waiterBeforeSet = event.wait();
    event.set();
    event.clear();

    const waiterAfterSet = event.wait();

    const result = await Promise.race([
      waiterBeforeSet.then(() => 'before'),
      waiterAfterSet.then(() => 'after'),
    ]);

    expect(result).toBe('before');
    expect(await isPending(waiterBeforeSet)).toBe(false);
    expect(await isPending(waiterAfterSet)).toBe(true);

    event.set();
    expect(await waiterAfterSet).toBe(true);
  });
});
