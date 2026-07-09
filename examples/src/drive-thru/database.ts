// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const COMMON_INSTRUCTIONS =
  // Outcome — what a great interaction looks like.
  `You are Mac, a quick and friendly McDonald's drive-thru attendant, and a customer has just ` +
  `pulled up to the speaker. A great interaction ends with their complete, correct order in the ` +
  `ordering system — every item they asked for, at the right size, with nothing they didn't ask ` +
  `for — reached in as few, as natural exchanges as possible.\n\n` +
  // Voice & personality — keep it short and human.
  `Your output is synthesized directly to speech, so produce a natural verbatim transcript, not ` +
  `polished text. Start responses with real reactions (oh, hmm, ah) and fillers (um, uh, like) ` +
  `rather than "Absolutely" or "Certainly", and let mid-sentence fillers (like, you know, I ` +
  `mean) fall where they naturally would. Use informal phrasing: yeah, gonna, kinda, gotcha, ` +
  `lemme. Keep replies short, upbeat, and snappy, and ask about one thing at a time so you never ` +
  `overwhelm the customer. Confirm choices warmly ('Alright, one Big Mac Combo!'), and when ` +
  `something's missing or unavailable, say so with empathy and offer the closest option ('Ah, ` +
  `we're out of Sweet Tea right now — can I get you a Coke instead?').\n\n` +
  // How to work — infer intent, acknowledge before acting, stop when you have enough.
  `Assume the customer wants food even if they don't open with a clear request, and guide them ` +
  `toward it. Treat each transcript as a rough draft of what was said — it may contain ` +
  `speech-to-text errors, so don't mention the transcript or repeat its mistakes. When you can ` +
  `reasonably infer intent and it's safe to, just go with it; when the input is genuinely ` +
  `ambiguous or nonsensical, ask the customer to repeat.\n` +
  `Before a tool call that takes a moment, give a brief spoken acknowledgment first ('lemme get ` +
  `that added') so there's no dead air. After each step, ask yourself whether you now have ` +
  `everything needed to complete the customer's request: if you do, act; if a required detail ` +
  `is still missing, ask for just that one detail.\n\n` +
  // Hard constraints — these are invariants, not judgment calls.
  `Constraints that always hold:\n` +
  `- Stick strictly to the defined menu. Never invent items or sizes. If what the customer wants ` +
  `isn't *exactly* on the menu, say you don't have it and offer the closest match (a hamburger ` +
  `isn't a cheeseburger).\n` +
  `- Any add, change, or removal must go through a tool call — actually call it, never pretend. ` +
  `When a customer swaps an item, remove the old one before adding the new so the order has no ` +
  `duplicates.\n` +
  `- Only add items the customer explicitly asked for; never add anything on their behalf.\n` +
  `- Don't assume unstated details — especially the drink in a combo. If a required detail is ` +
  `missing, ask before calling the tool.\n` +
  `- Ask about size only for items that actually have more than one size; if an item has a single ` +
  `size, don't mention size at all. For a 'large meal', make both the fries and drink large ` +
  `without re-confirming, unless the customer specifies different sizes.\n` +
  `- If a tool returns an error, tell the customer and ask them to try again.`;

export type ItemSize = 'S' | 'M' | 'L';
export type ItemCategory = 'drink' | 'combo_meal' | 'happy_meal' | 'regular' | 'sauce';

export interface MenuItem {
  id: string;
  name: string;
  calories: number;
  price: number;
  available: boolean;
  size?: ItemSize;
  voiceAlias?: string;
  category: ItemCategory;
}

