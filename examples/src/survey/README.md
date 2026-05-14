<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Survey Agent

Screen a candidate for a software engineer role to see if they meet the prerequisites and are an overall good fit. The responses and summary are written to a CSV file.

For setup instructions and more details, see the [main README](../../../README.md).

## Overview

The flow of this agent is flexibly structured, where the specified sequence is maintained but the user can regress to a previously visited task if needed. This is implemented with `TaskGroup` in [`SurveyAgent.onEnter`](../survey_agent.ts#L312-L359).

### IntroTask

This stage facilitates introductions and collects the candidate's name.

### EmailTask

This stage collects the candidate's email. If the candidate refuses, the agent calls `disqualify` and ends the interview.

### CommuteTask

This stage collects whether the candidate can commute to the office and their method of transportation. The possible commute methods are defined in `CommuteResults` and passed to a function tool as a Zod enum.

### ExperienceTask

This stage collects the candidate's years of experience and a short description of their professional career. It follows a structure similar to `IntroTask` and `CommuteTask`.

### BehavioralTask

For some tasks, you might not want a structured flow of questions. In this stage, the agent collects the candidate's strengths, weaknesses, and work style incrementally in no particular order. This allows for a more natural conversation.

After the candidate answers one of the questions, `checkCompletion()` verifies whether all three fields (`strengths`, `weaknesses`, `workStyle`) have been collected. If so, `BehavioralTask` is marked complete. If not, the agent continues prompting for the missing answers.

In practice, this helps ensure variability among candidates' experiences.

### Closing Out

Once the interview is concluded and `TaskGroup` is completed, the agent extracts the summary message from the last chat context item:

```ts
const summaryItem = this.chatCtx.items[this.chatCtx.items.length - 1];
```

The agent merges the task results with the summary and writes them to `survey_results.csv`.

Finally, the agent thanks the candidate and ends the interview.

### Disqualification

In each stage after the first, the candidate may be disqualified for unsatisfactory answers or for refusing to answer. The shared `disqualifyTool()` writes the disqualification reason to the CSV, informs the candidate, and shuts down the session.
