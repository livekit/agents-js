// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { PIZZERIA_DATA as DATA } from './pizzeria_data.js';

export const RESTAURANT = DATA.restaurant;
export const NEIGHBORHOOD = DATA.neighborhood;
export const HOURS = DATA.hours;
export const PIZZA_SIZES = DATA.pizzaSizes;
export const CRUST = DATA.crust;
export const DRINK_SIZES = DATA.drinkSizes;
export const MOST_OF_ONE_ITEM = 20;
export const MOST_TIP = 10_000;
export type Size = 'small' | 'medium' | 'large' | 'half_dozen' | 'dozen';
export type Mode = 'pickup' | 'delivery';
export type EndedEarly = 'wrong_person' | 'call_back_later' | 'declined';
export type Allergen = (typeof DATA.allergens)[number];
export type ItemId = (typeof DATA.menu)[number][0];
export type ToppingId = (typeof DATA.toppings)[number][0];
export type SauceId = (typeof DATA.sauces)[number][0];
export type Ingredient = string;
type Json = Record<string, unknown>;
export type Publish = (parts: Json) => Promise<void>;

export class PizzeriaError extends Error {}
export type MenuItem = {
  id: ItemId;
  name: string;
  category: string;
  prices: Record<string, number>;
  ingredients: readonly string[];
  allergens: ReadonlySet<string>;
  details: string;
};
export type Option = { id: string; name: string; allergens: ReadonlySet<string> };
export const MENU = new Map<ItemId, MenuItem>(
  DATA.menu.map((m) => [
    m[0],
    {
      id: m[0],
      name: m[1],
      category: m[2],
      prices: m[3],
      ingredients: m[4],
      allergens: new Set(m[5]),
      details: m[6] ?? '',
    },
  ]),
);
export const TOPPINGS = new Map<ToppingId, Option>(
  DATA.toppings.map((v) => [v[0], { id: v[0], name: v[1], allergens: new Set(v[2]) }]),
);
export const SAUCES = new Map<SauceId, Option>(
  DATA.sauces.map((v) => [v[0], { id: v[0], name: v[1], allergens: new Set(v[2]) }]),
);
export const SOLD_OUT_TODAY = new Set<ItemId>(DATA.menu.filter((m) => m[7]).map((m) => m[0]));
export const PLAIN = 'plain';
const ENDED_EARLY: Record<EndedEarly, string> = {
  wrong_person: 'Wrong number',
  call_back_later: 'Not a good time',
  declined: "Didn't want to go through it",
};
const discard: Publish = async () => {};

export function sizeWords(size?: string | null): string {
  return (size ?? '').replace('_', ' ');
}
export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function compared(cents: number): string {
  return cents > 0
    ? `${money(cents)} more than before`
    : cents < 0
      ? `${money(-cents)} less than before`
      : 'the same as before';
}
function orList(words: Iterable<string>): string {
  const a = [...words];
  return a.length === 1 ? a[0]! : `${a.slice(0, -1).join(', ')} or ${a.at(-1)}`;
}
export class Line {
  constructor(
    public readonly id: string,
    public readonly item: MenuItem,
    public readonly size: string | null,
    public readonly quantity = 1,
    public readonly toppings: readonly Option[] = [],
    public readonly sauce: Option | null = null,
    public readonly without: readonly string[] = [],
    public readonly halves: readonly [readonly Option[], readonly Option[]] = [[], []],
  ) {}
  get unitPrice(): number {
    return (
      this.item.prices[this.size ?? '']! +
      DATA.toppingPrice * this.toppings.length +
      (DATA.toppingPrice / 2) * (this.halves[0].length + this.halves[1].length)
    );
  }
  get total(): number {
    return this.unitPrice * this.quantity;
  }
  get allergens(): Set<string> {
    return new Set([
      ...[...this.item.allergens],
      ...this.toppings.flatMap((o) => [...o.allergens]),
      ...this.halves.flatMap((h) => h.flatMap((o) => [...o.allergens])),
      ...(this.sauce ? [...this.sauce.allergens] : []),
    ]);
  }
  get configuration(): string {
    return JSON.stringify([
      this.item.id,
      this.size,
      [...this.toppings.map((v) => v.id)].sort(),
      this.sauce?.id ?? null,
      [...this.without].sort(),
      this.halves.map((h) => h.map((v) => v.id).sort()).sort(),
    ]);
  }
  get label(): string {
    return `${sizeWords(this.size)} ${this.item.name}`.trim();
  }
  get needs(): string | null {
    return this.item.category === 'wings' && !this.sauce ? 'sauce' : null;
  }
  get modifiers(): string[] {
    const out: string[] = [];
    if (this.sauce)
      out.push(this.sauce.id === PLAIN ? this.sauce.name : `${this.sauce.name} sauce`);
    out.push(...this.toppings.map((t) => `add ${t.name}`));
    if (this.halves.some((h) => h.length)) {
      const halves = this.halves.map((h) => h.map((t) => t.name).join(', ') || 'plain').sort();
      out.push(`half ${halves[0]}`, `other half ${halves[1]}`);
    }
    out.push(...this.without.map((i) => `no ${i}`));
    return out;
  }
  describe(): string {
    const mods = this.modifiers.join(', ');
    return `${this.quantity} ${this.label}${mods ? `, ${mods}` : ''}`;
  }
  facts(): Json {
    return {
      lineId: this.id,
      quantity: this.quantity,
      item: this.label,
      with: this.modifiers,
      price: money(this.total),
      ...(this.needs ? { needs: this.needs } : {}),
    };
  }
}