export class FakeDB {
  async listDrinks(): Promise<MenuItem[]> {
    const drinkData = [
      {
        id: 'coca_cola',
        name: 'Coca-Cola®',
        sizes: {
          S: { calories: 200, price: 1.49 },
          M: { calories: 270, price: 1.69 },
          L: { calories: 380, price: 1.89 },
        },
      },
      {
        id: 'sprite',
        name: 'Sprite®',
        sizes: {
          S: { calories: 190, price: 1.49 },
          M: { calories: 250, price: 1.69 },
          L: { calories: 350, price: 1.89 },
        },
      },
      {
        id: 'diet_coke',
        name: 'Diet Coke®',
        sizes: {
          S: { calories: 0, price: 1.49 },
          M: { calories: 0, price: 1.69 },
          L: { calories: 0, price: 1.89 },
        },
      },
      {
        id: 'dr_pepper',
        name: 'Dr Pepper®',
        sizes: {
          S: { calories: 200, price: 1.49 },
          M: { calories: 270, price: 1.69 },
          L: { calories: 380, price: 1.89 },
        },
      },
      {
        id: 'fanta_orange',
        name: 'Fanta® Orange',
        sizes: {
          S: { calories: 210, price: 1.49 },
          M: { calories: 280, price: 1.69 },
          L: { calories: 390, price: 1.89 },
        },
      },
      {
        id: 'hi_c_orange_lavaburst',
        name: 'Hi-C® Orange Lavaburst®',
        sizes: {
          S: { calories: 210, price: 1.49 },
          M: { calories: 280, price: 1.69 },
          L: { calories: 390, price: 1.89 },
        },
      },
      {
        id: 'sweet_tea',
        name: 'Sweet Tea',
        sizes: {
          S: { calories: 140, price: 1.39 },
          M: { calories: 180, price: 1.59 },
          L: { calories: 220, price: 1.79 },
        },
        available: false,
      },
      {
        id: 'unsweetened_iced_tea',
        name: 'Unsweetened Iced Tea',
        sizes: {
          S: { calories: 0, price: 1.39 },
          M: { calories: 0, price: 1.59 },
          L: { calories: 0, price: 1.79 },
        },
      },
      {
        id: 'minute_maid_orange_juice',
        name: 'Minute Maid® Premium Orange Juice',
        sizes: {
          S: { calories: 190, price: 2.59 },
          M: { calories: 240, price: 2.79 },
          L: { calories: 300, price: 2.99 },
        },
      },
      {
        id: 'milk',
        name: 'Milk',
        calories: 100,
        price: 1.29,
      },
      {
        id: 'chocolate_milk',
        name: 'Chocolate Milk',
        calories: 150,
        price: 1.39,
      },
      {
        id: 'dasani_water',
        name: 'DASANI® Water',
        calories: 0,
        price: 1.59,
      },
    ];

    const items: MenuItem[] = [];
    for (const item of drinkData) {
      if ('sizes' in item && item.sizes) {
        for (const [size, sizeDetails] of Object.entries(item.sizes)) {
          items.push({
            id: item.id,
            name: item.name,
            calories: sizeDetails.calories,
            price: sizeDetails.price,
            size: size as ItemSize,
            available: item.available ?? true,
            category: 'drink',
          });
        }
      } else {
        items.push({
          id: item.id,
          name: item.name,
          calories: item.calories,
          price: item.price,
          available: true,
          category: 'drink',
        });
      }
    }

    return items;
  }

  async listComboMeals(): Promise<MenuItem[]> {
    const rawMeals = [
      {
        id: 'combo_big_mac',
        name: 'Big Mac® Combo',
        alias: '1',
        calories: 970,
        price: 9.49,
      },
      {
        id: 'combo_quarter_pounder_2a',
        name: 'Quarter Pounder® with Cheese Combo',
        alias: '2a',
        calories: 840,
        price: 9.89,
      },
      {
        id: 'combo_quarter_pounder_2b',
        name: 'Quarter Pounder® with Cheese & Bacon Combo',
        alias: '2b',
        calories: 950,
        price: 10.39,
      },
      {
        id: 'combo_quarter_pounder_2c',
        name: 'Quarter Pounder® Deluxe Combo',
        alias: '2c',
        calories: 950,
        price: 10.39,
      },
      {
        id: 'combo_double_quarter',
        name: 'Double Quarter Pounder® with Cheese Combo',
        alias: '3',
        calories: 1060,
        price: 10.29,
      },
      {
        id: 'combo_mccrispy_4a',
        name: 'McCrispy™ Original Combo',
        alias: '4a',
        calories: 790,
        price: 8.99,
      },
      {
        id: 'combo_mccrispy_4b',
        name: 'McCrispy™ Spicy Combo',
        alias: '4b',
        calories: 850,
        price: 8.99,
      },
      {
        id: 'combo_mccrispy_4c',
        name: 'McCrispy™ Deluxe Combo',
        alias: '4c',
        calories: 880,
        price: 9.89,
      },
      {
        id: 'combo_mccrispy_4d',
        name: 'McCrispy™ Spicy Deluxe Combo',
        alias: '4d',
        calories: 860,
        price: 9.99,
      },
      {
        id: 'combo_chicken_mcnuggets_10pc',
        name: '10 pc. Chicken McNuggets® Combo',
        alias: '5',
        calories: 740,
        price: 9.49,
      },
      {
        id: 'combo_filet_o_fish',
        name: 'Filet-O-Fish® Combo',
        alias: '6',
        calories: 700,
        price: 7.89,
      },
      {
        id: 'combo_cheeseburgers_2pc',
        name: '2 Cheeseburgers Combo',
        alias: '7',
        calories: 920,
        price: 7.89,
      },
    ];

    return rawMeals.map((item) => ({
      id: item.id,
      name: item.name,
      calories: item.calories,
      price: item.price,
      voiceAlias: item.alias,
      category: 'combo_meal' as ItemCategory,
      available: true,
    }));
  }

