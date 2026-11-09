// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  type Appointment,
  CLINIC_NAME,
  CLINIC_TZ,
  CLINIC_TZ_NAME,
  type Clinic,
  ClinicError,
  DOCTOR,
  type PartOfDay,
  at,
} from './clinic.js';
import { CLINIC_SEED } from './clinic_data.js';

export const GREETING = `Thanks for calling ${CLINIC_NAME}, this is Riley. What can I help you with today?`;

const VOICE_RULES = `You're on a phone call, so talk like a person, not a document:
- One or two short sentences at a time, and one question at a time. No lists, markdown, or symbols.
- Say dates and times the way people do, like "nine thirty Tuesday morning" or "March fourteenth, nineteen eighty-eight". Never read out ids.
- Never say you've done something, or that you're about to, without calling its tool in that same reply.
- Only state an appointment or a time that a tool gave you, with the day and time just as it gave them.
- When a tool refuses, fix what it says with your tools. Tell the caller only what changes for them.
- When they're done, say a short goodbye and call end_call in that same reply. Never say goodbye before they've had a chance to say they're done.`;

const NEW_PATIENT = ['Alex Morgan', '1992-03-14'] as const;
const partOfDaySchema = z.enum(['morning', 'afternoon', 'any']);

export interface Caller {
  name: string;
  dateOfBirth: string;
}

export interface CallState {
  caller?: Caller;
  birthday?: string;
  charts: string[];
  clinic?: Clinic;
}

export interface CallContext {
  userData: CallState;
}

export function newCallState(clinic?: Clinic): CallState {
  return { charts: [], clinic };
}

export function verifiedCaller(context: CallContext): Caller {
  const caller = context.userData.caller;
  if (!caller) {
    throw new llm.ToolError(
      "The caller isn't verified. Verify their name and date of birth first.",
    );
  }
  return caller;
}

export class FrontDesk extends voice.Agent<CallState> {
  constructor(
    protected readonly clinic: Clinic,
    instructions: string,
    tools: llm.ToolContextEntry<CallState>[],
  ) {
    super({ instructions, tools: [...commonTools(clinic), ...tools] });
  }

  async checkAvailability(
    context: CallContext,
    earliestDate: string,
    latestDate: string,
    partOfDay: PartOfDay = 'any',
  ): Promise<string> {
    return checkAvailability(this.clinic, context, earliestDate, latestDate, partOfDay);
  }

  async rescheduleAppointment(
    context: CallContext,
    appointmentId: string,
    startsAt: string,
  ): Promise<string> {
    return rescheduleAppointment(this.clinic, context, appointmentId, startsAt);
  }
}

export class Receptionist extends FrontDesk {
  constructor(clinic: Clinic) {
    super(
      clinic,
      `You are Riley, the front desk at ${CLINIC_NAME}, ${DOCTOR}'s practice, answering the phone. Brisk and warm.
${calendarContext(clinic)}

${VOICE_RULES}

Find the caller's chart before anything else, the way a front desk does: date of birth first, then name. Ask for whichever they haven't given, each only once. If you didn't catch all of the date of birth, ask for the whole date again, never just part of it like the last two digits of the year. As soon as you have both, call look_up_birthday with the date and the name as you heard it, or as they spelled it. If they've already spelled out their name, never spell it back to them. Until it returns you don't know whether they have a chart, so never say you're pulling them up or setting them up.
- It lists their chart: if they spelled their name, call open_chart right away. Otherwise spell that chart's name back from its letters, as a question, like "Taylor Smith, that's T A Y L O R, S M I T H, right?", and once they say yes, call open_chart. Then tell them their upcoming appointment, what it's for and the day and time, before anything else.
- It lists none, and they've said they've been in before: read their whole date of birth back once to check it. If they correct it, call look_up_birthday again with the new date. If that finds nothing either, get them set up.
- It lists none otherwise: say you'll get them set up, without saying you couldn't find them. If they spelled their name, call register_new_patient with their letters. Otherwise spell their name back the way you'd write it, as a question. If they correct a letter, call look_up_birthday again with their spelling, and if that lists their chart, go on as if it had matched. Once they say the spelling is right and nothing matched, call register_new_patient with those letters.
Never mention a chart other than theirs. If they ask you to say or spell their name, just do it.

To find a time, call check_availability for what they asked, and offer the one or two openings closest to it. If it has nothing then, check the next clinic days for the same part of the day and offer those, before asking them to pick another time. Once they pick one, call book_appointment, or reschedule_appointment for an appointment they already have, without asking again.`,
      receptionistTools(clinic),
    );
  }

