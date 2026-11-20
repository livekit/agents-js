// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  type BmwModel,
  DEALERSHIP,
  type EndedEarly,
  type Finding,
  LOANER_MIN_HOURS,
  type Moment,
  type PartOfDay,
  type PickupRide,
  type Priceable,
  type RepairDecision,
  type RepairId,
  type Ride,
  type Service,
  type ServiceDesk,
  ServiceDeskError,
  type Sound,
  type UnsafeReason,
  type WarrantyPart,
  likelyCause,
  serviceLabel,
  spoken,
} from './service_desk.js';

export const PERSONA = 'Nick';
export const GREETING = `Thanks for calling ${DEALERSHIP} service, this is ${PERSONA}. How can I help you today?`;
const facts = (fields: Record<string, unknown>): string => JSON.stringify(fields);
const execute = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ServiceDeskError) throw new llm.ToolError(error.message);
    throw error;
  }
};
const dollars = (amount: number): string => `$${amount.toLocaleString('en-US')}`;
const serviceEnum = z.enum([
  'oil_change',
  'tire_rotation',
  'diagnostic',
  'warranty_repair',
  'recall',
]);
const rideEnum = z.enum(['wait', 'shuttle', 'loaner']);
const soundEnum = z.enum([
  'grinding',
  'squealing',
  'clunking',
  'humming',
  'clicking',
  'rattling',
  'other',
]);
const momentEnum = z.enum([
  'braking',
  'turning',
  'over_bumps',
  'at_speed',
  'idling',
  'cold_start',
  'all_the_time',
  'other',
]);
const modelEnum = z.enum([
  '1 Series',
  '2 Series',
  '3 Series',
  '4 Series',
  '5 Series',
  '7 Series',
  '8 Series',
  'X1',
  'X2',
  'X3',
  'X4',
  'X5',
  'X6',
  'X7',
  'XM',
  'Z4',
  'i4',
  'i5',
  'i7',
  'iX',
  'M2',
  'M3',
  'M4',
  'M5',
  'M8',
]);

type Review = { action: string; target: string; revision: number };
class Advisor extends voice.Agent<ServiceDesk> {
  protected review?: Review;
  constructor(
    protected readonly desk: ServiceDesk,
    instructions: string,
    tools: llm.ToolContextEntry<ServiceDesk>[],
  ) {
    super({ instructions, tools });
  }
  protected reviewed(action: string, target: string): boolean {
    return (
      this.review?.action === action &&
      this.review.target === target &&
      this.review.revision === this.desk.revision
    );
  }
  protected readBack(action: string, target: string): void {
    this.review = { action, target, revision: this.desk.revision };
  }
}