  async listHappyMeals(): Promise<MenuItem[]> {
    const rawHappyMeals = [
      {
        id: 'happy_meal_4pc_mcnuggets',
        name: '4 pc. Chicken McNuggets® Happy Meal',
        calories: 430,
        price: 5.99,
      },
      {
        id: 'happy_meal_6pc_mcnuggets',
        name: '6 pc. Chicken McNuggets® Happy Meal',
        calories: 530,
        price: 6.99,
      },
      {
        id: 'happy_meal_hamburger',
        name: 'Hamburger Happy Meal',
        calories: 510,
        price: 5.59,
      },
    ];

    return rawHappyMeals.map((item) => ({
      id: item.id,
      name: item.name,
      calories: item.calories,
      price: item.price,
      available: true,
      category: 'happy_meal' as ItemCategory,
    }));
  }

  async listRegulars(): Promise<MenuItem[]> {
    const rawItems = [
      {
        id: 'big_mac',
        name: 'Big Mac®',
        calories: 590,
        price: 5.89,
      },
      {
        id: 'quarter_pounder_cheese',
        name: 'Quarter Pounder® with Cheese',
        calories: 520,
        price: 6.29,
      },
      {
        id: 'quarter_pounder_bacon',
        name: 'Quarter Pounder® with Cheese & Bacon',
        calories: 590,
        price: 6.79,
      },
      {
        id: 'quarter_pounder_deluxe',
        name: 'Quarter Pounder® Deluxe',
        calories: 530,
        price: 6.39,
      },
      {
        id: 'double_quarter_pounder',
        name: 'Double Quarter Pounder® with Cheese',
        calories: 740,
        price: 7.49,
      },
      {
        id: 'mccrispy_original',
        name: 'McCrispy™ Original',
        calories: 470,
        price: 5.69,
      },
      {
        id: 'mccrispy_spicy',
        name: 'McCrispy™ Spicy',
        calories: 500,
        price: 5.69,
      },
      {
        id: 'mccrispy_deluxe',
        name: 'McCrispy™ Deluxe',
        calories: 530,
        price: 6.39,
      },
      {
        id: 'mccrispy_spicy_deluxe',
        name: 'McCrispy™ Spicy Deluxe',
        calories: 530,
        price: 6.59,
      },
      {
        id: 'mcnuggets_10pc',
        name: '10 pc. Chicken McNuggets®',
        calories: 410,
        price: 6.79,
      },
      {
        id: 'filet_o_fish',
        name: 'Filet-O-Fish®',
        calories: 390,
        price: 5.89,
      },
      {
        id: 'hamburger',
        name: 'Hamburger',
        calories: 300,
        price: 2.0,
      },
      {
        id: 'cheeseburger',
        name: 'Cheeseburger',
        calories: 600,
        price: 2.58,
      },
      {
        id: 'fries',
        name: 'Fries',
        sizes: {
          S: { calories: 230, price: 1.89 },
          M: { calories: 350, price: 3.99 },
          L: { calories: 521, price: 4.75 },
        },
      },
      {
        id: 'sweet_sundae',
        name: 'Sundae',
        calories: 330,
        price: 3.69,
      },
      {
        id: 'sweet_mcflurry_oreo',
        name: 'McFlurry® (Oreo)',
        calories: 480,
        price: 4.89,
      },
      {
        id: 'shake_vanilla',
        name: 'Vanilla Shake',
        sizes: {
          S: { calories: 510, price: 2.79 },
          M: { calories: 610, price: 3.59 },
          L: { calories: 820, price: 3.89 },
        },
      },
      {
        id: 'shake_chocolate',
        name: 'Chocolate Shake',
        sizes: {
          S: { calories: 520, price: 2.79 },
          M: { calories: 620, price: 3.59 },
          L: { calories: 830, price: 3.89 },
        },
      },
      {
        id: 'shake_strawberry',
        name: 'Strawberry Shake',
        sizes: {
          S: { calories: 530, price: 2.79 },
          M: { calories: 620, price: 3.59 },
          L: { calories: 840, price: 3.89 },
        },
      },
      {
        id: 'sweet_cone',
        name: 'Cone',
        calories: 200,
        price: 3.19,
      },
    ];

    const items: MenuItem[] = [];
    for (const item of rawItems) {
      if ('sizes' in item && item.sizes) {
        for (const [size, sizeDetails] of Object.entries(item.sizes)) {
          items.push({
            id: item.id,
            name: item.name,
            calories: sizeDetails.calories,
            price: sizeDetails.price,
            size: size as ItemSize,
            available: true,
            category: 'regular',
          });
        }
      } else {
        items.push({
          id: item.id,
          name: item.name,
          calories: item.calories,
          price: item.price,
          available: true,
          category: 'regular',
        });
      }
    }

    return items;
  }