  async lookUpBirthday(context: CallContext, dateOfBirth: string, name: string): Promise<string> {
    const born = parseDate(dateOfBirth);
    context.userData.birthday = born;
    context.userData.charts = this.clinic
      .bornOn(born)
      .filter((chart) => letters(chart) === letters(name));
    return JSON.stringify({
      charts: context.userData.charts.map((chart) => ({ name: chart, letters: readBack(chart) })),
    });
  }

  async openChart(context: CallContext, name: string): Promise<string> {
    const born = context.userData.birthday;
    if (!born) throw new llm.ToolError("Look up the caller's date of birth first.");
    if (!context.userData.charts.includes(name)) {
      throw new llm.ToolError(
        `No chart named ${JSON.stringify(name)} matched that date of birth. Use a name look_up_birthday listed.`,
      );
    }
    await this.clinic.publishCaller(name);
    context.userData.caller = { name, dateOfBirth: born };
    return JSON.stringify({ upcoming: this.clinic.upcoming(name).map(describe) });
  }

  async registerNewPatient(
    context: CallContext,
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const born = context.userData.birthday;
    if (!born) {
      throw new llm.ToolError("Look up the caller's date of birth before registering them.");
    }
    const name = `${fromLetters(firstName)} ${fromLetters(lastName)}`.trim();
    if (!name.includes(' ')) {
      throw new llm.ToolError('Both a first and a last name are needed, letter by letter.');
    }
    await clinicCall(() => this.clinic.register(name, born));
    context.userData.caller = { name, dateOfBirth: born };
    return `Registered and verified ${name}.`;
  }

  async bookAppointment(context: CallContext, startsAt: string, reason: string): Promise<string> {
    const appointment = await clinicCall(() =>
      this.clinic.book(verifiedCaller(context).name, parseDateTime(startsAt), reason),
    );
    return `Booked ${appointment.reason} for ${spoken(appointment.startsAt)}.`;
  }
}

export class ConfirmationCall extends FrontDesk {
  constructor(
    clinic: Clinic,
    private readonly appointment: Appointment,
  ) {
    const name = appointment.patient;
    const first = name.split(' ')[0] ?? name;
    super(
      clinic,
      `You are Riley, from the front desk at ${CLINIC_NAME}, ${DOCTOR}'s practice. You placed this call to ${name}, a patient, to confirm their upcoming appointment. Brisk and warm.
${calendarContext(clinic)}

${VOICE_RULES}

You've already asked whether you're speaking with ${first}. If it's someone else, or not a good time, say you'll call back another time, then say goodbye and call end_call. Never mention the appointment or anything medical to anyone but the patient.
Once they say it's them, verify them before anything else. This is a LiveKit demo, so ask for their date of birth with a quick demo note, something like: "Okay great! Usually this is where I'd ask for your date of birth to verify it's you, but since this is a demo, any date will do." Then call verify_patient with the date they give. If you didn't catch all of it, ask for the whole date again, never just part of it.
Then tell them the appointment it returned, what it's for and the day and time, and ask if they can still make it.
- If they can, call confirm_appointment.
- If they can't, ask what day and time would work better, call check_availability, and offer one or two openings. Once they pick one, call reschedule_appointment, then confirm_appointment.
Then ask if there's anything they'd like ${DOCTOR} to know before they come in. If they mention something, call add_note_for_doctor with it in their words, and say briefly that you've passed it along. If there's nothing, that's fine.
When they're all set, remind them of the day and time and ask if there's anything else.`,
      confirmationTools(clinic, appointment),
    );
  }

  async verifyPatient(context: CallContext, dateOfBirth: string): Promise<string> {
    const name = this.appointment.patient;
    context.userData.caller = { name, dateOfBirth: parseDate(dateOfBirth) };
    await this.clinic.publishCaller(name);
    return JSON.stringify({
      verified: true,
      upcoming: this.clinic.upcoming(name).map(describe),
    });
  }

  async confirmAppointment(context: CallContext, appointmentId: string): Promise<string> {
    const appointment = await clinicCall(() =>
      this.clinic.confirm(verifiedCaller(context).name, appointmentId),
    );
    return `Confirmed ${appointment.reason} for ${spoken(appointment.startsAt)}.`;
  }

  async addNoteForDoctor(
    context: CallContext,
    appointmentId: string,
    note: string,
  ): Promise<string> {
    await clinicCall(() => this.clinic.addNote(verifiedCaller(context).name, appointmentId, note));
    return `Added for ${DOCTOR}: ${note.trim()}`;
  }
}