export class Quote {
  constructor(
    public subtotal: number,
    public tax: number,
    public deliveryFee: number,
    public smallOrderFee: number,
    public tip: number,
  ) {}
  get total(): number {
    return this.subtotal + this.tax + this.deliveryFee + this.smallOrderFee + this.tip;
  }
  facts(): Json {
    return {
      subtotal: money(this.subtotal),
      tax: money(this.tax),
      deliveryFee: this.deliveryFee ? money(this.deliveryFee) : null,
      smallOrderFee: this.smallOrderFee
        ? `${money(this.smallOrderFee)}, since it's under ${money(DATA.smallOrderUnder)}`
        : null,
      tip: this.tip ? money(this.tip) : null,
      total: money(this.total),
    };
  }
}
export type Fulfillment = {
  mode: Mode | null;
  address: string | null;
  zipCode: string | null;
  driverNote: string | null;
};
export type Order = { number: string; readyIn: string; cancelled: boolean };
export type Delivery = {
  driver: string;
  etaMinutes: number;
  due: number;
  ordered: Map<string, Line>;
  ranOut: string;
  endedEarly: EndedEarly | null;
  readBackRevision: number | null;
};
export type ItemSpec = {
  itemId: ItemId;
  size?: Size | null;
  quantity?: number;
  toppings?: ToppingId[];
  sauce?: SauceId | null;
  without?: Ingredient[];
  firstHalf?: ToppingId[];
  secondHalf?: ToppingId[];
};