  async listSauces(): Promise<MenuItem[]> {
    const rawItems = [
      {
        id: 'jalapeno_ranch',
        name: 'Jalapeño Ranch',
        calories: 70,
        price: 0.25,
      },
      {
        id: 'garlic_sauce',
        name: 'Garlic Sauce',
        calories: 45,
        price: 0.25,
      },
      {
        id: 'mayonnaise',
        name: 'Mayonnaise',
        calories: 90,
        price: 0.2,
      },
      {
        id: 'frietsaus',
        name: 'Frietsaus',
        calories: 100,
        price: 0.2,
      },
      {
        id: 'curry_sauce',
        name: 'Curry sauce',
        calories: 60,
        price: 0.2,
      },
      {
        id: 'ketchup',
        name: 'Ketchup',
        calories: 20,
        price: 0.1,
      },
      {
        id: 'barbecue_sauce',
        name: 'Barbecue Sauce',
        calories: 45,
        price: 0.2,
      },
      {
        id: 'sweet_and_sour_sauce',
        name: 'Sweet-and-sour sauce',
        calories: 50,
        price: 0.4,
      },
      {
        id: 'honey_mustard_dressing',
        name: 'Honey mustard dressing',
        calories: 60,
        price: 0.2,
      },
    ];

    return rawItems.map((item) => ({
      id: item.id,
      name: item.name,
      calories: item.calories,
      price: item.price,
      available: true,
      category: 'sauce' as ItemCategory,
    }));
  }
}

// Helper functions

export function findItemsById(items: MenuItem[], itemId: string, size?: ItemSize): MenuItem[] {
  return items.filter((item) => item.id === itemId && (size === undefined || item.size === size));
}

export function menuInstructions(category: ItemCategory, items: MenuItem[]): string {
  switch (category) {
    case 'drink':
      return drinkMenuInstructions(items);
    case 'combo_meal':
      return comboMenuInstructions(items);
    case 'happy_meal':
      return happyMenuInstructions(items);
    case 'sauce':
      return sauceMenuInstructions(items);
    case 'regular':
      return regularMenuInstructions(items);
    default:
      return '';
  }
}