function commonTools(clinic: Clinic): llm.ToolContextEntry<CallState>[] {
  return [
    llm.tool({
      name: 'check_availability',
      description: 'See which appointment times are open on the calendar.',
      parameters: z.object({
        earliest_date: z.string().describe('First day to check, YYYY-MM-DD.'),
        latest_date: z.string().describe('Last day to check, YYYY-MM-DD.'),
        part_of_day: partOfDaySchema.describe('"morning", "afternoon", or "any".').default('any'),
      }),
      execute: async (
        { earliest_date, latest_date, part_of_day },
        { ctx }: llm.ToolOptions<CallState>,
      ) => checkAvailability(clinic, ctx, earliest_date, latest_date, part_of_day),
    }),
    llm.tool({
      name: 'reschedule_appointment',
      description: "Move one of the caller's existing appointments to an open time.",
      parameters: z.object({
        appointment_id: z.string().describe('The appointment to move.'),
        starts_at: z.string().describe("The opening's starts_at from check_availability."),
      }),
      execute: async ({ appointment_id, starts_at }, { ctx }: llm.ToolOptions<CallState>) =>
        rescheduleAppointment(clinic, ctx, appointment_id, starts_at),
    }),
  ];
}

function receptionistTools(clinic: Clinic): llm.ToolContextEntry<CallState>[] {
  return [
    llm.tool({
      name: 'look_up_birthday',
      description:
        "List the chart with the caller's date of birth and name, spelled as given. The first step for every caller, and again with any corrected spelling.",
      parameters: z.object({
        date_of_birth: z.string().describe("The caller's date of birth, YYYY-MM-DD."),
        name: z.string().describe("The caller's full name as they said it, or as they spelled it."),
      }),
      execute: async ({ date_of_birth, name }, { ctx }: llm.ToolOptions<CallState>) => {
        const born = parseDate(date_of_birth);
        ctx.userData.birthday = born;
        ctx.userData.charts = clinic
          .bornOn(born)
          .filter((chart) => letters(chart) === letters(name));
        return JSON.stringify({
          charts: ctx.userData.charts.map((chart) => ({ name: chart, letters: readBack(chart) })),
        });
      },
    }),
    llm.tool({
      name: 'open_chart',
      description:
        "Open the chart that matched the caller's name, once they've said its spelling is right or spelled it that way themselves. Required before any other record is read or changed.",
      parameters: z.object({
        name: z.string().describe("The chart's name exactly as look_up_birthday listed it."),
      }),
      execute: async ({ name }, { ctx }: llm.ToolOptions<CallState>) => {
        const born = ctx.userData.birthday;
        if (!born) throw new llm.ToolError("Look up the caller's date of birth first.");
        if (!ctx.userData.charts.includes(name)) {
          throw new llm.ToolError(
            `No chart named ${JSON.stringify(name)} matched that date of birth. Use a name look_up_birthday listed.`,
          );
        }
        await clinic.publishCaller(name);
        ctx.userData.caller = { name, dateOfBirth: born };
        return JSON.stringify({ upcoming: clinic.upcoming(name).map(describe) });
      },
    }),
    llm.tool({
      name: 'register_new_patient',
      description:
        "Create a chart for a caller who isn't in the records, under the spelling they confirmed or spelled out and the date of birth look_up_birthday checked.",
      parameters: z.object({
        first_name: z
          .string()
          .describe(
            'The letters of the first name the caller confirmed or spelled, separated by spaces, like "S H A Y N E".',
          ),
        last_name: z
          .string()
          .describe(
            'The letters of the last name the caller confirmed or spelled, separated by spaces. A hyphen or apostrophe that is part of the name stays in place, like "O \' B R I E N".',
          ),
      }),
      execute: async ({ first_name, last_name }, { ctx }: llm.ToolOptions<CallState>) => {
        const born = ctx.userData.birthday;
        if (!born) {
          throw new llm.ToolError("Look up the caller's date of birth before registering them.");
        }
        const name = `${fromLetters(first_name)} ${fromLetters(last_name)}`.trim();
        if (!name.includes(' ')) {
          throw new llm.ToolError('Both a first and a last name are needed, letter by letter.');
        }
        await clinicCall(() => clinic.register(name, born));
        ctx.userData.caller = { name, dateOfBirth: born };
        return `Registered and verified ${name}.`;
      },
    }),
    llm.tool({
      name: 'book_appointment',
      description: 'Book a new appointment for the caller at an open time.',
      parameters: z.object({
        starts_at: z.string().describe("The opening's starts_at from check_availability."),
        reason: z.string().describe('What the visit is for, in a few words.'),
      }),
      execute: async ({ starts_at, reason }, { ctx }: llm.ToolOptions<CallState>) => {
        const appointment = await clinicCall(() =>
          clinic.book(verifiedCaller(ctx).name, parseDateTime(starts_at), reason),
        );
        return `Booked ${appointment.reason} for ${spoken(appointment.startsAt)}.`;
      },
    }),
  ];
}

