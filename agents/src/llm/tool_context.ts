// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';
import * as z4 from 'zod/v4';
import type { Agent } from '../voice/agent.js';
import type { RunContext, UnknownUserData } from '../voice/run_context.js';
import { isZod4Schema, isZodObjectSchema, isZodSchema } from './zod-utils.js';

// heavily inspired by Vercel AI's `tool()`:
// https://github.com/vercel/ai/blob/3b0983b/packages/ai/core/tool/tool.ts

const TOOL_SYMBOL = Symbol('tool');
const FUNCTION_TOOL_SYMBOL = Symbol('function_tool');
const PROVIDER_TOOL_SYMBOL = Symbol('provider_tool');
const TOOLSET_SYMBOL = Symbol('toolset');
const TOOL_ERROR_SYMBOL = Symbol('tool_error');
const HANDOFF_SYMBOL = Symbol('handoff');

export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;

export type JSONArray = JSONValue[];

export type JSONObject = {
  [key: string]: JSONValue;
};

// Supports both Zod v3 and v4 schemas, as well as raw JSON schema
// Adapted from Vercel AI SDK's FlexibleSchema approach
// Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L67-L70
//
// Vercel uses StandardSchemaV1 from @standard-schema/spec package.
// We use a simpler approach by directly checking for schema properties:
// - Zod v3: Has `_output` property
// - Zod v4: Implements Standard Schema spec with `~standard` property
// - JSON Schema: Plain object fallback
export type ToolInputSchema<T = JSONObject> =
  | {
      // Zod v3 schema - has _output property for type inference
      _output: T;
    }
  | {
      // Zod v4 schema (Standard Schema) - has ~standard property
      '~standard': {
        types?: { output: T };
      };
    }
  | JSONSchema7;

/**
 * Infer the output type from a ToolInputSchema.
 * Adapted from Vercel AI SDK's InferSchema type.
 * Source: https://github.com/vercel/ai/blob/main/packages/provider-utils/src/schema.ts#L72-L79
 */
export type InferToolInput<T> = T extends { _output: infer O }
  ? O
  : T extends { '~standard': { types?: { output: infer O } } }
    ? O
    : any; // eslint-disable-line @typescript-eslint/no-explicit-any -- Fallback type for JSON Schema objects without type inference

/**
 * Tool argument type for a (possibly absent) parameters schema. When `parameters` is omitted the
 * generic defaults to `undefined`, yielding an empty-args type; otherwise the args are inferred
 * from the schema via {@link InferToolInput}. Wrapped in tuples to keep the check non-distributive.
 * @internal
 */
export type ToolArgs<Schema> = [Schema] extends [undefined]
  ? Record<string, never>
  : InferToolInput<Schema>;

export type ToolType = 'function' | 'provider';

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };

export type DuplicateMode = 'allow' | 'reject' | 'replace' | 'confirm';

export const CONFIRM_DUPLICATE_PARAM = 'lk_agents_confirm_duplicate';

const CONFIRM_DUPLICATE_DESCRIPTION =
  'Set this to true to confirm you want to run a duplicate. ' +
  'Only do this when user confirms the duplication is needed.';

export class ToolError extends Error {
  constructor(message: string) {
    super(message);

    Object.defineProperty(this, TOOL_ERROR_SYMBOL, {
      value: true,
    });
  }
}

export const ToolFlag = {
  NONE: 0,
  IGNORE_ON_ENTER: 1 << 0,
  CANCELLABLE: 1 << 1,
} as const;

export type ToolFlag = (typeof ToolFlag)[keyof typeof ToolFlag];

export interface AgentHandoff {
  /**
   * The agent to handoff to.
   */
  agent: Agent;

  /**
   * The return value of the tool.
   */
  returns?: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  [HANDOFF_SYMBOL]: true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handoff(options: { agent: Agent; returns?: any }): AgentHandoff {
  return {
    agent: options.agent,
    returns: options.returns,
    [HANDOFF_SYMBOL]: true,
  };
}

export interface ToolOptions<UserData = UnknownUserData> {
  /**
   * RunContext for the current agent session.
   */
  ctx: RunContext<UserData>;