export class ServiceAdvisor extends Advisor {
  constructor(desk: ServiceDesk) {
    const tools: llm.ToolContextEntry<ServiceDesk>[] = [];
    super(desk, inboundInstructions(desk), tools);
    tools.push(
      llm.tool({
        name: 'find_customer',
        description:
          "Look up the caller's file by their name and phone number. Ask for the name, then the number, then call this.",
        parameters: z.object({
          fullName: z.string().describe('Their first and last name, as they gave it.'),
          phone: z.string().describe("The phone number's digits, exactly as they said them."),
        }),
        execute: async ({ fullName, phone }) => {
          const customer = await execute(() => desk.findCustomer(fullName, phone));
          return customer
            ? facts({
                found: true,
                file: desk.fileJson(),
                next: "Record what they've already told you now: choose_vehicle for the car they named, describe_problem for the problem. If they've asked to move or cancel an appointment, call that tool now: it gives you what to read back.",
              })
            : facts({
                found: false,
                next: "They're probably new. Never say you couldn't find them: unless they've said they're new, ask if they've been in before. If they have, ask them to spell their last name and look again. Otherwise call open_new_file.",
              });
        },
      }),
      llm.tool({
        name: 'open_new_file',
        description: "Set up a new file for a caller who doesn't have one.",
        parameters: z.object({ fullName: z.string(), phone: z.string() }),
        execute: async ({ fullName, phone }) => {
          await execute(() => desk.openNewFile(fullName, phone));
          return facts({
            file: desk.fileJson(),
            next: "Record what they've already told you about the problem with describe_problem, then ask what car it is.",
          });
        },
      }),
      llm.tool({
        name: 'choose_vehicle',
        description:
          'Put one of the cars on their file on this visit. Call again if they switch cars, or to record the mileage they read off the odometer.',
        parameters: z.object({
          vehicleId: z.string().describe("The car's vehicleId from their file."),
          currentMileage: z
            .number()
            .int()
            .optional()
            .describe('Only if they told you the current mileage.'),
        }),
        execute: async ({ vehicleId, currentMileage }) => {
          const changed = await execute(() => desk.chooseVehicle(vehicleId, currentMileage));
          return facts({ car: desk.visit.vehicle!.toJson(desk.today), changed });
        },
      }),
      llm.tool({
        name: 'add_vehicle',
        description:
          "Add a car that isn't on their file, and put it on this visit. Ask the year and model, then the mileage. This desk services BMWs only.",
        parameters: z.object({
          year: z.number().int().describe('The model year.'),
          model: modelEnum.describe('The BMW model, e.g. "330i" is the 3 Series.'),
          mileage: z.number().int().describe('Their best guess at the odometer reading.'),
        }),
        execute: async ({ year, model, mileage }) =>
          facts({
            car: (await execute(() => desk.addVehicle(year, model as BmwModel, mileage))).toJson(
              desk.today,
            ),
          }),
      }),
      llm.tool({
        name: 'describe_problem',
        description:
          "Record what the caller tells you about the problem, as soon as they say it. Pass only what they just told you; leave out what they haven't said, never 'unknown'. Anything you leave out stays as it was. A correction is the same field again.",
        parameters: z.object({
          summary: z
            .string()
            .optional()
            .describe('The problem in a few words, for the technician and the read-back.'),
          sound: soundEnum.optional().describe('What it sounds like.'),
          where: z.string().optional().describe('Where it seems to come from, in their words.'),
          when: momentEnum.optional().describe('When it happens.'),
          since: z.string().optional().describe("How long it's been going on, in their words."),
          warningLights: z
            .string()
            .optional()
            .describe('Which lights are on, or "no warning lights" when they said there are none.'),
          recentWork: z
            .string()
            .optional()
            .describe(
              'Recent work, new tires, an accident, or "nothing recent" when they said there has been none.',
            ),
        }),
        execute: async (args) => {
          const problem = await execute(() =>
            desk.describeProblem(
              args as {
                summary?: string;
                sound?: Sound;
                where?: string;
                when?: Moment;
                since?: string;
                warningLights?: string;
                recentWork?: string;
              },
            ),
          );
          const cause = likelyCause(problem.sound, problem.when);
          return facts({
            problem: problem.toJson(),
            oftenPointsTo: cause ? { cause: cause.cause, advice: cause.advice } : null,
          });
        },
      }),
      llm.tool({
        name: 'flag_unsafe_to_drive',
        description:
          "The car isn't safe to drive at all: the brakes don't stop it, smoke or burning, steering that fails, a red or flashing warning light, or overheating. Call it the moment they describe one. A noise on its own isn't one.",
        parameters: z.object({
          reason: z.enum([
            'brakes_failing',
            'smoke_or_burning',
            'steering_failing',
            'red_or_flashing_warning_light',
            'overheating',
          ]),
        }),
        execute: async ({ reason }) => {
          await execute(() => desk.flagUnsafeToDrive(reason as UnsafeReason));
          return facts({
            unsafeToDrive: reason,
            next: "Tell them now, plainly, not to drive it and to have it towed in; the desk can't arrange the tow. Then offer the earliest time.",
          });
        },
      }),
      llm.tool({
        name: 'quote_price',
        description: 'Look up a price before saying one.',
        parameters: z.object({
          item: z
            .enum([
              'oil_change',
              'tire_rotation',
              'diagnostic',
              'warranty_repair',
              'recall',
              'shuttle',
              'loaner',
              'waiting_lounge',
              'this_visit',
              'something_else',
            ])
            .describe(
              "What they asked about. Anything that isn't a menu service, like a brake job, is something_else. this_visit is the total for what's on the visit.",
            ),
        }),
        execute: async ({ item }) => facts(desk.quote(item as Priceable)),
      }),
      llm.tool({
        name: 'add_service',
        description:
          "Add a service to the visit. A problem to look at, with the cause unknown, is a diagnostic. A warranty_repair is only for a specific part the caller says has stopped working, on a car in warranty: pass that part as failed_part. recall adds the car's open recall, at no charge.",
        parameters: z.object({
          service: serviceEnum,
          failedPart: z
            .enum([
              'electrical',
              'infotainment_or_electronics',
              'window_or_door',
              'liftgate_or_trunk',
              'climate',
              'engine',
              'transmission',
              'fluid_leak',
            ])
            .optional(),
        }),
        execute: async ({ service, failedPart }) => {
          await execute(() =>
            desk.addService(service as Service, failedPart as WarrantyPart | undefined),
          );
          return this.visitFacts();
        },
      }),
      llm.tool({
        name: 'remove_service',
        description: 'Take a service off the visit.',
        parameters: z.object({ service: serviceEnum }),
        execute: async ({ service }) => {
          await execute(() => desk.removeService(service as Service));
          return this.visitFacts();
        },
      }),
      llm.tool({
        name: 'find_times',
        description: "Find open times that fit the visit, or an appointment that's being moved.",
        parameters: z.object({
          day: z.string().optional(),
          partOfDay: z.enum(['morning', 'afternoon', 'any']).default('any'),
          appointmentId: z.string().optional(),
        }),
        execute: async ({ day, partOfDay, appointmentId }) => {
          const slots = await execute(() =>
            desk.openings(day, partOfDay as PartOfDay, appointmentId),
          );
          await desk.publishOpenings(slots);
          return facts({
            openings: slots
              .slice(0, 3)
              .map((s) => ({ slotId: s.id, when: spoken(s.startsAt), advisor: s.advisor })),
            more: Math.max(0, slots.length - 3),
          });
        },
      }),
      llm.tool({
        name: 'choose_time',
        description: 'Put a time on the visit.',
        parameters: z.object({ slotId: z.string().describe('A slotId from find_times.') }),
        execute: async ({ slotId }) => {
          await execute(() => desk.chooseTime(slotId));
          return this.visitFacts();
        },
      }),
      llm.tool({
        name: 'choose_ride',
        description:
          "How they'll get around during the visit: wait in the lounge, the free shuttle, or a loaner. Only once they've picked one.",
        parameters: z.object({ ride: rideEnum }),
        execute: async ({ ride }) => {
          await execute(() => desk.chooseRide(ride as Ride));
          return this.visitFacts();
        },
      }),
      llm.tool({
        name: 'set_approval_limit',
        description: 'The caller wants a call before any work over an amount.',
        parameters: z.object({ dollars: z.number().int() }),
        execute: async ({ dollars }) => {
          await execute(() => desk.setApprovalLimit(dollars));
          return this.visitFacts();
        },
      }),
      llm.tool({
        name: 'book_visit',
        description:
          "Book the visit. The first call checks it and returns what to read back to the caller. Call it again once they've said it's right. After any change, it's read back again; a visit already booked on this call is updated under the same confirmation.",
        parameters: z.object({}),
        execute: async () => {
          if (this.reviewed('book', ''))
            return facts({
              booked: (await execute(() => desk.book())).toJson(),
              next: "Tell them they're booked: the day, time, advisor, and ride. Then ask if there's anything else.",
            });
          const visit = await execute(() => desk.readBack());
          this.readBack('book', '');
          return facts({
            booked: false,
            readBack: visit,
            next: "It isn't booked: they haven't heard this read-back in full yet. Read all of it to them now as a question, the concern included, and ask if it's right. Call book_visit again once they agree.",
          });
        },
      }),
      llm.tool({
        name: 'reschedule_appointment',
        description:
          "Move an appointment that's already booked to another time. The first call returns the move to read back; call it again once the caller agrees.",
        parameters: z.object({ appointmentId: z.string(), slotId: z.string() }),
        execute: async ({ appointmentId, slotId }) => {
          const target = `${appointmentId}@${slotId}`;
          if (this.reviewed('move', target))
            return facts({
              moved: (await execute(() => desk.move(appointmentId, slotId))).toJson(),
            });
          const move = await execute(() => desk.moveReadBack(appointmentId, slotId));
          this.readBack('move', target);
          return facts({
            moved: false,
            readBack: move,
            next: "It isn't moved: they haven't heard this read-back in full yet. Read the move to them now and ask if that's right. Call reschedule_appointment again once they agree.",
          });
        },
      }),
      llm.tool({
        name: 'cancel_appointment',
        description:
          "Cancel an appointment that's already booked. The first call returns the cancellation to read back; call it again once the caller agrees.",
        parameters: z.object({ appointmentId: z.string() }),
        execute: async ({ appointmentId }) => {
          if (this.reviewed('cancel', appointmentId))
            return facts({
              cancelled: (await execute(() => desk.cancel(appointmentId))).toJson(),
              due: 0,
            });
          const cancellation = await execute(() => desk.cancelReadBack(appointmentId));
          this.readBack('cancel', appointmentId);
          return facts({
            cancelled: false,
            readBack: cancellation,
            next: "It isn't cancelled: they haven't heard this in full yet. Ask them now, using this, if they're sure they want it cancelled. Call cancel_appointment again once they agree.",
          });
        },
      }),
    );
    void this.updateTools(tools);
  }