export class Pizzeria {
  lines: Line[] = [];
  fulfillment: Fulfillment = { mode: null, address: null, zipCode: null, driverNote: null };
  name: string | null = null;
  phone: string | null = null;
  tip = 0;
  allergies = new Map<string, boolean>();
  soldOut = new Set<ItemId>(SOLD_OUT_TODAY);
  order: Order | null = null;
  delivery: Delivery | null = null;
  revision = 0;
  private nextLine = 1;
  private nextOrder = DATA.firstOrderNumber;
  constructor(public readonly publish: Publish = discard) {}
  static outForDelivery(customer?: string | null, publish: Publish = discard): Pizzeria {
    const p = new Pizzeria(publish);
    p.name = customer || null;
    for (const s of DATA.outForDelivery.items)
      p.lines.push(
        p.build(p.newLineId(), s.itemId, s.size, 1, { sauce: 'sauce' in s ? s.sauce : undefined }),
      );
    p.fulfillment = {
      mode: 'delivery',
      address: DATA.outForDelivery.address,
      zipCode: DATA.outForDelivery.zip,
      driverNote: null,
    };
    p.order = {
      number: DATA.outForDelivery.orderNumber,
      readyIn: `with ${DATA.outForDelivery.driver}`,
      cancelled: false,
    };
    const ran = p.lines.find((l) => l.item.id === DATA.outForDelivery.ranOut)!;
    p.soldOut.add(ran.item.id);
    p.delivery = {
      driver: DATA.outForDelivery.driver,
      etaMinutes: DATA.outForDelivery.etaMinutes,
      due: p.quote()!.total,
      ordered: new Map(p.lines.map((l) => [l.id, l])),
      ranOut: ran.id,
      endedEarly: null,
      readBackRevision: null,
    };
    return p;
  }
  alternatives(item: MenuItem): string[] {
    return [...MENU.values()]
      .filter((m) => m.category === item.category && !this.soldOut.has(m.id) && m.id !== item.id)
      .map((m) => m.name);
  }
  async checkAllergen(allergen: Allergen, severe: boolean): Promise<string[]> {
    this.allergies.set(allergen, severe || (this.allergies.get(allergen) ?? false));
    await this.publish({ allergies: this.allergiesJson() });
    return [...MENU.values()]
      .filter((m) => m.allergens.has(allergen))
      .map((m) => m.name)
      .concat(
        [...SAUCES.values()]
          .filter((s) => s.allergens.has(allergen))
          .map((s) => `wings with ${s.name} sauce`),
        [...TOPPINGS.values()]
          .filter((t) => t.allergens.has(allergen))
          .map((t) => `${t.name} as a topping`),
      );
  }
  async addItems(specs: ItemSpec[]): Promise<[Line[], string[]]> {
    this.takingOrder();
    const added: Line[] = [],
      problems: string[] = [];
    for (const spec of specs) {
      try {
        const line = this.build(this.peekLineId(), spec.itemId, spec.size, spec.quantity, spec);
        const waiting =
          line.sauce &&
          this.lines.find(
            (l) => l.needs === 'sauce' && l.item.id === line.item.id && l.size === line.size,
          );
        const same = [...this.lines, ...added].find((l) => l.configuration === line.configuration);
        if (waiting)
          problems.push(
            `${waiting.id}, the ${waiting.label}, is waiting on its sauce. If this is that sauce, update_item ${waiting.id} with it; only if they want another order besides ${waiting.id}, add this once ${waiting.id} has its sauce.`,
          );
        else if (same)
          problems.push(
            `${line.label} is already on the order as ${same.id} (${same.describe()}). Saying it again isn't more: only if they ask for more, update_item ${same.id} with the new total.`,
          );
        else {
          this.nextLine++;
          added.push(line);
        }
      } catch (e) {
        if (e instanceof PizzeriaError) problems.push(e.message);
        else throw e;
      }
    }
    if (added.length) {
      this.lines.push(...added);
      await this.changed();
    }
    return [added, problems];
  }
  async updateItem(lineId: string, changes: Partial<ItemSpec>): Promise<[Line, boolean]> {
    this.takingOrder();
    const cur = this.line(lineId),
      item = changes.itemId ? MENU.get(changes.itemId)! : cur.item,
      sameItem = item.id === cur.item.id;
    const line = this.build(
      cur.id,
      item.id,
      changes.size ?? (Object.hasOwn(item.prices, cur.size ?? '') ? cur.size : null),
      changes.quantity ?? cur.quantity,
      {
        toppings:
          changes.toppings ??
          (item.category === 'pizza' ? cur.toppings.map((v) => v.id as ToppingId) : []),
        sauce: changes.sauce ?? (item.category === 'wings' ? (cur.sauce?.id as SauceId) : null),
        without: changes.without ?? cur.without.filter((v) => item.ingredients.includes(v)),
        firstHalf:
          changes.firstHalf ??
          (item.category === 'pizza' ? cur.halves[0].map((v) => v.id as ToppingId) : []),
        secondHalf:
          changes.secondHalf ??
          (item.category === 'pizza' ? cur.halves[1].map((v) => v.id as ToppingId) : []),
        soldOutOk: sameItem,
      },
    );
    if (line.configuration === cur.configuration && line.quantity === cur.quantity)
      return [cur, false];
    const same = this.lines.find((l) => l.id !== line.id && l.configuration === line.configuration);
    if (same)
      throw new PizzeriaError(
        `That would make it the same as ${same.id} (${same.describe()}). Change ${same.id}'s quantity instead, and remove ${line.id}.`,
      );
    this.lines = this.lines.map((l) => (l.id === line.id ? line : l));
    await this.changed();
    return [line, true];
  }
  async removeItem(id: string): Promise<Line> {
    this.takingOrder();
    const l = this.line(id);
    this.lines = this.lines.filter((v) => v !== l);
    await this.changed();
    return l;
  }
  async setFulfillment(
    mode?: Mode | null,
    address?: string | null,
    zipCode?: string | null,
    driverNote?: string | null,
  ): Promise<Fulfillment> {
    this.takingOrder();
    mode ??= this.fulfillment.mode;
    if (!mode) throw new PizzeriaError("Ask whether it's pickup or delivery first.");
    let next: Fulfillment;
    if (mode === 'pickup') {
      if (driverNote)
        throw new PizzeriaError(
          "It's a pickup order, so there's no driver to tell. If they meant delivery, ask for the address.",
        );
      next = { mode, address: null, zipCode: null, driverNote: null };
    } else {
      const was =
        this.fulfillment.mode === 'delivery'
          ? this.fulfillment
          : { mode: null, address: null, zipCode: null, driverNote: null };
      next = {
        mode,
        address: text(address) || was.address,
        zipCode: zipCode ? zip(zipCode) : was.zipCode,
        driverNote:
          driverNote !== undefined && driverNote !== null ? note(driverNote) : was.driverNote,
      };
      if (!next.address) throw new PizzeriaError('Ask for the street address to deliver to.');
    }
    if (JSON.stringify(next) !== JSON.stringify(this.fulfillment)) {
      this.fulfillment = next;
      await this.changed();
    }
    return next;
  }
  async setContact(name?: string | null, phone?: string | null): Promise<void> {
    this.takingOrder();
    if (phone !== undefined && phone !== null) {
      let d = phone.replace(/\D/g, '');
      if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
      if (!realUsNumber(d))
        throw new PizzeriaError(
          `${d || 'That'} isn't a ten-digit US number. If what they said is one, pass all ten digits again; otherwise ask them to say it again.`,
        );
      this.phone = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }
    if (name !== undefined && text(name)) this.name = text(name);
  }
  async setTip(dollars?: number | null, percent?: number | null): Promise<number> {
    this.canChange();
    if ((dollars == null) === (percent == null))
      throw new PizzeriaError('Pass the tip as dollars or as a percent, one of the two.');
    let amount: number;
    if (percent != null) {
      if (percent < 0 || percent > 100)
        throw new PizzeriaError('A tip percent is between 0 and 100.');
      amount = Math.round((this.subtotal() * percent) / 100);
    } else amount = decimalDollarsToCents(dollars!);
    if (amount < 0 || amount > MOST_TIP)
      throw new PizzeriaError(`A tip is between $0 and ${money(MOST_TIP)}.`);
    if (amount !== this.tip) {
      this.tip = amount;
      await this.changed();
    }
    return amount;
  }
  orderReadBack(): Json {
    this.readyToPlace();
    return {
      items: this.lines.map((l) => l.describe()),
      pickupOrDelivery:
        this.fulfillment.mode === 'pickup' ? 'pickup' : `delivery to ${this.fulfillment.address}`,
      driverNote: this.fulfillment.driverNote,
      ...this.quote()!.facts(),
      payment: this.payment(),
    };
  }
  async place(): Promise<Order> {
    this.readyToPlace();
    const readyIn =
      this.fulfillment.mode === 'delivery'
        ? `delivered in about ${DATA.deliveryMinutes[0]} to ${DATA.deliveryMinutes[1]} minutes`
        : `ready for pickup in about ${DATA.pickupMinutes} minutes`;
    this.order = { number: String(this.nextOrder++), readyIn, cancelled: false };
    await this.publish({ order: this.orderJson() });
    return this.order;
  }
  cancelReadBack(): Json {
    const o = this.cancellable();
    return {
      cancel: `order ${o.number}`,
      ...(this.delivery ? { goesOut: false } : {}),
      due: money(0),
    };
  }
  async cancel(): Promise<Order> {
    const o = this.cancellable();
    o.cancelled = true;
    this.revision++;
    await this.publish({ order: this.orderJson(), delivery: this.deliveryJson() });
    return o;
  }
  dropReadBack(): Json {
    this.takingOrder();
    if (!this.lines.length)
      throw new PizzeriaError("Nothing's on the order, so there's nothing to drop.");
    return { drop: this.lines.map((l) => l.describe()), placed: false, due: money(0) };
  }
  async drop(): Promise<void> {
    this.takingOrder();
    this.lines = [];
    this.tip = 0;
    await this.changed();
  }
  ranOutLine(): Line {
    const d = this.out();
    return this.linesById().get(d.ranOut) ?? d.ordered.get(d.ranOut)!;
  }
  samePriceSwaps(): string[] {
    const d = this.out(),
      was = d.ordered.get(d.ranOut)!;
    return [...MENU.values()].flatMap((m) =>
      m.category === was.item.category && !this.soldOut.has(m.id)
        ? Object.entries(m.prices)
            .filter(([, p]) => p === was.item.prices[was.size ?? ''])
            .map(([s]) => `${sizeWords(s)} ${m.name}`.trim())
        : [],
    );
  }
  soldOutUnresolved(): boolean {
    const l = this.linesById().get(this.out().ranOut);
    return !!l && this.soldOut.has(l.item.id);
  }
  async swapSoldOutItem(itemId: ItemId): Promise<Line> {
    const d = this.onTheWay(),
      was = d.ordered.get(d.ranOut)!,
      item = MENU.get(itemId)!;
    if (this.soldOut.has(item.id))
      throw new PizzeriaError(
        `The ${item.name} is out too. Same-price options: ${orList(this.samePriceSwaps())}.`,
      );
    const size = Object.entries(item.prices).find(
      ([, p]) => p === was.item.prices[was.size ?? ''],
    )?.[0];
    if (item.category !== was.item.category || size === undefined)
      throw new PizzeriaError(
        `The ${was.label} can only be swapped for something at the same price: ${orList(this.samePriceSwaps())}. Or take it off.`,
      );
    const line = new Line(
      was.id,
      item,
      size || null,
      was.quantity,
      was.toppings,
      was.sauce,
      was.without,
      was.halves,
    );
    if (this.linesById().get(d.ranOut)?.item.id === item.id) return line;
    this.lines = [...this.lines.filter((l) => l.id !== d.ranOut), line].sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
    await this.changed();
    return line;
  }
  async takeOffSoldOutItem(): Promise<number> {
    const d = this.onTheWay();
    if (!this.linesById().has(d.ranOut))
      throw new PizzeriaError(`The ${d.ordered.get(d.ranOut)!.label} is already off the order.`);
    const before = this.dueNow();
    this.lines = this.lines.filter((l) => l.id !== d.ranOut);
    await this.changed();
    return before - this.dueNow();
  }
  async setBreadsticks(orders: number): Promise<number> {
    const d = this.onTheWay();
    if (orders < 0 || orders > DATA.outForDelivery.mostExtras)
      throw new PizzeriaError(
        `${d.driver} can take at most ${DATA.outForDelivery.mostExtras} orders of breadsticks.`,
      );
    const before = this.dueNow(),
      existing = this.lines.find((l) => l.item.id === 'breadsticks'),
      others = this.lines.filter((l) => l.item.id !== 'breadsticks');
    if ((existing?.quantity ?? 0) === orders) return 0;
    if (orders)
      others.push(
        existing
          ? new Line(existing.id, existing.item, existing.size, orders)
          : this.build(this.newLineId(), 'breadsticks', null, orders),
      );
    this.lines = others;
    await this.changed();
    return this.dueNow() - before;
  }
  async setDriverNote(value: string): Promise<string> {
    this.onTheWay();
    const n = note(value);
    if (n !== this.fulfillment.driverNote) {
      this.fulfillment = { ...this.fulfillment, driverNote: n };
      await this.changed();
    }
    return value;
  }
  changes(): string[] {
    const d = this.out();
    if (this.order?.cancelled) return [`Order ${this.order.number} cancelled: nothing is due`];
    const now = this.linesById(),
      out: string[] = [];
    for (const [id, was] of d.ordered) {
      const l = now.get(id);
      if (!l) out.push(`${was.label} taken off`);
      else if (l.item.id !== was.item.id)
        out.push(`${was.label} swapped for a ${l.label}, same price`);
    }
    for (const [id, l] of now)
      if (!d.ordered.has(id))
        out.push(`${l.quantity} ${l.quantity === 1 ? 'order' : 'orders'} of ${l.label} added`);
    if (this.fulfillment.driverNote)
      out.push(`Note for ${d.driver}: ${this.fulfillment.driverNote}`);
    if (this.tip) out.push(`${money(this.tip)} tip for ${d.driver}`);
    return out;
  }
  async readBackChanges(): Promise<Json> {
    const d = this.out();
    if (this.soldOutUnresolved() && !this.order?.cancelled)
      throw new PizzeriaError(
        `The ${this.ranOutLine().label} is still on the order. Ask whether they'd like ${orList(this.samePriceSwaps())} instead, or to take it off.`,
      );
    d.readBackRevision = this.revision;
    await this.publish({ delivery: this.deliveryJson() });
    const cancelled = !!this.order?.cancelled;
    return {
      changes: this.changes().length ? this.changes() : ['no changes'],
      dueAtTheDoor: money(this.dueNow()),
      comparedToBefore: compared(this.balance()),
      driver: d.driver,
      arrivesInMinutes: cancelled ? null : d.etaMinutes,
    };
  }
  async endEarly(reason: EndedEarly): Promise<void> {
    this.out().endedEarly = reason;
    await this.publish({ delivery: this.deliveryJson() });
  }
  dueNow(): number {
    return this.order?.cancelled ? 0 : this.quote()?.total ?? 0;
  }
  balance(): number {
    return this.dueNow() - this.out().due;
  }
  linesById(): Map<string, Line> {
    return new Map(this.lines.map((l) => [l.id, l]));
  }
  subtotal(): number {
    return this.lines.reduce((n, l) => n + l.total, 0);
  }
  quote(): Quote | null {
    if (!this.lines.length) return null;
    const subtotal = this.subtotal();
    return new Quote(
      subtotal,
      Math.floor((subtotal * DATA.taxRatePercent + 50) / 100),
      this.fulfillment.mode === 'delivery' ? DATA.deliveryFee : 0,
      subtotal < DATA.smallOrderUnder ? DATA.smallOrderFee : 0,
      this.tip,
    );
  }
  payment(): string | null {
    if (this.order?.cancelled) return 'Nothing is due: the order is cancelled';
    if (this.fulfillment.mode === 'pickup') return 'Pay at pickup, cash or card';
    if (this.fulfillment.mode === 'delivery') return 'Pay the driver at the door, cash or card';
    return null;
  }
  stillToAsk(): string[] {
    return this.lines
      .filter((l) => l.needs === 'sauce')
      .map(
        (l) =>
          `Which sauce on ${l.id}, the ${l.label}: ${orList([...SAUCES.values()].map((s) => s.name))}. They choose; if they'd rather not have them, remove_item ${l.id}.`,
      );
  }
  cartFacts(): Json {
    const q = this.quote(),
      asks = this.stillToAsk();
    return {
      order: this.lines.map((l) => l.facts()),
      ...(q ? { subtotal: money(q.subtotal) } : {}),
      ...(asks.length ? { stillToAsk: asks } : {}),
    };
  }
  async publishAll(): Promise<void> {
    await this.publish({
      menu: this.menuJson(),
      allergies: this.allergiesJson(),
      order: this.orderJson(),
      ...this.orderStateJson(),
    });
  }
  private build(
    id: string,
    itemId: ItemId,
    size?: string | null,
    quantity = 1,
    opts: Partial<ItemSpec> & { soldOutOk?: boolean } = {},
  ): Line {
    const item = MENU.get(itemId)!;
    if (this.soldOut.has(item.id) && !opts.soldOutOk)
      throw new PizzeriaError(
        `The ${item.name} is sold out today. Offer one or two of these instead: ${this.alternatives(item).join(', ')}.`,
      );
    const sizes = Object.keys(item.prices).filter(Boolean);
    if (sizes.length) {
      if (!size)
        throw new PizzeriaError(`Ask which size ${item.name}: ${orList(sizes.map(sizeWords))}.`);
      if (!sizes.includes(size))
        throw new PizzeriaError(
          `${item.name} comes in ${orList(sizes.map(sizeWords))}, not ${sizeWords(size)}. Ask which.`,
        );
    } else size = null;
    if (quantity < 1 || quantity > MOST_OF_ONE_ITEM)
      throw new PizzeriaError(`A quantity is between 1 and ${MOST_OF_ONE_ITEM}.`);
    const pizza = item.category === 'pizza';
    if (
      (opts.toppings?.length ||
        opts.firstHalf?.length ||
        opts.secondHalf?.length ||
        opts.without?.length) &&
      !pizza
    )
      throw new PizzeriaError(`Only pizzas take toppings or changes, not the ${item.name}.`);
    if (opts.sauce && item.category !== 'wings')
      throw new PizzeriaError(`The ${item.name} doesn't take a sauce choice.`);
    const whole = unique((opts.toppings ?? []).map((v) => TOPPINGS.get(v)!)),
      halves: [Option[], Option[]] = [
        unique((opts.firstHalf ?? []).map((v) => TOPPINGS.get(v)!)),
        unique((opts.secondHalf ?? []).map((v) => TOPPINGS.get(v)!)),
      ];
    const both = halves[0].filter((t) => halves[1].includes(t));
    if (both.length)
      throw new PizzeriaError(
        `${both.map((v) => v.name).join(' and ')} on both halves goes on the whole pizza: pass it in toppings instead.`,
      );
    const doubled = [...halves[0], ...halves[1]].filter((t) => whole.includes(t));
    if (doubled.length)
      throw new PizzeriaError(
        `${doubled.map((v) => v.name).join(' and ')} is already on the whole pizza.`,
      );
    const missing = (opts.without ?? []).filter((i) => !item.ingredients.includes(i));
    if (missing.length)
      throw new PizzeriaError(
        `The ${item.name} doesn't come with ${missing.join(' or ')}, so there's nothing to leave off. It comes with ${item.ingredients.join(', ')}.`,
      );
    return new Line(
      id,
      item,
      size ?? null,
      quantity,
      whole,
      opts.sauce ? SAUCES.get(opts.sauce)! : null,
      [...new Set(opts.without ?? [])],
      halves,
    );
  }
  private line(id: string): Line {
    const l = this.linesById().get(id);
    if (!l)
      throw new PizzeriaError(
        `There's no line ${id} on the order. Lines: ${this.lines.map((v) => v.id).join(', ') || 'none'}.`,
      );
    return l;
  }
  private peekLineId(): string {
    return `L${this.nextLine}`;
  }
  private newLineId(): string {
    const id = this.peekLineId();
    this.nextLine++;
    return id;
  }
  private takingOrder(): void {
    if (this.delivery)
      throw new PizzeriaError(
        `Order ${DATA.outForDelivery.orderNumber} is packed and about to go out: only the item that ran out, breadsticks, a note for the driver, and a tip can change.`,
      );
    if (this.order)
      throw new PizzeriaError(
        `Order ${this.order.number} was already ${this.order.cancelled ? 'cancelled' : 'sent to the kitchen'}.`,
      );
  }
  private canChange(): void {
    if (this.delivery) this.onTheWay();
    else this.takingOrder();
  }
  private readyToPlace(): void {
    this.takingOrder();
    if (!this.lines.length) throw new PizzeriaError("Nothing's on the order yet.");
    const asks = this.stillToAsk();
    if (asks.length) throw new PizzeriaError(asks.join(' '));
    if (!this.fulfillment.mode)
      throw new PizzeriaError(
        "Pickup or delivery isn't set: set_pickup or set_delivery if they've said, or ask.",
      );
    if (!this.name)
      throw new PizzeriaError(
        "There's no name on the order: set_contact if they gave one, or ask.",
      );
    if (!this.phone)
      throw new PizzeriaError("There's no callback number: set_contact if they gave one, or ask.");
  }
  private cancellable(): Order {
    if (this.delivery) this.onTheWay();
    if (!this.order)
      throw new PizzeriaError(
        "Nothing has been placed, so there's nothing to cancel and nothing is due.",
      );
    if (this.order.cancelled)
      throw new PizzeriaError(`Order ${this.order.number} is already cancelled.`);
    return this.order;
  }
  private out(): Delivery {
    if (!this.delivery) throw new PizzeriaError("There's no order out for delivery on this call.");
    return this.delivery;
  }
  private onTheWay(): Delivery {
    const d = this.out();
    if (d.endedEarly === 'wrong_person')
      throw new PizzeriaError(
        "Whoever answered isn't the customer: share and change nothing. Say goodbye.",
      );
    if (this.order?.cancelled)
      throw new PizzeriaError(
        `Order ${this.order.number} is cancelled: it isn't going out and nothing is due.`,
      );
    return d;
  }
  private async changed(): Promise<void> {
    this.revision++;
    await this.publish(this.orderStateJson());
  }
  private orderStateJson(): Json {
    return {
      cart: this.cartJson(),
      fulfillment: {
        mode: this.fulfillment.mode,
        address: this.fulfillment.address,
        zip: this.fulfillment.zipCode,
        note: this.fulfillment.driverNote,
      },
      quote: this.quoteJson(),
      delivery: this.deliveryJson(),
    };
  }
  private menuJson(): Json[] {
    return [...MENU.values()].map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      allergens: [...m.allergens].sort(),
      available: !this.soldOut.has(m.id),
    }));
  }
  private cartJson(): Json {
    const ordered = this.delivery?.ordered ?? new Map<string, Line>();
    return {
      version: this.revision,
      lines: this.lines.map((l) => lineJson(l, ordered.get(l.id), this.soldOut)),
      subtotal: this.subtotal() / 100,
    };
  }
  private quoteJson(): Json | null {
    const q = this.quote();
    return q
      ? {
          subtotal: q.subtotal / 100,
          tax: q.tax / 100,
          deliveryFee: q.deliveryFee / 100,
          smallOrderFee: q.smallOrderFee / 100,
          tip: q.tip / 100,
          total: q.total / 100,
        }
      : null;
  }
  private orderJson(): Json | null {
    return this.order
      ? { number: this.order.number, readyIn: this.order.readyIn, cancelled: this.order.cancelled }
      : null;
  }
  private allergiesJson(): Json[] {
    return [...this.allergies].map(([allergen, severe]) => ({ allergen, severe }));
  }
  private deliveryJson(): Json | null {
    const d = this.delivery;
    if (!d) return null;
    const cancelled = !!this.order?.cancelled;
    return {
      driver: d.driver,
      etaMinutes: d.etaMinutes,
      due: d.due / 100,
      dueNow: this.dueNow() / 100,
      balance: this.balance() / 100,
      note: this.fulfillment.driverNote,
      cancelled,
      changes: cancelled ? [] : this.changes(),
      endedEarly: d.endedEarly ? ENDED_EARLY[d.endedEarly] : null,
      readBack: d.readBackRevision === this.revision,
    };
  }
}