function confirmationTools(
  clinic: Clinic,
  calledAppointment: Appointment,
): llm.ToolContextEntry<CallState>[] {
  return [
    llm.tool({
      name: 'verify_patient',
      description:
        'Verify the patient. Any date of birth passes in the demo. Required before any other record is read or changed.',
      parameters: z.object({
        date_of_birth: z.string().describe('The date of birth the patient gave, YYYY-MM-DD.'),
      }),
      execute: async ({ date_of_birth }, { ctx }: llm.ToolOptions<CallState>) => {
        const name = calledAppointment.patient;
        ctx.userData.caller = { name, dateOfBirth: parseDate(date_of_birth) };
        await clinic.publishCaller(name);
        return JSON.stringify({
          verified: true,
          upcoming: clinic.upcoming(name).map(describe),
        });
      },
    }),
    llm.tool({
      name: 'confirm_appointment',
      description: "Mark the patient's appointment as confirmed: they've said they'll be there.",
      parameters: z.object({
        appointment_id: z.string().describe('The appointment to confirm.'),
      }),
      execute: async ({ appointment_id }, { ctx }: llm.ToolOptions<CallState>) => {
        const appointment = await clinicCall(() =>
          clinic.confirm(verifiedCaller(ctx).name, appointment_id),
        );
        return `Confirmed ${appointment.reason} for ${spoken(appointment.startsAt)}.`;
      },
    }),
    llm.tool({
      name: 'add_note_for_doctor',
      description:
        'Add something the patient wants the doctor to know before the visit to their appointment.',
      parameters: z.object({
        appointment_id: z.string().describe('The appointment the note is for.'),
        note: z
          .string()
          .describe('What the patient said, in their own words, as one or two short sentences.'),
      }),
      execute: async ({ appointment_id, note }, { ctx }: llm.ToolOptions<CallState>) => {
        await clinicCall(() => clinic.addNote(verifiedCaller(ctx).name, appointment_id, note));
        return `Added for ${DOCTOR}: ${note.trim()}`;
      },
    }),
  ];
}

async function checkAvailability(
  clinic: Clinic,
  context: CallContext,
  earliestDate: string,
  latestDate: string,
  partOfDay: PartOfDay,
): Promise<string> {
  verifiedCaller(context);
  const openings = await clinicCall(() =>
    clinic.checkAvailability(parseDate(earliestDate), parseDate(latestDate), partOfDay),
  );
  return JSON.stringify(
    openings.map((opening) => ({ starts_at: localDateTime(opening), spoken: spoken(opening) })),
  );
}

async function rescheduleAppointment(
  clinic: Clinic,
  context: CallContext,
  appointmentId: string,
  startsAt: string,
): Promise<string> {
  const appointment = await clinicCall(() =>
    clinic.reschedule(verifiedCaller(context).name, appointmentId, parseDateTime(startsAt)),
  );
  return `Moved ${appointment.reason} to ${spoken(appointment.startsAt)}.`;
}

function clock(): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return `It's ${date}, ${time} ${CLINIC_TZ_NAME}.`;
}

export function calendarContext(clinic: Clinic): string {
  const days = clinic
    .clinicDays()
    .map((day) => {
      const display = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
        .formatToParts(new Date(`${day}T12:00:00Z`))
        .filter((part) => ['weekday', 'month', 'day'].includes(part.type))
        .map((part) => part.value)
        .join(' ');
      return `${display} = ${day}`;
    })
    .join(', ');
  return `${clock()} Clinic days that can be booked: ${days}. Nothing can be booked after the last one; if the caller wants later, check the latest days instead.`;
}

export function outboundGreeting(appointment: Appointment): string {
  const first = appointment.patient.split(' ')[0] ?? appointment.patient;
  return `Hi, this is Riley from ${CLINIC_NAME}, calling for ${appointment.patient} about an upcoming appointment with ${DOCTOR}. Is this ${first}?`;
}

