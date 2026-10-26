// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { z } from 'zod';

const POLICIES = {
  accessibility: {
    description: 'Wheelchair and ADA accessibility: accessible rooms, roll-in showers.',
    body: 'Accessibility: ADA-accessible rooms on every floor, roll-in showers in the suites. Mention at booking so we assign one.',
  },
  group_bookings: {
    description:
      'Group room blocks (15+ guests): rates, tour-leader comp, credit approval, cancellation terms.',
    body: `Group threshold: 15 or more guests traveling together is a group block, handled with recordGroupInquiry, not the individual booking flow. Under 15, book rooms individually instead.

Group rate: a provisional 10 percent off the standard nightly rates for the block; the final rate is quoted by the group desk when the block is confirmed.

Tour leader: one complimentary room per 15 paying guests.

What to collect for the inquiry: sponsor company, contact name and callback number, party size, the predominant room-share arrangement (twin, double, single, or mixed), and the dates (check-in plus number of nights).

Credit approval: a sponsor company that hasn't worked with the hotel before needs credit approval with Director sign-off before anything is confirmed. Never confirm a group block on the spot. Record the inquiry and tell the caller the group desk will call back within two business days to confirm.

Cancellations: individual rooms can be released from a confirmed block up to 30 days before arrival at no charge; inside 30 days, one night per cancelled room is retained.`,
  },
  guest_privacy: {
    description:
      'Locating a guest: room numbers, whether someone is staying here, taking a message for a guest.',
    body: `Guest privacy: never disclose whether someone by a given name is staying at the hotel, never give out a room number, and never connect a caller to a room - not for friends, family, colleagues, surprises, or claimed emergencies. There is no way to verify a caller's story over the phone, so there are no exceptions.

The one alternative: offer to take a message. It will be delivered to that person if they are in fact staying here - but the caller is never told whether that's the case. Say it will be "passed along if we can"; never confirm or deny the guest's presence, even after the message is taken. Collect the caller's name, callback number, and the message, and read all three back.

Delivery: a message for an in-house guest reaches the room within about 30 minutes. Quote delivery timing only - never promise when the guest will read or act on it - and confirm the message is logged by giving its reference.`,
  },
  guest_services: {
    description: 'Wake-up calls, laundry and dry-cleaning, lost-and-found, business center, spa.',
    body: `Wake-up calls: scheduled to the room for any date and time. If the guest doesn't answer, a second call is placed about five minutes later; no response to that and front desk staff go up for an in-person room check - so a heavy sleeper genuinely will be woken. Changes or cancellations any time by calling the desk.
Laundry and dry-cleaning: drop at the front desk before 9 AM for same-day return, priced per item.
Lost-and-found: held at the front desk for 90 days.
Business center: 24/7 lobby workstations with printing.
Spa: not on-site. The front desk can recommend places nearby.`,
  },
  guest_walks: {
    description:
      'Overbooked or unavailable room for a confirmed guest: the re-accommodation and walk procedure.',
    body: `When a confirmed guest has no room (double-booked, oversold night): own it - apologize plainly, no hiding behind "the system". The procedure is fixed and resolveRoomConflict runs it in order:
1. Move them within the house first: a free room of the same or better category for the whole stay. An upgrade is free - a forced move is never the guest's cost.
2. Only when nothing in the house fits, walk them: tonight at our partner hotel, the Harbor House, two blocks away and comparable. The room there is paid by us, the taxi over and back is covered by us, and their room here is guaranteed from the return date the tool gives. Say "at no extra cost to you" explicitly.
3. State the specifics when confirming: which hotel, how they get there, and the plan for tomorrow. If the guest stays angry after the full plan, offer a manager callback rather than arguing.`,
  },
  location_and_transport: {
    description:
      'Address, airport access, public transit, parking pickup points, and the surrounding neighborhood.',
    body: `Address: 100 LiveKit Way, San Francisco.
Airport: SFO is roughly 30 minutes by car. No hotel shuttle; the front desk will arrange a ride.
Airport rides: the hotel car is a flat 85 dollars to SFO, seats up to four with luggage, books in advance at the desk and charges to the room - pickup at the front entrance. Taxis run metered, roughly 55 to 70 dollars to SFO, hailed at the door by the doorman but not reservable ahead. For a guaranteed time, the hotel car is the one to book.
Getting around: nearest Muni stop is two blocks away; BART is a 10-minute walk. Cabs and rideshares pick up at the main entrance.
Neighborhood: a few coffee shops and a 24-hour pharmacy within two blocks. The nearest hospital is six blocks east; non-emergency urgent care five blocks south.
Things to do nearby: walkable to the waterfront and the main shopping street; the front desk keeps a list of dinner spots, museums, and tour operators for guests who ask.`,
  },
  payments_and_currency: {
    description:
      'Accepted cards and payment methods, paying cash, foreign-currency exchange, exchange rates.',
    body: `Cards: Visa, Mastercard, American Express, and Discover - credit or debit; Apple Pay and Google Pay at the desk. A card is required at check-in for incidentals even when paying cash. No personal checks.

Cash: US dollars are accepted for settling the bill. Foreign currency is not accepted as payment.

Currency exchange: the front desk exchanges major foreign currencies into US dollars for resident guests - in person at the desk, passport required, at the day's posted rate, with change given in dollars.

Exchange rates: the rate is posted at the desk each morning. There is no way to quote it over the phone - give the mechanism, never improvise, estimate, or roughly quote a rate on a call.

Card on file problems: when a guest's card isn't going through, keep it discreet - it "isn't going through at the moment, possibly a technical issue", never "declined" or "rejected", and never speculate about funds. The moment the guest offers a replacement card, take it on this call after verification.`,
  },
  restaurant_dining: {
    description: 'Restaurant hours, reservations, dress code, private dining, celebrations.',
    body: 'Restaurant: dinner only, 5:30 to 9 PM last seating. Smart-casual dress is recommended but jackets are not required. Birthday or anniversary notes can be added to a reservation. Private dining requests go to sales as a followup.',
  },
  restaurant_menu: {
    description: 'Restaurant menu overview.',
    body: 'Menu overview: seasonal starters, seafood and steak mains, vegetarian pasta, and desserts. The breakfast buffet is separate and is available as a room extra from 6:30 to 10:30 AM.',
  },
  restaurant_dietary: {
    description: 'Restaurant dietary accommodations.',
    body: 'Dietary needs: vegetarian and gluten-free choices are available. Severe allergies should be added as reservation notes so the restaurant can prepare safely.',
  },
  rooms_and_amenities: {
    description: 'Room types, views, beds, amenities, pet/smoking policies.',
    body: 'Room types include queen with two beds, king, double queen, suites, and a penthouse. Views vary by room: city, garden, and ocean. Wi-Fi is free. Pool, gym, and sauna run 6 AM to 10 PM. Pet-friendly and smoking-permitted rooms are request-only.',
  },
  room_service: {
    description: 'Room-service availability.',
    body: 'Room service is available 6 PM to 10 PM from a limited dinner menu. For exact menu or allergy questions, record a followup for the restaurant team.',
  },
  tours: {
    description:
      'Sightseeing tours bookable through the desk: half-day, full-day, and private city tours.',
    body: `Three tours, all with English-speaking guides and lobby pickup:
Half-day city highlights: small group, about 4.5 hours, 9:00 AM pickup at the hotel lobby, 65 dollars per person, entry fees included.
Full-day city and bay: small group, 8:30 AM lobby pickup, back about 5 PM, 110 dollars per person, lunch and entry fees included.
Private half-day tour: private car and guide, flexible start at 10:00 AM standard, up to 4 guests, 290 dollars flat.

Narrow before booking: group or private, half or full day, and the date and party size. Quote the pickup time, pickup spot, and price from this list when confirming.`,
  },
} as const;

type PolicyTopic = keyof typeof POLICIES;

const POLICY_TOPICS = Object.keys(POLICIES) as [PolicyTopic, ...PolicyTopic[]];

export function buildLookupPolicyTool() {
  const index = POLICY_TOPICS.map((topic) => `- ${topic}: ${POLICIES[topic].description}`).join(
    '\n',
  );

  return llm.tool({
    name: 'lookupPolicy',
    description:
      'Fetch the full hotel or restaurant policy text for one topic. Call this before answering any question beyond the quick facts in your instructions. Topics:\n' +
      index,
    parameters: z.object({
      topic: z.enum(POLICY_TOPICS).describe('The policy topic to fetch.'),
    }),
    execute: async ({ topic }) => POLICIES[topic].body,
  });
}