  /**
   * The ID of the tool call.
   */
  toolCallId: string;

  /**
   * An abort signal that indicates that the overall operation should be aborted.
   */
  abortSignal: AbortSignal;
}

export type ToolExecuteFunction<
  Parameters extends JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
> = (args: Parameters, opts: ToolOptions<UserData>) => Promise<Result>;

export interface Tool {
  /**
   * The type of the tool.
   * @internal Either user-defined function tool or provider-side tool.
   */
  type: ToolType;

  /**
   * Stable identifier used to key the tool inside a `ToolContext`. For function tools this
   * mirrors `name`; for provider tools this is the provider tool id.
   */
  id: string;

  [TOOL_SYMBOL]: true;
}

// TODO(AJS-112): support provider tools
export abstract class ProviderTool implements Tool {
  readonly type = 'provider' as const;

  readonly id: string;

  readonly [TOOL_SYMBOL] = true as const;

  readonly [PROVIDER_TOOL_SYMBOL] = true as const;

  constructor({ id }: { id: string }) {
    this.id = id;
  }
}

export interface FunctionTool<
  Parameters extends JSONObject = JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
> extends Tool {
  type: 'function';

  /**
   * The name of the tool. Used to identify it inside a `ToolContext` and exposed to the LLM
   * as the function name to call. Also surfaced as the inherited `Tool.id`.
   */
  name: string;

  /**
   * The description of the tool. Will be used by the language model to decide whether to use the tool.
   */
  description: string;

  /**
   * The schema of the input that the tool expects. The language model will use this to generate the input.
   * It is also used to validate the output of the language model.
   * Use descriptions to make the input understandable for the language model.
   */
  parameters: ToolInputSchema<Parameters>;

  /**
   * An async function that is called with the arguments from the tool call and produces a result.
   * It also carries context about current session, user-defined data, and the tool call id, etc.
   */
  execute: ToolExecuteFunction<Parameters, UserData, Result>;

  flags: number;

  onDuplicate: DuplicateMode;

  [FUNCTION_TOOL_SYMBOL]: true;
}

export type AnonFunctionTool<
  Parameters extends JSONObject = JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
> = Omit<FunctionTool<Parameters, UserData, Result>, 'id' | 'name'> & {
  id?: never;
  name?: never;
};

export interface ToolCalledEvent<UserData = UnknownUserData> {
  ctx: RunContext<UserData>;
  arguments: Record<string, unknown>;
}

export interface ToolCompletedEvent<UserData = UnknownUserData> {
  ctx: RunContext<UserData>;
  output?: { type: 'output'; value: unknown } | { type: 'error'; value: Error };
}

/** Context passed to a {@link Toolset}'s `setup` hook when it activates. */
export interface ToolsetContext {
  /**
   * Replace the toolset's tools. Useful for dynamic sources
   * (e.g. an MCP server) whose tools are discovered after `setup` or change at runtime.
   */
  updateTools(tools: readonly ToolContextEntry[]): void;
}

/**
 * Function tools of a `ToolContext`, sorted by name for deterministic provider payloads.
 * Provider tools are intentionally excluded — callers that need them iterate `flatten()`.
 * @internal
 */
export function sortedToolEntries<UserData = UnknownUserData>(
  toolCtx: ToolContext<UserData>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- entries are generic function tools
): Array<[string, FunctionTool<any, UserData, any>]> {
  return Object.entries(toolCtx.functionTools).sort(([nameA], [nameB]) =>
    nameA.localeCompare(nameB),
  );
}

/** Function tool names of a `ToolContext`, sorted for deterministic output. @internal */
export function sortedToolNames(toolCtx: ToolContext | undefined): string[] {
  if (!toolCtx) return [];
  return Object.keys(toolCtx.functionTools).sort((nameA, nameB) => nameA.localeCompare(nameB));
}

/**
 * A stateful collection of tools sharing a lifecycle. Tools registered through a `Toolset` are
 * flattened into the surrounding `ToolContext`, while the `Toolset` itself is tracked so its
 * `setup()` / `aclose()` hooks can be invoked by the agent runtime.
 */
export class Toolset {
  readonly #id: string;