function mapBySizes(items: MenuItem[]): {
  sized: Record<string, Record<ItemSize, MenuItem>>;
  leftovers: MenuItem[];
} {
  const sized: Record<string, Record<ItemSize, MenuItem>> = {};
  const leftovers: MenuItem[] = [];

  for (const item of items) {
    if (item.size) {
      if (!sized[item.id]) {
        sized[item.id] = {} as Record<ItemSize, MenuItem>;
      }
      sized[item.id]![item.size] = item;
    } else {
      leftovers.push(item);
    }
  }

  return { sized, leftovers };
}

function drinkMenuInstructions(items: MenuItem[]): string {
  const { sized, leftovers } = mapBySizes(items);
  const menuLines: string[] = [];

  for (const [_itemId, sizeMap] of Object.entries(sized)) {
    const firstItem = Object.values(sizeMap)[0];
    if (!firstItem) continue;
    menuLines.push(`  - ${firstItem.name} (id:${firstItem.id}):`);

    for (const [size, item] of Object.entries(sizeMap)) {
      let line = `    - Size ${size}: ${item.calories} Cal, $${item.price.toFixed(2)}`;
      if (!item.available) {
        line += ' UNAVAILABLE';
      }
      menuLines.push(line);
    }
  }

  for (const item of leftovers) {
    let line = `  - ${item.name}: ${item.calories} Cal, $${item.price.toFixed(2)} (id:${item.id}) - Not size-selectable`;
    if (!item.available) {
      line += ' UNAVAILABLE';
    }
    menuLines.push(line);
  }

  return '# Drinks:\n' + menuLines.join('\n');
}

function comboMenuInstructions(items: MenuItem[]): string {
  const menuLines: string[] = [];
  for (const item of items) {
    let line = `  **${item.voiceAlias}**. ${item.name}: ${item.calories} Cal, $${item.price.toFixed(2)} (id:${item.id})`;
    if (!item.available) {
      line += ' UNAVAILABLE';
    }
    menuLines.push(line);
  }

  const instructions = `# Combo Meals:
The user can select a combo meal by saying its voice alias (e.g., '1', '2a', '4c'). Use the alias to identify which combo they chose.
But don't mention the voice alias to the user if not needed.`;

  return instructions + '\n' + menuLines.join('\n');
}

function happyMenuInstructions(items: MenuItem[]): string {
  const menuLines: string[] = [];
  for (const item of items) {
    let line = `  - ${item.name}: ${item.calories} Cal, $${item.price.toFixed(2)} (id:${item.id})`;
    if (!item.available) {
      line += ' UNAVAILABLE';
    }
    menuLines.push(line);
  }

  return `# Happy Meals:
${menuLines.join('\n')}

Recommended drinks with the Happy Meal:
  - Milk chocolate/white
  - DASANI Water
  - Or any other small drink.`;
}

function sauceMenuInstructions(items: MenuItem[]): string {
  const menuLines: string[] = [];
  for (const item of items) {
    let line = `  - ${item.name}: ${item.calories} Cal, $${item.price.toFixed(2)} (id:${item.id})`;
    if (!item.available) {
      line += ' UNAVAILABLE';
    }
    menuLines.push(line);
  }

  return '# Sauces:\n' + menuLines.join('\n');
}

function regularMenuInstructions(items: MenuItem[]): string {
  const { sized, leftovers } = mapBySizes(items);
  const menuLines: string[] = [];

  for (const [_itemId, sizeMap] of Object.entries(sized)) {
    const firstItem = Object.values(sizeMap)[0];
    if (!firstItem) continue;
    menuLines.push(`  - ${firstItem.name} (id:${firstItem.id}):`);

    for (const [size, item] of Object.entries(sizeMap)) {
      let line = `    - Size ${size}: ${item.calories} Cal, $${item.price.toFixed(2)}`;
      if (!item.available) {
        line += ' UNAVAILABLE';
      }
      menuLines.push(line);
    }
  }

  for (const item of leftovers) {
    let line = `  - ${item.name}: ${item.calories} Cal, $${item.price.toFixed(2)} (id:${item.id}) - Not size-selectable`;
    if (!item.available) {
      line += ' UNAVAILABLE';
    }
    menuLines.push(line);
  }

  return '# Regular items/À la carte:\n' + menuLines.join('\n');
}