  private visitFacts(): string {
    const visit = this.desk.visit;
    const car = visit.vehicle;
    const recall = car?.recall;
    return facts({
      services: visit.services.map((s) => ({
        service: serviceLabel(s, car),
        price: this.desk.price(s),
      })),
      openRecallNotAdded: recall && !visit.services.includes('recall') ? recall.title : null,
      time: visit.slot ? spoken(visit.slot.startsAt) : null,
      advisor: visit.slot?.advisor ?? null,
      ride: visit.ride ?? null,
      approvalLimit: visit.approvalLimit ?? null,
      estimate: this.desk.estimate(),
      loaner: this.desk.loanerEligible()
        ? 'This visit qualifies for a loaner.'
        : `No loaner: they're only for warranty or recall visits over ${LOANER_MIN_HOURS} hours.`,
      changedSinceBooked: this.desk.changedSinceBooked(),
      next:
        car &&
        visit.services.length &&
        visit.slot &&
        visit.ride &&
        (!visit.booked || this.desk.changedSinceBooked())
          ? "It isn't booked yet: call book_visit now and read back what it returns."
          : null,
    });
  }
}

export class RepairCallback extends Advisor {
  constructor(desk: ServiceDesk) {
    const tools: llm.ToolContextEntry<ServiceDesk>[] = [];
    super(desk, callbackInstructions(desk), tools);
    tools.push(
      llm.tool({
        name: 'go_over_findings',
        description:
          "Get what the technician found on the repair that needs doing now, to tell the customer. Only once they've confirmed they're the customer.",
        parameters: z.object({}),
        execute: async () => {
          const finding = await execute(() => desk.shareFindings());
          const ready = desk.readyAt([finding]);
          this.readBack('approve', finding.id);
          return facts({
            repairId: finding.id,
            repair: finding.title,
            found: finding.spoken,
            price: finding.price,
            readyIfApproved: ready ? desk.said(ready) : 'now',
            next: 'Tell them what the technician found, the price, and when the car would be ready, and ask whether to go ahead.',
          });
        },
      }),
      llm.tool({
        name: 'decide_repair',
        description:
          'Record what the customer wants done about one repair. Approving one whose price they haven\'t heard returns it to read back first; call again once they agree. One call per repair: "front now, rear next time" is front_brakes approved and rear_brakes next_visit.',
        parameters: z.object({
          repairId: z.enum(['front_brakes', 'rear_brakes']).describe('The repair.'),
          decision: z
            .enum(['approved', 'declined', 'next_visit', 'thinking_it_over'])
            .describe(
              'approved (do it now), next_visit (note it for next time), declined, or thinking_it_over.',
            ),
        }),
        execute: async ({ repairId, decision }) => {
          const finding = await execute(() => desk.finding(repairId));
          if (decision === 'approved' && !this.reviewed('approve', repairId)) {
            this.readBack('approve', repairId);
            return facts({
              approved: false,
              readBack: { repair: finding.title, price: finding.price },
              next: "It isn't approved: they haven't heard this price in full yet. Give it to them now and ask if they'd like it done. Call decide_repair again once they agree.",
            });
          }
          const before = desk.pickupSummary().readyAt;
          await execute(() => desk.decide(repairId as RepairId, decision as RepairDecision));
          const after = desk.pickupSummary().readyAt;
          const warning =
            (decision === 'declined' || decision === 'thinking_it_over') &&
            finding.urgency === 'now'
              ? `First say once, plainly and without pushing: ${finding.canWait} `
              : '';
          return this.pickupFacts(
            warning,
            before !== after ? { readyAtChanged: { from: before, to: after } } : {},
          );
        },
      }),
      llm.tool({
        name: 'arrange_pickup',
        description: 'How the car gets back to them. Pass only what they just told you.',
        parameters: z.object({
          ride: z
            .enum(['shuttle', 'self'])
            .optional()
            .describe(
              'shuttle (the free shuttle picks them up) or self (they, or whoever is collecting it, come in).',
            ),
          shuttleFrom: z
            .string()
            .optional()
            .describe(
              'For the shuttle: where to pick them up, in their words, like "home" or "work". That is enough: never ask for an address.',
            ),
          collectedBy: z.string().optional().describe('Someone else collecting the car for them.'),
        }),
        execute: async ({ ride, shuttleFrom, collectedBy }) => {
          await execute(() =>
            desk.arrangePickup(ride as PickupRide | undefined, shuttleFrom, collectedBy),
          );
          return this.pickupFacts();
        },
      }),
      llm.tool({
        name: 'note_new_concern',
        description:
          "Something new they've noticed with the car, noted for the technician to check.",
        parameters: z.object({ concern: z.string() }),
        execute: async ({ concern }) => {
          await execute(() => desk.noteConcern(concern));
          return facts({
            noted: concern,
            next:
              "Say it's noted for the technician, without guessing the cause or promising free work. " +
              this.nextStep(),
          });
        },
      }),
      llm.tool({
        name: 'end_without_update',
        description: "Before anything's decided: the wrong person, or a bad time to talk.",
        parameters: z.object({ reason: z.enum(['wrong_person', 'call_back_later']) }),
        execute: async ({ reason }) => {
          await execute(() => desk.endEarly(reason as EndedEarly));
          return facts({
            next:
              reason === 'wrong_person'
                ? "Apologize for the mix-up and say goodbye. Share nothing about the car, and don't offer to pass anything on."
                : 'Say no problem: they can call the service desk whenever suits. Then say goodbye.',
          });
        },
      }),
    );
    void this.updateTools(tools);
  }
  private pickupFacts(warning = '', extra: Record<string, unknown> = {}): string {
    const later = this.raising();
    if (later) this.readBack('approve', later.id);
    return facts({ ...this.desk.pickupSummary(), ...extra, next: warning + this.nextStep() });
  }
  private raising(): Finding | undefined {
    const shop = this.desk.shop!;
    return Object.values(shop.decisions).includes('approved') && !this.desk.undecided().length
      ? this.desk.undecidedLater()[0]
      : undefined;
  }
  private nextStep(): string {
    const shop = this.desk.shop!;
    const left = this.desk.undecided();
    if (left.length) return `Ask what they'd like to do about the ${left[0]!.title.toLowerCase()}.`;
    const later = this.raising();
    if (later)
      return `Bring up the ${later.title.toLowerCase()} (${dollars(later.price)}): ${later.canWait} Ask whether to do them now or at the next visit.`;
    if (!shop.ride)
      return "Ask how they'll get back for the car: the free shuttle (and from where) or coming in themselves.";
    return "Tell them when it's ready and the total due, then ask if there's anything else.";
  }
}

