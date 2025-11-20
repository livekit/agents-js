// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  formatDatesDE,
  formatDistancesDE,
  formatEuroAmounts,
  formatNumbersDE,
  formatPercentagesDE,
  formatUnitsDE,
} from './transforms_de.js';

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

describe('formatNumbersDE (German)', () => {
  it('should convert single digit numbers to German words', async () => {
    const result = await applyTransform(formatNumbersDE, 'Ich habe 5 Artikel');
    expect(result).toBe('Ich habe fünf Artikel');
  });

  it('should convert teen numbers to German words', async () => {
    const result = await applyTransform(formatNumbersDE, 'Es sind 15 Leute');
    expect(result).toBe('Es sind fünfzehn Leute');
  });

  it('should convert compound numbers with German reversed format', async () => {
    const result = await applyTransform(formatNumbersDE, 'Ich bin 21 Jahre alt');
    expect(result).toBe('Ich bin einundzwanzig Jahre alt');
  });

  it('should handle 42 correctly', async () => {
    const result = await applyTransform(formatNumbersDE, 'Zahl 42');
    expect(result).toBe('Zahl zweiundvierzig');
  });

  it('should preserve years', async () => {
    const result = await applyTransform(formatNumbersDE, 'Geboren 1995');
    expect(result).toBe('Geboren 1995');
  });

  it('should preserve large numbers', async () => {
    const result = await applyTransform(formatNumbersDE, 'Bevölkerung: 150 Millionen');
    expect(result).toBe('Bevölkerung: 150 Millionen');
  });

  it('should format decimal numbers with Komma', async () => {
    const result = await applyTransform(formatNumbersDE, 'Pi ist 3,14');
    // Decimal digits are converted to words too
    expect(result).toBe('Pi ist drei Komma eins vier');
  });

  it('should remove German thousands separators', async () => {
    const result = await applyTransform(formatNumbersDE, 'Gesamt: 1.234');
    expect(result).toBe('Gesamt: 1234');
  });

  it('should handle zero', async () => {
    const result = await applyTransform(formatNumbersDE, 'Anzahl: 0');
    expect(result).toBe('Anzahl: null');
  });

  it('should handle dreißig (30)', async () => {
    const result = await applyTransform(formatNumbersDE, 'Alter: 30');
    expect(result).toBe('Alter: dreißig');
  });
});

describe('formatEuroAmounts (German)', () => {
  it('should format whole Euro amounts', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Preis: 5€');
    expect(result).toBe('Preis: fünf Euro');
  });

  it('should format Euro amounts with cents', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Preis: 12,50€');
    expect(result).toBe('Preis: zwölf Euro und fünfzig Cent');
  });

  it('should handle one Euro', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Nur 1€');
    expect(result).toBe('Nur eins Euro');
  });

  it('should handle zero Euro', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Gratis: 0€');
    expect(result).toBe('Gratis: null Euro');
  });

  it('should format large amounts', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Gesamt: 99€');
    expect(result).toContain('Euro');
  });

  it('should handle Euro with space before symbol', async () => {
    const result = await applyTransform(formatEuroAmounts, 'Preis: 10 €');
    expect(result).toBe('Preis: zehn Euro');
  });
});

describe('formatPercentagesDE (German)', () => {
  it('should format whole number percentages', async () => {
    const result = await applyTransform(formatPercentagesDE, 'Rabatt: 50%');
    expect(result).toBe('Rabatt: 50 Prozent');
  });

  it('should format decimal percentages with comma', async () => {
    const result = await applyTransform(formatPercentagesDE, 'Rate: 3,5%');
    expect(result).toBe('Rate: 3,5 Prozent');
  });

  it('should handle multiple percentages', async () => {
    const result = await applyTransform(formatPercentagesDE, '10% bis 20%');
    expect(result).toBe('10 Prozent bis 20 Prozent');
  });
});