function lineJson(line: Line, was: Line | undefined, soldOut: Set<ItemId>): Json {
  const pieces: Record<string, string> = { half_dozen: '6', dozen: '12' },
    swapped = !!was && was.item.id !== line.item.id;
  return {
    id: line.id,
    itemId: line.item.id,
    name: line.item.name,
    size: (pieces[line.size ?? ''] ?? sizeWords(line.size)) || null,
    quantity: line.quantity,
    modifiers: line.modifiers,
    needs: line.needs,
    total: line.total / 100,
    out: soldOut.has(line.item.id),
    was: was && swapped ? `${was.label[0]!.toUpperCase()}${was.label.slice(1)}` : null,
  };
}
function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
function text(v?: string | null): string {
  return (v ?? '').trim().replace(/\s+/g, ' ');
}
function zip(v: string): string {
  const d = v.replace(/\D/g, '');
  if (d.length !== 5)
    throw new PizzeriaError('A ZIP code is five digits. Ask for it again, or leave it out.');
  return d;
}
function note(v: string): string {
  const n = text(v);
  if (!n) throw new PizzeriaError('The note is empty. Ask what the driver should know.');
  if (n.length > 200)
    throw new PizzeriaError(
      "That's too long for the driver. Ask for the key details in a few words.",
    );
  return n;
}
function realUsNumber(d: string): boolean {
  if (d.length !== 10 || new Set(d).size === 1) return false;
  return [d.slice(0, 3), d.slice(3, 6)].every((p) => !'01'.includes(p[0]!) && p.slice(1) !== '11');
}

function decimalDollarsToCents(value: number): number {
  if (!Number.isFinite(value)) throw new PizzeriaError('A tip must be a finite number.');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new PizzeriaError('A tip must be a number.');

  const digits = BigInt(match[2]! + (match[3] ?? ''));
  const scale = Number(match[4] ?? 0) - (match[3]?.length ?? 0) + 2;
  let cents: bigint;
  if (scale >= 0) {
    cents = digits * 10n ** BigInt(scale);
  } else {
    const divisor = 10n ** BigInt(-scale);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    cents = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }
  return Number(match[1] === '-' ? -cents : cents);
}