const VOICE_RULES = `You're on a phone call, so talk like a person, not a document:
- One or two short sentences at a time, and one question at a time. No lists, markdown, or symbols.
- Say numbers, prices, dates, and times as words, the way people say them ("seventy-nine dollars", "seven thirty Tuesday morning"). Never read out ids or codes. Call cars by model: "your X3", "your 3 Series".
- Never say you've done something, or that you're about to, without calling its tool in that same reply. "Let me check" means calling the tool now, in this reply.
- Only state a price, time, recall, cause, or booking that a tool gave you.
- Only a tool's result says whether something is done. Until one says it's booked, approved, moved, or cancelled, never say it is, or that they're "all set", "I have you down", or "updated". When a result says it isn't done yet, do what its next says.
- One call per thing: never call the same tool twice at once for the same repair, service, or time, and never with answers that disagree.
- When a tool refuses, fix what it says with your tools. Tell the caller only what changes for them, as the rule itself: never "the system".
- The caller can't see anything: never "does that look right".
- You handle everything yourself. There's nobody to transfer to, and no callbacks to promise or messages to pass on.
- Payment is in person at the service desk at pickup, cash or card. Nothing is paid over the phone, and there are no discount codes.
- When they're done, say a short goodbye and call end_call in that same reply.`;
const displayDate = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', timeZone: 'UTC' })} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
function inboundInstructions(desk: ServiceDesk): string {
  return `You're ${PERSONA} at the ${DEALERSHIP} service desk, answering the phone. Calm and attentive, like a good service advisor: never a salesperson.
Today is ${displayDate(desk.today)}. Bookable days: ${desk.days.map((d) => `${displayDate(d).replace(/, \d{4}$/, '')} = ${d}`).join('; ')}. Nothing today.

${VOICE_RULES}

Take whatever the caller tells you whenever they say it, in any order, and record it right away with its tool; never ask again for something they've said. Answer every question they ask before moving on.

How the call usually goes:
1. Their file: ask their name, then their phone number, then find_customer. With no file, they're probably new: never say you couldn't find them. Unless they've said they're new, ask if they've been in before. If they have, ask them to spell their last name and look again once; otherwise, or if there's still no file, open_new_file and tell them you've set one up.
2. The car: choose_vehicle from their file, asking which only if they haven't said. For a car that isn't on it, ask the year and model, then the mileage, and add_vehicle. Only BMWs. Don't ask the mileage of a car already on file.
3. What's wrong. For a noise: what it sounds like, where it comes from, when it happens, and how long. For a warning light: which one, and whether it's steady or flashing. For something that's stopped working: what happens, and since when. Then warning lights, then anything recent, as separate questions. One question at a time, skipping what they've said, and record each answer with describe_problem as you hear it. Only when describe_problem says what it often points to, say that once as a possibility the technician will confirm.
   Brakes that don't stop the car, smoke or burning, losing steering, a red or flashing warning light, or overheating: call flag_unsafe_to_drive and tell them right away not to drive it. A noise on its own isn't one of these.
4. What it needs: add_service. A problem to look at is a diagnostic. A warranty_repair is only for a specific part they say has stopped working (the liftgate, a window, the screen) on a car in warranty: no charge, finding the fault included. When the cause is unknown (a noise, smoke, a warning light), it's a diagnostic. Brakes, tires, wipers, and maintenance are never covered by warranty: say so plainly. If the car has an open recall, offer it, and add it only if they say yes. Never suggest anything else.
5. When: find_times for the day they want and offer what it returns. "First thing", "the earliest", or "any time" means the first opening: choose_time with it and tell them the time. Then ask how they'll get around: the lounge or the free shuttle, and a loaner only when the visit qualifies (the loaner fact says).
6. Once the visit has a service, a time, and a ride, call book_visit; don't sum it up or call it set yourself first. It returns the visit, not yet booked: read it back as a question, the car, services, concern, day and time, advisor, ride, and estimate. When they agree, book_visit again, which books it.

Already booked: to move an appointment, find_times with its appointment_id, and call reschedule_appointment the moment they pick a time. To cancel, call cancel_appointment the moment they ask. Each returns what to read back: that read-back is the only confirmation, so don't confirm in your own words first.
A change after booking (another service, the time, the ride) needs book_visit again to update it.
Prices: quote_price first, every time, and only what it returns. A repair is quoted after the diagnostic.
A spending limit ("call me before anything over five hundred"): set_approval_limit.`;
}
function callbackInstructions(desk: ServiceDesk): string {
  const shop = desk.shop!;
  const customer = desk.customer!;
  const a = shop.appointment;
  const findings = shop.findings
    .map(
      (f) =>
        `- ${f.id}: ${f.title}, ${dollars(f.price)} (parts ${dollars(f.parts)}, labor ${f.laborHours} hours). Found: ${f.found} Why: ${f.why} Can it wait? ${f.canWait} Warranty: ${f.warranty} Cheaper option: ${f.cheaperOption}`,
    )
    .join('\n');
  const done = a.services
    .map(
      (s) =>
        `${serviceLabel(s, a.vehicle).toLowerCase()} (${desk.price(s) ? dollars(desk.price(s)) : 'no charge'})`,
    )
    .join(', ');
  return `You're ${PERSONA} at the ${DEALERSHIP} service desk, calling ${customer.name} back about their ${a.vehicle.label}. It came in this morning for ${a.concern}. Done so far: ${done}. Calm and plain, on their side: never a salesperson.
Today is ${displayDate(desk.today).replace(/, \d{4}$/, '')}.

${VOICE_RULES}

You've just asked whether you're speaking with ${customer.name.split(' ')[0]}. Say nothing about the car or the repair until they confirm.
- Someone else, a wrong number, or they can't come to the phone: end_without_update with wrong_person.
- A bad time: end_without_update with call_back_later. You can't schedule a call back: they can call the service desk whenever suits.
- Once they confirm: go_over_findings, then tell them what it returns, the price, and when the car would be ready, and ask whether to go ahead.

What the technician found, for their questions:
${findings}

- Record each decision with decide_repair. Each result says what to bring up next: follow it. Be honest about urgency once, without pushing.
- How they'll get the car back: arrange_pickup.
- Every total and ready time you say comes from the latest tool result; when one changes, say so.
- Something new they've noticed: note_new_concern.
- When nothing's left, tell them when it's ready and the total due, ask if there's anything else, then say goodbye and end_call.`;
}

