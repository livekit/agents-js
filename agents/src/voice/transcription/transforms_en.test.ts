// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  formatAcronyms,
  formatDates,
  formatDistances,
  formatDollarAmounts,
  formatNumbers,
  formatPercentages,
  formatUnits,
} from './transforms_en.js';

/**
 * Helper to apply a transform and get the result
 */
async function applyTransform(
  transform: (text: ReadableStream<string>) => ReadableStream<string>,
  input: string,
): Promise<string> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });

  const result = transform(stream);
  const reader = result.getReader();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  return output;
}

describe('formatNumbers (English)', () => {
  it('should convert single digit numbers to words', async () => {
    const result = await applyTransform(formatNumbers, 'I have 5 items');
    expect(result).toBe('I have five items');
  });

  it('should convert teen numbers to words', async () => {
    const result = await applyTransform(formatNumbers, 'There are 15 people');
    expect(result).toBe('There are fifteen people');
  });

  it('should convert tens to words', async () => {
    const result = await applyTransform(formatNumbers, 'Count to 20 and 30');
    expect(result).toBe('Count to twenty and thirty');
  });

  it('should convert compound numbers to words', async () => {
    const result = await applyTransform(formatNumbers, 'I am 42 years old');
    expect(result).toBe('I am forty-two years old');
  });

  it('should preserve years', async () => {
    const result = await applyTransform(formatNumbers, 'Born in 1995');
    expect(result).toBe('Born in 1995');
  });

  it('should preserve large numbers', async () => {
    const result = await applyTransform(formatNumbers, 'Population: 150 million');
    expect(result).toBe('Population: 150 million');
  });

  it('should format decimal numbers', async () => {
    const result = await applyTransform(formatNumbers, 'Pi is 3.14');
    expect(result).toBe('Pi is three point one four');
  });

  it('should remove commas from numbers', async () => {
    const result = await applyTransform(formatNumbers, 'Total: 1,234');
    expect(result).toBe('Total: 1234');
  });

  it('should handle zero', async () => {
    const result = await applyTransform(formatNumbers, 'Count: 0');
    expect(result).toBe('Count: zero');
  });
});

describe('formatDollarAmounts (English)', () => {
  it('should format whole dollar amounts', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Price: $5');
    expect(result).toBe('Price: five dollars');
  });

  it('should format dollar amounts with cents', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Price: $12.50');
    expect(result).toBe('Price: twelve dollars and fifty cents');
  });

  it('should use singular for one dollar', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Only $1');
    expect(result).toBe('Only one dollar');
  });

  it('should use singular for one cent', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Cost: $0.01');
    expect(result).toBe('Cost: zero dollars and one cent');
  });

  it('should handle large amounts', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Total: $999');
    expect(result).toContain('dollars');
  });

  it('should format zero dollars', async () => {
    const result = await applyTransform(formatDollarAmounts, 'Free: $0');
    expect(result).toBe('Free: zero dollars');
  });
});

describe('formatPercentages (English)', () => {
  it('should format whole number percentages', async () => {
    const result = await applyTransform(formatPercentages, 'Discount: 50%');
    expect(result).toBe('Discount: 50 percent');
  });

  it('should format decimal percentages', async () => {
    const result = await applyTransform(formatPercentages, 'Rate: 3.5%');
    expect(result).toBe('Rate: 3.5 percent');
  });

  it('should handle multiple percentages', async () => {
    const result = await applyTransform(formatPercentages, '10% to 20%');
    expect(result).toBe('10 percent to 20 percent');
  });
});