describe('formatDistancesDE (German)', () => {
  it('should format kilometers', async () => {
    const result = await applyTransform(formatDistancesDE, 'Entfernung: 5 km');
    expect(result).toBe('Entfernung: 5 Kilometer');
  });

  it('should format Meilen (miles)', async () => {
    const result = await applyTransform(formatDistancesDE, 'Lauf 10 mi');
    expect(result).toBe('Lauf 10 Meilen');
  });

  it('should format Meter', async () => {
    const result = await applyTransform(formatDistancesDE, 'Höhe: 100 m');
    expect(result).toBe('Höhe: 100 Meter');
  });

  it('should format Fuß (feet)', async () => {
    const result = await applyTransform(formatDistancesDE, 'Tiefe: 20 ft');
    expect(result).toBe('Tiefe: 20 Fuß');
  });

  it('should handle decimal distances with comma', async () => {
    const result = await applyTransform(formatDistancesDE, 'Strecke: 3,5 km');
    expect(result).toBe('Strecke: 3,5 Kilometer');
  });

  it('should remove German thousands separators', async () => {
    const result = await applyTransform(formatDistancesDE, 'Weit: 1.000 km');
    expect(result).toBe('Weit: 1000 Kilometer');
  });
});

describe('formatUnitsDE (German)', () => {
  it('should format Kilogramm', async () => {
    const result = await applyTransform(formatUnitsDE, 'Gewicht: 10 kg');
    expect(result).toBe('Gewicht: zehn Kilogramm');
  });

  it('should format Pfund (pounds)', async () => {
    const result = await applyTransform(formatUnitsDE, 'Gewicht: 5 lb');
    expect(result).toBe('Gewicht: fünf Pfund');
  });

  it('should format Gramm', async () => {
    const result = await applyTransform(formatUnitsDE, 'Masse: 50 g');
    expect(result).toBe('Masse: fünfzig Gramm');
  });

  it('should format Liter', async () => {
    const result = await applyTransform(formatUnitsDE, 'Volumen: 2 l');
    expect(result).toBe('Volumen: zwei Liter');
  });

  it('should format Milliliter', async () => {
    const result = await applyTransform(formatUnitsDE, 'Dosis: 10 ml');
    expect(result).toBe('Dosis: zehn Milliliter');
  });

  it('should format Gallonen', async () => {
    const result = await applyTransform(formatUnitsDE, 'Tank: 15 gal');
    expect(result).toBe('Tank: fünfzehn Gallonen');
  });

  it('should handle plural lbs', async () => {
    const result = await applyTransform(formatUnitsDE, 'Gewicht: 10 lbs');
    expect(result).toBe('Gewicht: zehn Pfund');
  });
});

describe('formatDatesDE (German)', () => {
  it('should format ISO dates in German', async () => {
    const result = await applyTransform(formatDatesDE, 'Datum: 2024-12-25');
    expect(result).toContain('Dezember');
    expect(result).toContain('2024');
  });

  it('should include German day of week', async () => {
    const result = await applyTransform(formatDatesDE, 'Datum: 2024-12-25');
    expect(result).toContain('Mittwoch');
  });

  it('should use German date format (DD. Month YYYY)', async () => {
    const result = await applyTransform(formatDatesDE, 'Datum: 2024-12-25');
    expect(result).toContain('25. Dezember 2024');
  });

  it('should format multiple dates', async () => {
    const result = await applyTransform(formatDatesDE, '2024-01-01 bis 2024-12-31');
    expect(result).toContain('Januar');
    expect(result).toContain('Dezember');
  });

  it('should handle leap years', async () => {
    const result = await applyTransform(formatDatesDE, 'Schalttag: 2024-02-29');
    expect(result).toContain('Februar');
    expect(result).toContain('29');
  });

  it('should use German month names', async () => {
    const result = await applyTransform(formatDatesDE, '2024-03-15');
    expect(result).toContain('März');
  });
});