  #tools: readonly ToolContextEntry[];

  readonly [TOOLSET_SYMBOL] = true as const;

  constructor({ id, tools }: { id: string; tools: readonly ToolContextEntry[] }) {
    this.#id = id;
    this.#tools = [...tools];
  }

  /**
   * For when your tools share something that needs setup or cleanup, like a DB pool, an open MCP
   * client, or listeners on a shared bus. `setup` runs once at activation, `aclose` once at
   * teardown. If the tool list itself is dynamic (e.g. an MCP server), push it from `setup` via
   * {@link ToolsetContext.updateTools}.
   *
   * @example Static tool list with a shared backing resource
   * ```ts
   * function createPostgresToolset(connectionUrl: string): Toolset {
   *   const pool = new pg.Pool({ connectionString: connectionUrl });
   *   return Toolset.create({
   *     id: 'postgres',
   *     tools: [queryOrders, queryCustomers],
   *     aclose: () => pool.end(),
   *   });
   * }
   * ```
   *
   * @example Dynamic tool list bound to an external source
   * ```ts
   * function createMcpToolset(url: string): Toolset {
   *   const client = new MCPClient({ url });
   *   return Toolset.create({
   *     id: 'mcp_remote',
   *     // setup connects and wires listeners that push the server's tools whenever they change;
   *     // the runtime re-advertises without re-running anything.
   *     setup: async ({ updateTools }) => {
   *       const sync = async () => updateTools(await client.listTools());
   *       client.on('connect', sync);
   *       client.on('tool_list_changed', sync);
   *       await client.connect();
   *     },
   *     tools: [],
   *     aclose: () => client.disconnect(),
   *   });
   * }
   * ```
   */
  static create(options: ToolsetCreateOptions): Toolset {
    return new ToolsetFactory(options);
  }

  get id(): string {
    return this.#id;
  }

  get tools(): readonly ToolContextEntry[] {
    return this.#tools;
  }

  /**
   * Replace the toolset's current tools. Backs {@link ToolsetContext.updateTools}; the runtime
   * re-flattens and re-advertises after calling it.
   *
   * @internal
   */
  _setTools(tools: readonly ToolContextEntry[]): void {
    this.#tools = [...tools];
  }

  async setup(_ctx: ToolsetContext): Promise<void> {}

  async aclose(): Promise<void> {}
}

/** Options accepted by `Toolset.create()` — id + tools plus optional setup/teardown hooks. */
export interface ToolsetCreateOptions {
  id: string;
  /**
   * One-time async initialization run when the toolset activates — e.g. connecting to a server
   * and wiring listeners. Push a changed tool list via {@link ToolsetContext.updateTools}.
   */
  setup?: (ctx: ToolsetContext) => Promise<void>;
  /** The toolset's initial tools. */
  tools: readonly ToolContextEntry[];
  /** Invoked when the toolset is being torn down. Release awaitable resources here. */
  aclose?: () => Promise<void>;
}

/** Backing implementation of `Toolset.create()`. Kept private so callers go through the factory. */
class ToolsetFactory extends Toolset {
  readonly #setupFn?: (ctx: ToolsetContext) => Promise<void>;

  readonly #acloseFn?: () => Promise<void>;

  constructor({ id, setup, tools, aclose }: ToolsetCreateOptions) {
    super({ id, tools });
    this.#setupFn = setup;
    this.#acloseFn = aclose;
  }

