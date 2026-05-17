<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Drive-Thru Example

A complete drive-thru ordering system demonstrating interactive voice agents for food ordering with database integration and order management.

For setup instructions and more details, see the [main README](../../../README.md).

## Overview

This example simulates a fast food drive-thru. It is split across three files: [`database.ts`](./database.ts) contains the menu and formats it as system prompt text, [`order.ts`](./order.ts) holds the ordered item models, and [`drivethru_agent.ts`](./drivethru_agent.ts) defines `DriveThruAgent` with dynamically built ordering tools.

The full menu is loaded once per session and injected directly into the agent's instructions, so the LLM has menu context without needing to call a tool.

### Menu Loading

At the start of each session, [`newUserData()`](./drivethru_agent.ts#L359-L376) queries `FakeDB` for all item categories (drinks, combos, Happy Meals, regulars, sauces) and stores them in `UserData` alongside a fresh `OrderState`.

`DriveThruAgent` then formats each category using `menuInstructions()` and concatenates the results with `COMMON_INSTRUCTIONS` to build the full system prompt. This means the LLM sees the entire menu from the first turn and can answer questions or suggest items without any tool calls.

### Dynamic Tool Building

The three ordering tools are constructed by `buildComboOrderTool`, `buildHappyOrderTool`, and `buildRegularOrderTool`. Each method closes over the relevant item lists and injects their IDs as the `enum` constraint in the tool's Zod schema.

This restricts the LLM to known IDs at the schema layer before any runtime logic runs. `ToolError` handles the cases that can't be caught statically. For example, when a drink has multiple available sizes and the customer hasn't specified one yet, the tool raises a `ToolError` prompting the agent to ask for clarification before retrying.

### Order Types

[`order.ts`](./order.ts) defines three ordered item types: `OrderedCombo`, `OrderedHappy`, and `OrderedRegular`. Each ordered item receives a random short `orderId` on creation via `orderUid()`.

`OrderState` stores the current cart as a `Record<string, OrderedItem>` keyed by `orderId`, which the `removeOrderItem` and `listOrderItems` tools use to look up or modify existing items.

### Managing the Order

Two tools handle cart management:

- `listOrderItems` returns all current cart items with their `orderId`s. The agent is instructed to call this first when modifying or removing an item whose `orderId` is unknown.
- `removeOrderItem` removes one or more items by `orderId`. Modifications, such as upsizing fries, are done by removing the old item and re-adding it with the new parameters.

`maxToolSteps=10` is set on the session to give the agent enough budget to call `listOrderItems` followed by `removeOrderItem` in a single turn when needed.