export function callerScript(clinic: Clinic, state: CallState): string {
  const days = clinic.clinicDays();
  const you = clinic.appointments[0];
  if (!you) throw new Error('clinic seed requires an appointment');
  const born = clinic.patients.get(you.patient);
  const target = days[3];
  const seeded = CLINIC_SEED.appointments[0];
  if (!born || !target || !seeded) throw new Error('clinic seed is incomplete');
  const wasAt = at(days[seeded.day]!, seeded.time);
  const onFile = `The caller is ${you.patient}, an existing patient at ${CLINIC_NAME}, trying out Riley's front desk. Their details on file, the only ones to use:
- Full name: ${you.patient}, spelled "${readBack(you.patient)}"
- Date of birth: ${longDate(born)}
- Their appointment: ${you.reason}, ${spoken(you.startsAt)}
They want to move that appointment to ${weekday(target)} morning.
If the caller has instead said they're a new patient, they are ${NEW_PATIENT[0]}, born ${longDate(NEW_PATIENT[1])}, spelled "${readBack(NEW_PATIENT[0])}", and they want a check-up ${weekday(days[2]!)} afternoon.`;
  let stage: string;
  if (you.startsAt.getTime() !== wasAt.getTime()) {
    stage = "The appointment is moved. Say thanks, that's everything, and goodbye.";
  } else if (!state.caller) {
    stage = `They haven't been verified yet. If Riley asks what they need, say who they are, their date of birth, and that they'd like to move their appointment to ${weekday(target)} morning, all in one line. If Riley asks for the date of birth or the name, give just that. If Riley spells the name back right, say yes; if not, spell it.`;
  } else {
    stage =
      "They're verified. When Riley offers times, take the first one, in Riley's words. When Riley confirms the move, say thanks and goodbye.";
  }
  return `${onFile}\n${stage}`;
}

export const DOCTOR_NOTE =
  "my knee has been swelling after I run, and I've been taking ibuprofen for it";

export function outboundCallerScript(
  clinic: Clinic,
  state: CallState,
  appointment: Appointment,
): string {
  const born = clinic.patients.get(appointment.patient);
  if (!born) throw new Error(`missing patient ${appointment.patient}`);
  const onFile = `Riley from ${CLINIC_NAME} called the caller, ${appointment.patient}, to confirm their appointment. Their details, the only ones to use:
- Full name: ${appointment.patient}
- Date of birth: ${longDate(born)}
- Their appointment: ${appointment.reason}, ${spoken(appointment.startsAt)}
They can make it, and want ${DOCTOR} to know: "${DOCTOR_NOTE}".`;
  let stage: string;
  if (appointment.notes.length) {
    stage =
      "Everything's sorted. When Riley asks if there's anything else, say that's all, thanks, and goodbye.";
  } else if (appointment.confirmed) {
    stage = `When Riley asks if there's anything for ${DOCTOR}, say: ${DOCTOR_NOTE}.`;
  } else if (state.caller) {
    stage = 'When Riley asks if they can still make it, say yes.';
  } else {
    stage = `They haven't been verified yet. Confirm they're ${appointment.patient.split(' ')[0]}, and give the date of birth when Riley asks.`;
  }
  return `${onFile}\n${stage}`;
}

function describe(appointment: Appointment): Record<string, string> {
  return {
    appointment_id: appointment.id,
    when: spoken(appointment.startsAt),
    reason: appointment.reason,
  };
}

function spoken(startsAt: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CLINIC_TZ,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(startsAt)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

function localDateTime(value: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function fromLetters(spelled: string): string {
  let output = '';
  let capitalize = true;
  for (const character of spelled.replaceAll(/\s/g, '')) {
    output += capitalize ? character.toUpperCase() : character.toLowerCase();
    capitalize = character === '-' || character === "'";
  }
  return output;
}

function letters(name: string): string {
  return name.replaceAll(/[^a-z]/gi, '').toLocaleLowerCase();
}

function readBack(name: string): string {
  return name
    .split(' ')
    .map((part) =>
      [...part]
        .map((character) =>
          character === '-' ? 'hyphen' : character === "'" ? 'apostrophe' : character.toUpperCase(),
        )
        .join(' '),
    )
    .join(', ');
}

function parseDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new llm.ToolError(`Use YYYY-MM-DD, got ${JSON.stringify(value)}.`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new llm.ToolError(`Use YYYY-MM-DD, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function parseDateTime(value: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!match) {
    throw new llm.ToolError(
      `Use the starts_at value from check_availability, got ${JSON.stringify(value)}.`,
    );
  }
  try {
    return at(parseDate(match[1]!), match[2]!);
  } catch {
    throw new llm.ToolError(
      `Use the starts_at value from check_availability, got ${JSON.stringify(value)}.`,
    );
  }
}

async function clinicCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ClinicError) throw new llm.ToolError(error.message);
    throw error;
  }
}

function longDate(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}

function weekday(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}