export function callbackOpener(desk: ServiceDesk): string {
  const shop = desk.shop!;
  const name = desk.customer!.name;
  return `Hi, this is ${PERSONA} from ${DEALERSHIP} service, calling for ${name} about the ${shop.appointment.vehicle.name}. Is this ${name.split(' ')[0]}?`;
}
export function callerScript(desk: ServiceDesk): string {
  if (desk.shop) {
    const shop = desk.shop;
    const factsText = `Nick from Bayside BMW called the caller, Alex Morgan, about their X3, which is in the shop for a grinding noise. The only details to use:
- They want the front brakes done now.
- The rear brakes can wait until the next visit.
- They'll take the shuttle back to pick it up, from home.`;
    const stage = !shop.findingsShared
      ? 'Yes, this is Alex.'
      : !shop.decisions.front_brakes
        ? 'Yes, go ahead with the front brakes.'
        : !shop.decisions.rear_brakes
          ? 'The rear brakes can wait until next time.'
          : !shop.ride
            ? 'The shuttle, please, from home.'
            : "When Nick goes over the ready time and total, that's all, thanks, goodbye.";
    return `${factsText}\n${stage}`;
  }
  const visit = desk.visit;
  const car = visit.vehicle;
  const factsText = `The caller is Alex Morgan, a Bayside BMW customer trying out Nick's phone line. The only details to use:
- Phone: four one five, five five five, zero one four two
- The car: their X3
- The problem: a grinding noise from the front when they brake, for about a week. No warning lights, nothing done to the car recently.
They want to bring it in, add any recall, take the first time Nick offers, and ride the shuttle.`;
  const stage = !desk.customer
    ? 'Give the name when Nick asks for it, then the phone number.'
    : !car
      ? "It's the X3."
      : !visit.services.includes('diagnostic')
        ? 'Answer only what Nick just asked about the problem, one detail at a time. A diagnostic is fine.'
        : car.recall && !visit.services.includes('recall')
          ? 'Yes, add the recall.'
          : !visit.slot
            ? 'Take the first time Nick offers.'
            : !visit.ride
              ? 'The shuttle, please.'
              : !visit.booked
                ? "When Nick reads it back, yes, that's right."
                : "It's booked. When Nick asks if there's anything else, that's all, thanks, goodbye.";
  return `${factsText}\n${stage}`;
}
