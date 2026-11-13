// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const BANK_NAME = 'Kestrel Bank';
export const VERIFIED_CARD = '1111';
export const DECLINED_CARD = '0000';
export const MAX_ATTEMPTS = 3;
export const EARLIEST_BIRTH_DATE = '1900-01-01';

export type DateOnly = `${number}-${number}-${number}`;
export type CardState = 'active' | 'locked';

export class BankError extends Error {}

export type Identity = {
  name: string;
  dateOfBirth: DateOnly;
  lastFour: string;
};

export type FlaggedPurchase = {
  merchant: string;
  place: string;
  country: string;
  amount: string;
};

export const FLAGGED: FlaggedPurchase = {
  merchant: 'Trattoria da Enzo',
  place: 'Rome, Italy',
  country: 'Italy',
  amount: '186.40',
};
export const LOSS_PREVENTION_CASE = 'LP-20417';
export const LONGEST_TRAVEL_NOTICE_DAYS = 90;

export type TravelNotice = { destination: string; until: DateOnly };

export class Card {
  lastFour = VERIFIED_CARD;
  holder: string | null = null;
  state: CardState = 'active';
  caseId: string | null = null;
  travel: TravelNotice | null = null;

  toJSON() {
    return {
      lastFour: this.lastFour,
      holder: this.holder,
      state: this.state,
      caseId: this.caseId,
      travel: this.travel,
    };
  }
}

export class Alert {
  purchase = FLAGGED;
  checks: boolean[] = [];
  madeByCardholder: boolean | null = null;

  toJSON() {
    return {
      purchase: this.purchase,
      checks: this.checks,
      madeByCardholder: this.madeByCardholder,
    };
  }
}

export type PublishedValue = Record<string, unknown> | unknown[] | string | boolean | null;
export type Publish = (key: string, value: PublishedValue) => Promise<void>;

export class Bank {
  readonly attempts: Array<{ submitted: Record<string, string>; authenticated: boolean }> = [];
  verified = false;
  lockedOut = false;
  readonly card = new Card();
  alert: Alert | null = null;

  constructor(private readonly publish: Publish = async () => {}) {}

  async authenticate(claimed: Identity): Promise<boolean> {
    if (this.lockedOut) {
      throw new BankError('This caller is locked out after too many failed checks.');
    }
    const verified = claimed.lastFour === VERIFIED_CARD;
    this.attempts.push({
      submitted: {
        name: claimed.name,
        dateOfBirth: claimed.dateOfBirth,
        lastFour: claimed.lastFour,
      },
      authenticated: verified,
    });
    await this.publish('attempts', this.attempts);
    if (verified) {
      await this.verifyHolder(claimed.name);
    } else if (this.attempts.filter((attempt) => !attempt.authenticated).length >= MAX_ATTEMPTS) {
      this.lockedOut = true;
      await this.publish('lockedOut', true);
    }
    await this.setVerified(verified);
    return verified;
  }

  async openAlert(): Promise<Alert> {
    this.alert = new Alert();
    await this.publishAlert();
    await this.publishCard();
    return this.alert;
  }

  async confirmCardholder(name: string): Promise<void> {
    const alert = this.requireAlert();
    alert.checks.push(true);
    await this.publishAlert();
    await this.verifyHolder(name);
    await this.setVerified(true);
  }

  async recentCharges(): Promise<Alert> {
    this.requireVerified();
    if (this.alert === null) {
      this.alert = new Alert();
      await this.publishAlert();
    }
    return this.alert;
  }

  async recordAnswer(madeByCardholder: boolean): Promise<Card> {
    this.requireVerified();
    const alert = this.requireAlert();
    alert.madeByCardholder = madeByCardholder;
    if (madeByCardholder) {
      if (this.card.caseId !== null) {
        this.card.state = 'active';
        this.card.caseId = null;
      }
    } else {
      this.card.state = 'locked';
      this.card.caseId = LOSS_PREVENTION_CASE;
      this.card.travel = null;
    }
    await this.publishAlert();
    await this.publishCard();
    return this.card;
  }

  async lockCard(): Promise<Card> {
    this.requireVerified();
    this.card.state = 'locked';
    this.card.travel = null;
    await this.publishCard();
    return this.card;
  }

  async setTravelNotice(destination: string, until: DateOnly, today: DateOnly): Promise<Card> {
    this.requireVerified();
    if (this.card.state === 'locked') {
      throw new BankError("The card is locked, so a travel notice wouldn't do anything.");
    }
    const days = daysBetween(today, until);
    if (days < 0) throw new BankError("The return date has already passed. Ask when they're back.");
    if (days > LONGEST_TRAVEL_NOTICE_DAYS) {
      throw new BankError(`A travel notice can cover at most ${LONGEST_TRAVEL_NOTICE_DAYS} days.`);
    }
    this.card.travel = { destination: destination.trim(), until };
    await this.publishCard();
    return this.card;
  }

  private requireAlert(): Alert {
    if (this.alert === null) throw new BankError("There's no flagged purchase on this call.");
    return this.alert;
  }

  private requireVerified(): void {
    if (!this.verified) throw new BankError('Verify the caller first.');
  }

  private async verifyHolder(name: string): Promise<void> {
    this.card.holder = name;
    await this.publishCard();
  }

  private async publishAlert(): Promise<void> {
    await this.publish('alert', this.requireAlert().toJSON());
  }

  private async publishCard(): Promise<void> {
    await this.publish('card', this.card.toJSON());
  }

  private async setVerified(verified: boolean): Promise<void> {
    this.verified = verified;
    await this.publish('status', verified ? 'authenticated' : 'unauthenticated');
  }
}

export function cardDigits(text: string): string {
  const digits = Array.from(text).filter((character) => /\p{Decimal_Number}/u.test(character));
  if (digits.length !== 4) {
    throw new BankError(`Ask for the card's last four digits, got ${JSON.stringify(text)}.`);
  }
  return digits.join('');
}

export function parseDateOnly(text: string): DateOnly {
  const value = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BankError(`Use YYYY-MM-DD for the date of birth, got ${JSON.stringify(text)}.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new BankError(`Use YYYY-MM-DD for the date of birth, got ${JSON.stringify(text)}.`);
  }
  return value as DateOnly;
}

export function birthDate(text: string, today: DateOnly): DateOnly {
  const born = parseDateOnly(text);
  if (born < EARLIEST_BIRTH_DATE || born >= today) {
    throw new BankError("That can't be a date of birth. Ask for it again.");
  }
  return born;
}

export function addDays(date: DateOnly, days: number): DateOnly {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10) as DateOnly;
}

export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
