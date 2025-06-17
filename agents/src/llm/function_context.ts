// // SPDX-FileCopyrightText: 2024 LiveKit, Inc.
// //
// // SPDX-License-Identifier: Apache-2.0
// import { z } from 'zod';

// // heavily inspired by Vercel AI's `tool()`:
// // https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

// /* eslint-disable @typescript-eslint/no-explicit-any */

// /** Type reinforcement for the callable function's execute parameters. */
// export type inferParameters<P extends z.ZodTypeAny> = z.infer<P>;

// /** Raw OpenAI-adherent function parameters. */
// export type OpenAIFunctionParameters = {
//   type: 'object';
//   properties: { [id: string]: any };
//   required: string[];
//   additionalProperties: boolean;
// };

// /** A definition for a function callable by the LLM. */
// export interface CallableFunction<P extends z.ZodTypeAny = any, R = any> {
//   description: string;
//   parameters: OpenAIFunctionParameters | P;
//   execute: (args: inferParameters<P>) => PromiseLike<R>;
// }

// /** A function that has been called but is not yet running */
// export interface FunctionCallInfo<P extends z.ZodTypeAny = any, R = any> {
//   name: string;
//   func: CallableFunction<P, R>;
//   toolCallId: string;
//   rawParams: string;
//   params: inferParameters<P>;
//   task?: PromiseLike<CallableFunctionResult>;
// }

// /** The result of a ran FunctionCallInfo. */
// export interface CallableFunctionResult {
//   name: string;
//   toolCallId: string;
//   result?: any;
//   error?: any;
// }

// /** An object containing callable functions and their names */
// export type FunctionContext = {
//   [name: string]: CallableFunction;
// };