describe('formatDistances (English)', () => {
  it('should format kilometers', async () => {
    const result = await applyTransform(formatDistances, 'Distance: 5 km');
    expect(result).toBe('Distance: 5 kilometers');
  });

  it('should format miles', async () => {
    const result = await applyTransform(formatDistances, 'Run 10 mi');
    expect(result).toBe('Run 10 miles');
  });

  it('should format meters', async () => {
    const result = await applyTransform(formatDistances, 'Height: 100 m');
    expect(result).toBe('Height: 100 meters');
  });

  it('should format feet', async () => {
    const result = await applyTransform(formatDistances, 'Depth: 20 ft');
    expect(result).toBe('Depth: 20 feet');
  });

  it('should format yards', async () => {
    const result = await applyTransform(formatDistances, 'Length: 50 yd');
    expect(result).toBe('Length: 50 yards');
  });

  it('should handle decimal distances', async () => {
    const result = await applyTransform(formatDistances, 'Distance: 3.5 km');
    expect(result).toBe('Distance: 3.5 kilometers');
  });

  it('should remove commas from distances', async () => {
    const result = await applyTransform(formatDistances, 'Far: 1,000 km');
    expect(result).toBe('Far: 1000 kilometers');
  });
});

describe('formatUnits (English)', () => {
  it('should format kilograms', async () => {
    const result = await applyTransform(formatUnits, 'Weight: 10 kg');
    expect(result).toBe('Weight: ten kilograms');
  });

  it('should format pounds', async () => {
    const result = await applyTransform(formatUnits, 'Weight: 5 lb');
    expect(result).toBe('Weight: five pounds');
  });

  it('should format grams', async () => {
    const result = await applyTransform(formatUnits, 'Mass: 50 g');
    expect(result).toBe('Mass: fifty grams');
  });

  it('should format liters', async () => {
    const result = await applyTransform(formatUnits, 'Volume: 2 l');
    expect(result).toBe('Volume: two liters');
  });

  it('should format milliliters', async () => {
    const result = await applyTransform(formatUnits, 'Dose: 10 ml');
    expect(result).toBe('Dose: ten milliliters');
  });

  it('should format gallons', async () => {
    const result = await applyTransform(formatUnits, 'Tank: 15 gal');
    expect(result).toBe('Tank: fifteen gallons');
  });

  it('should handle plural lbs', async () => {
    const result = await applyTransform(formatUnits, 'Weight: 10 lbs');
    expect(result).toBe('Weight: ten pounds');
  });
});

describe('formatDates (English)', () => {
  it('should format ISO dates', async () => {
    const result = await applyTransform(formatDates, 'Date: 2024-12-25');
    expect(result).toContain('December 25, 2024');
  });

  it('should include day of week', async () => {
    const result = await applyTransform(formatDates, 'Date: 2024-12-25');
    expect(result).toContain('Wednesday');
  });

  it('should format multiple dates', async () => {
    const result = await applyTransform(formatDates, '2024-01-01 to 2024-12-31');
    expect(result).toContain('January');
    expect(result).toContain('December');
  });

  it('should handle leap years', async () => {
    const result = await applyTransform(formatDates, 'Leap day: 2024-02-29');
    expect(result).toContain('February 29');
  });
});

describe('formatAcronyms (English)', () => {
  it('should lowercase known acronyms', async () => {
    const result = await applyTransform(formatAcronyms, 'NASA launched');
    expect(result).toBe('nasa launched');
  });

  it('should lowercase acronyms with vowels', async () => {
    const result = await applyTransform(formatAcronyms, 'SCUBA diving');
    expect(result).toBe('scuba diving');
  });

  it('should space out consonant-only acronyms', async () => {
    const result = await applyTransform(formatAcronyms, 'XYZ Corp');
    expect(result).toBe('X Y Z Corp');
  });

  it('should handle API', async () => {
    const result = await applyTransform(formatAcronyms, 'REST API');
    // REST has vowels, so it becomes lowercase
    expect(result).toBe('rest api');
  });

  it('should handle multiple acronyms', async () => {
    const result = await applyTransform(formatAcronyms, 'NASA and FBI');
    expect(result).toContain('nasa');
    // FBI has vowel 'I', so it becomes lowercase
    expect(result).toContain('fbi');
  });

  it('should preserve regular words', async () => {
    const result = await applyTransform(formatAcronyms, 'Hello World');
    expect(result).toBe('Hello World');
  });
});