  override async setup(ctx: ToolsetContext): Promise<void> {
    if (this.#setupFn) await this.#setupFn(ctx);
  }

  override async aclose(): Promise<void> {
    if (this.#acloseFn) await this.#acloseFn();
  }
}

/**
 * Tool context or data that can be normalized into one. Used by APIs that accept an already-built
 * context as well as direct tool lists or tool maps.
 */
export type ToolContextLike<UserData = UnknownUserData> =
  | ToolContext<UserData>
  | ToolContextInit<UserData>;

/**
 * Initial tool data accepted by `ToolContext` constructors and update methods.
 */
export type ToolContextInit<UserData = UnknownUserData> =
  | readonly ToolContextEntry<UserData>[]
  | ToolDefinitionMap<UserData>;

/**
 * Object shorthand for declaring anonymous function tools keyed by their model-visible names.
 */
export type ToolDefinitionMap<UserData = UnknownUserData> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- entries accept any parameter/result types
  readonly [toolName: string]: AnonFunctionTool<any, UserData, any>;
};

export function toToolContext<UserData = UnknownUserData>(
  input: ToolContextLike<UserData>,
): ToolContext<UserData>;

export function toToolContext<UserData = UnknownUserData>(
  input: ToolContextLike<UserData> | undefined,
): ToolContext<UserData> | undefined;

export function toToolContext<UserData = UnknownUserData>(
  input: ToolContextLike<UserData> | undefined,
): ToolContext<UserData> | undefined {
  if (input === undefined) return undefined;
  return input instanceof ToolContext ? input : new ToolContext(input);
}

export function normalizeToolContextInit<UserData = UnknownUserData>(
  input: ToolContextInit<UserData>,
): ToolContextEntry<UserData>[] {
  if (Array.isArray(input)) {
    return [...input];
  }

  return Object.entries(input).map(([name, toolValue]) => {
    if (name.length === 0) {
      throw new Error('tools object keys must be non-empty');
    }

    if (!isAnonFunctionTool(toolValue)) {
      throw new Error(`tools object entry "${name}" must be an anonymous function tool`);
    }

    if ('name' in toolValue || 'id' in toolValue) {
      throw new Error(`tools object entry "${name}" must be anonymous`);
    }

    return {
      ...toolValue,
      id: name,
      name,
    };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolContext entries accept any function-tool parameter/result types
export type ToolContextEntry<UserData = any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  FunctionTool<any, UserData, any> | ProviderTool | Toolset;

export class ToolContext<UserData = UnknownUserData> {
  private _tools: ToolContextEntry<UserData>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ToolContext stores generic function tools
  private _functionToolsMap: Map<string, FunctionTool<any, UserData, any>> = new Map();
  private _providerTools: ProviderTool[] = [];
  private _toolsets: Toolset[] = [];

  constructor(tools: ToolContextInit<UserData> = []) {
    this.updateTools(tools);
  }

  static empty<UserData = UnknownUserData>(): ToolContext<UserData> {
    return new ToolContext<UserData>([]);
  }

  /** A copy of all function tools in the tool context, including those in tool sets. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get functionTools(): Record<string, FunctionTool<any, UserData, any>> {
    return Object.fromEntries(this._functionToolsMap);
  }

  /** A copy of all provider tools in the tool context, including those in tool sets. */
  get providerTools(): ProviderTool[] {
    return [...this._providerTools];
  }

  /** A copy of all toolsets registered in the context. */
  get toolsets(): readonly Toolset[] {
    return [...this._toolsets];
  }

  /**
   * A copy of the raw tool list this context was constructed with.
   */
  get tools(): readonly ToolContextEntry<UserData>[] {
    return [...this._tools];
  }

  /** Flatten the tool context to a list of tools. */
  flatten(): Tool[] {
    return [...this._functionToolsMap.values(), ...this._providerTools];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic registry over any parameter/result types
  getFunctionTool(id: string): FunctionTool<any, UserData, any> | undefined {
    return this._functionToolsMap.get(id);
  }

  hasTool(id: string): boolean {
    if (this._functionToolsMap.has(id)) {
      return true;
    }
    return this._providerTools.some((tool) => tool.id === id);
  }

  updateTools(tools: ToolContextInit<UserData>): void {
    this._updateTools(tools);
  }

  private _updateTools(tools: ToolContextInit<UserData>, exclude: readonly Tool[] = []): void {
    const normalizedTools = normalizeToolContextInit(tools);
    const excludedTools = new Set<unknown>(exclude);
    this._tools = normalizedTools;
    this._functionToolsMap = new Map();
    this._providerTools = [];
    this._toolsets = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any tool shape
    const addTool = (tool: any): void => {
      if (excludedTools.has(tool)) {
        return;
      }

      if (isToolset(tool)) {
        for (const inner of tool.tools) {
          addTool(inner);
        }
        this._toolsets.push(tool);
        return;
      }

      if (isProviderTool(tool)) {
        this._providerTools.push(tool);
        return;
      }

      if (isFunctionTool(tool)) {
        const existing = this._functionToolsMap.get(tool.id);
        if (existing !== undefined) {
          if (existing !== tool) {
            throw new Error(`duplicate function name: ${tool.id}`);
          }
          return; // same instance, skip
        }
        this._functionToolsMap.set(tool.id, tool);
        return;
      }

      throw new Error(`unknown tool type: ${typeof tool}`);
    };

    for (const tool of normalizedTools) {
      addTool(tool);
    }
  }

  private _syncFlattened(tools: readonly Tool[]): void {
    const current = this.flatten();
    const currentTools = new Set(current);
    const nextTools = new Set(tools);
    if (currentTools.size === nextTools.size && current.every((tool) => nextTools.has(tool))) {
      return;
    }

    const added: Extract<ToolContextEntry<UserData>, Tool>[] = tools
      .filter((tool) => !currentTools.has(tool))
      .filter(
        (tool): tool is Extract<ToolContextEntry<UserData>, Tool> =>
          isFunctionTool(tool) || isProviderTool(tool),
      );
    const removed = current.filter((tool) => !nextTools.has(tool));
    const structured = this._tools.filter((tool) => !removed.includes(tool as Tool));
    this._updateTools([...structured, ...added], removed);
  }

  /** Hide tools from the callable set while keeping their toolsets intact. @internal */
  _exclude(tools: readonly Tool[]): void {
    if (tools.length === 0) {
      return;
    }

    const excludedTools = new Set(tools);
    this._syncFlattened(this.flatten().filter((tool) => !excludedTools.has(tool)));
  }

  /** Return a copy containing only flattened callable/provider entries. @internal */
  _flattenedCopy(): ToolContext<UserData> {
    const copy = ToolContext.empty<UserData>();
    copy._syncFlattened(this.flatten());
    return copy;
  }

  copy(): ToolContext<UserData> {
    return new ToolContext<UserData>([...this._tools]);
  }

  equals(other: ToolContext): boolean {
    if (this._functionToolsMap.size !== other._functionToolsMap.size) {
      return false;
    }

    for (const [id, tool] of this._functionToolsMap) {
      if (other._functionToolsMap.get(id) !== tool) {
        return false;
      }
    }

    if (this._providerTools.length !== other._providerTools.length) {
      return false;
    }

    // Provider tools compare as identity sets to match Python's `set(id(t) for t in ...)`
    // semantics — order is not significant.
    const otherProviderIds = new Set(other._providerTools);
    for (const tool of this._providerTools) {
      if (!otherProviderIds.has(tool)) {
        return false;
      }
    }

    if (this._toolsets.length !== other._toolsets.length) {
      return false;
    }

    const otherToolsets = new Set(other._toolsets);
    for (const ts of this._toolsets) {
      if (!otherToolsets.has(ts)) {
        return false;
      }
    }
    return true;
  }
}

export function isSameToolChoice(choice1: ToolChoice | null, choice2: ToolChoice | null): boolean {
  if (choice1 === choice2) {
    return true;
  }
  if (choice1 === null || choice2 === null) {
    return false;
  }
  if (typeof choice1 === 'string' && typeof choice2 === 'string') {
    return choice1 === choice2;
  }
  if (typeof choice1 === 'object' && typeof choice2 === 'object') {
    return choice1.type === choice2.type && choice1.function.name === choice2.function.name;
  }
  return false;
}

/**
 * Create a function tool. Parameters are inferred from the schema; omit `parameters` for a tool
 * that takes no arguments.
 */
export function tool<
  UserData = UnknownUserData,
  Schema extends ToolInputSchema<any> | undefined = undefined, // eslint-disable-line @typescript-eslint/no-explicit-any -- Generic constraint needs to accept any JSONObject type
  Result = unknown,
>({
  name,
  description,
  parameters,
  execute,
  flags,
  onDuplicate,
}: {
  /** Unique name the model calls the tool by. Must be non-empty. */
  name: string;
  /** Natural-language description that tells the model when to use this tool. */
  description: string;
  /**
   * Input schema for the tool's arguments — either a Zod object schema (args
   * are type-inferred) or a raw JSON Schema. Omit for a tool that takes no
   * arguments.
   */
  parameters?: Schema;
  /**
   * Called when the model invokes the tool. Receives the parsed arguments (an
   * empty object when `parameters` is omitted) and a {@link RunContext}
   * (`ctx`); the returned value is sent back to the model.
   */
  execute: ToolExecuteFunction<ToolArgs<Schema>, UserData, Result>;
  /**
   * Bitmask of {@link ToolFlag}s, e.g. `ToolFlag.CANCELLABLE` to allow the call
   * to be cancelled mid-flight. Defaults to `ToolFlag.NONE`.
   */
  flags?: number;
  /**
   * How a concurrent duplicate call of this tool is handled while one is still
   * running: `'allow'` | `'reject'` | `'replace'` | `'confirm'`. Defaults to
   * `'allow'`.
   */
  onDuplicate?: DuplicateMode;
}): FunctionTool<ToolArgs<Schema>, UserData, Result>;

/**
 * Create an anonymous (name-less) function tool. Parameters are inferred from the schema; omit
 * `parameters` for a tool that takes no arguments.
 */
export function tool<
  UserData = UnknownUserData,
  Schema extends ToolInputSchema<any> | undefined = undefined, // eslint-disable-line @typescript-eslint/no-explicit-any -- Generic constraint needs to accept any JSONObject type
  Result = unknown,
>({
  description,
  parameters,
  execute,
  flags,
  onDuplicate,
}: {
  /** Omitted in object syntax; the containing object key becomes the tool name. */
  name?: never;
  /** Natural-language description that tells the model when to use this tool. */
  description: string;
  /**
   * Input schema for the tool's arguments — either a Zod object schema (args
   * are type-inferred) or a raw JSON Schema. Omit for a tool that takes no
   * arguments.
   */
  parameters?: Schema;
  /**
   * Called when the model invokes the tool. Receives the parsed arguments (an
   * empty object when `parameters` is omitted) and a {@link RunContext}
   * (`ctx`); the returned value is sent back to the model.
   */
  execute: ToolExecuteFunction<ToolArgs<Schema>, UserData, Result>;
  /**
   * Bitmask of {@link ToolFlag}s, e.g. `ToolFlag.CANCELLABLE` to allow the call
   * to be cancelled mid-flight. Defaults to `ToolFlag.NONE`.
   */
  flags?: number;
  /**
   * How a concurrent duplicate call of this tool is handled while one is still
   * running: `'allow'` | `'reject'` | `'replace'` | `'confirm'`. Defaults to
   * `'allow'`.
   */
  onDuplicate?: DuplicateMode;
}): AnonFunctionTool<ToolArgs<Schema>, UserData, Result>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tool(tool: any): any {
  if (tool.name !== undefined && (typeof tool.name !== 'string' || tool.name.length === 0)) {
    throw new Error('tool({ name, ... }) requires a non-empty name');
  }

  const onDuplicate: DuplicateMode = tool.onDuplicate ?? 'allow';

  // Default parameters to z.object({}) if not provided
  let parameters = tool.parameters ?? z.object({});

  // if parameters is a Zod schema, ensure it's an object schema
  if (isZodSchema(parameters) && !isZodObjectSchema(parameters)) {
    throw new Error('Tool parameters must be a Zod object schema (z.object(...))');
  }

  // Ensure parameters is either a Zod schema or a plain object (JSON schema)
  if (!isZodSchema(parameters) && !(typeof parameters === 'object')) {
    throw new Error('Tool parameters must be a Zod object schema or a raw JSON schema');
  }

  if (onDuplicate === 'confirm') {
    parameters = injectConfirmDuplicateParameter(parameters);
  }

  const execute =
    onDuplicate === 'confirm' ? wrapConfirmDuplicateExecute(tool.execute) : tool.execute;

  const functionTool = {
    type: 'function',
    description: tool.description,
    parameters,
    execute,
    flags: tool.flags ?? ToolFlag.NONE,
    onDuplicate,
    [TOOL_SYMBOL]: true,
    [FUNCTION_TOOL_SYMBOL]: true,
  };

  if (tool.name === undefined) {
    return functionTool;
  }

  return {
    ...functionTool,
    id: tool.name,
    name: tool.name,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectConfirmDuplicateParameter(parameters: any): any {
  if (isZodSchema(parameters)) {
    const maybeObjectSchema = parameters as {
      extend?: (shape: Record<string, unknown>) => unknown;
    };
    if (typeof maybeObjectSchema.extend === 'function') {
      const confirmSchema = isZod4Schema(parameters)
        ? z4.boolean().nullable().describe(CONFIRM_DUPLICATE_DESCRIPTION)
        : z.boolean().nullable().describe(CONFIRM_DUPLICATE_DESCRIPTION);
      return maybeObjectSchema.extend({ [CONFIRM_DUPLICATE_PARAM]: confirmSchema });
    }
    throw new Error('Tool parameters must be a Zod object schema (z.object(...))');
  }

  const properties = {
    ...(parameters.properties ?? {}),
    [CONFIRM_DUPLICATE_PARAM]: {
      type: ['boolean', 'null'],
      description: CONFIRM_DUPLICATE_DESCRIPTION,
    },
  };
  const required = [...(parameters.required ?? [])];
  if (!required.includes(CONFIRM_DUPLICATE_PARAM)) {
    required.push(CONFIRM_DUPLICATE_PARAM);
  }

  return {
    ...parameters,
    properties,
    required,
  };
}

function wrapConfirmDuplicateExecute<
  Parameters extends JSONObject,
  UserData = UnknownUserData,
  Result = unknown,
>(
  execute: ToolExecuteFunction<Parameters, UserData, Result>,
): ToolExecuteFunction<Parameters, UserData, Result> {
  return async (args, opts) => {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const stripped = { ...args };
      delete stripped[CONFIRM_DUPLICATE_PARAM];
      return execute(stripped, opts);
    }
    return execute(args, opts);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isTool(tool: any): tool is Tool {
  return !!tool && tool[TOOL_SYMBOL] === true;
}

export function isFunctionTool(tool: unknown): tool is FunctionTool {
  const maybeTool = tool as Partial<FunctionTool>;
  return (
    isAnonFunctionTool(tool) &&
    typeof maybeTool.id === 'string' &&
    typeof maybeTool.name === 'string'
  );
}

function isAnonFunctionTool(tool: unknown): tool is AnonFunctionTool {
  const maybeTool = tool as Partial<AnonFunctionTool>;
  return isTool(tool) && maybeTool[FUNCTION_TOOL_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isProviderTool(tool: any): tool is ProviderTool {
  return isTool(tool) && (tool as ProviderTool)[PROVIDER_TOOL_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isToolset(value: any): value is Toolset {
  return !!value && value[TOOLSET_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isToolError(error: any): error is ToolError {
  return !!error && error[TOOL_ERROR_SYMBOL] === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAgentHandoff(handoff: any): handoff is AgentHandoff {
  return !!handoff && handoff[HANDOFF_SYMBOL] === true;
}
