// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Client, ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONSchema7 } from 'json-schema';
import { log } from '../log.js';
import { AsyncToolset, type AsyncToolsetCreateOptions } from './async_toolset.js';
import {
  type DuplicateMode,
  type FunctionTool,
  type JSONObject,
  ToolError,
  ToolFlag,
  type ToolsetContext,
  tool,
} from './tool_context.js';

export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type MCPToolContent = { type: string; [key: string]: unknown };

export interface MCPToolCallResult {
  content: MCPToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

export interface MCPToolResultContext {
  toolName: string;
  arguments: JSONObject;
  result: MCPToolCallResult;
}

export type MCPToolResultResolver = (ctx: MCPToolResultContext) => unknown | Promise<unknown>;

export interface MCPToolOptions {
  flags?: number;
  onDuplicate?: DuplicateMode;
  reportProgress?: boolean;
}
export interface MCPServerOptions {
  clientSessionTimeout?: number | null;
  toolResultResolver?: MCPToolResultResolver;
}

const MCP_SERVER_UNAVAILABLE =
  'MCP server connection is unavailable. Please check that the MCP server is still running.';
const MCP_TOOL_CALL_FAILED = 'MCP tool call failed unexpectedly.';
const MCP_TOOL_RESULT_PROCESSING_FAILED = 'MCP tool result processing failed unexpectedly.';
const MCP_CONNECTION_CLOSED = -32000;
const MCP_SDK_PACKAGE = '@modelcontextprotocol/sdk';
const MCP_SDK_INSTALL_MESSAGE =
  `The '${MCP_SDK_PACKAGE}' package is required to use MCP servers. ` +
  `Install it with: pnpm add ${MCP_SDK_PACKAGE}`;

const DEFAULT_TOOL_OPTIONS: Required<MCPToolOptions> = {
  flags: ToolFlag.NONE,
  onDuplicate: 'allow',
  reportProgress: false,
};
const defaultToolResultResolver: MCPToolResultResolver = ({ toolName, result }) => {
  if (result.content.length === 0) {
    throw new ToolError(`Tool '${toolName}' completed without producing a result.`);
  }
  return JSON.stringify(result.content.length === 1 ? result.content[0] : result.content);
};

function isMissingMCPPackage(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    error.message.includes(MCP_SDK_PACKAGE)
  );
}

async function loadMCPModule<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isMissingMCPPackage(error)) {
      throw new Error(MCP_SDK_INSTALL_MESSAGE, { cause: error });
    }
    throw error;
  }
}

async function loadMCPClient(): Promise<typeof Client> {
  return (await loadMCPModule(() => import('@modelcontextprotocol/sdk/client/index.js'))).Client;
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'McpError') {
    return 'code' in error && error.code === MCP_CONNECTION_CLOSED;
  }
  return /(?:connection|transport|stream|resource).*(?:closed|broken)|(?:closed|broken).*(?:connection|transport|stream|resource)/i.test(
    `${error.name}: ${error.message}`,
  );
}

function safeErrorType(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function isMCPToolCallResult(result: unknown): result is MCPToolCallResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    Array.isArray(result.content)
  );
}

export abstract class MCPServer {
  protected logger = log();
  private client: Client | null = null;
  private connectingClient: Client | null = null;
  private initializing?: { generation: number; promise: Promise<void> };
  private connectionGeneration = 0;
  private cachedTools?: MCPToolDescriptor[];
  private toolsDirty = true;
  private toolListGeneration = 0;
  private listeners = new Set<() => void | Promise<void>>();
  private readonly clientSessionTimeout: number | null;
  private readonly toolResultResolver: MCPToolResultResolver;

  constructor(options: MCPServerOptions = {}) {
    this.clientSessionTimeout =
      options.clientSessionTimeout === undefined ? 5000 : options.clientSessionTimeout;
    this.toolResultResolver = options.toolResultResolver ?? defaultToolResultResolver;
  }

  get initialized(): boolean {
    return this.client !== null;
  }

  /** @internal Whether every MCP request has a finite client-side timeout. */
  get _hasBoundedRequests(): boolean {
    return this.clientSessionTimeout !== null;
  }

  invalidateCache(): void {
    this.toolsDirty = true;
    this.toolListGeneration += 1;
  }

  onToolsChanged(listener: () => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected async notifyToolsChanged(): Promise<void> {
    this.invalidateCache();
    const results = await Promise.allSettled(
      [...this.listeners].map((listener) => Promise.resolve().then(listener)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          { errorType: safeErrorType(result.reason) },
          'failed to refresh MCP tools after change',
        );
      }
    }
  }

  async initialize(): Promise<void> {
    const requestedGeneration = this.connectionGeneration;
    while (!this.client && requestedGeneration === this.connectionGeneration) {
      const initializing = this.initializing;
      if (initializing) {
        try {
          await initializing.promise;
        } catch (error) {
          if (initializing.generation === requestedGeneration) throw error;
        }
        continue;
      }

      const connectionGeneration = requestedGeneration;
      const entry = {
        generation: connectionGeneration,
        promise: (async () => {
          const ClientCtor = await loadMCPClient();
          const clientOptions: ClientOptions = {
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 0,
                onChanged: () => void this.notifyToolsChanged(),
              },
            },
          };
          const client = new ClientCtor(
            { name: 'livekit-agents', version: '1.0.0' },
            clientOptions,
          );
          this.connectingClient = client;
          try {
            const transport = (await this.createTransport()) as Transport;
            if (connectionGeneration !== this.connectionGeneration) return;
            await client.connect(transport);
            if (connectionGeneration !== this.connectionGeneration) {
              return;
            }
            this.client = client;
          } finally {
            if (this.connectingClient === client) {
              this.connectingClient = null;
              if (this.client !== client) await this.closeClient(client);
            }
          }
        })(),
      };
      entry.promise = entry.promise.finally(() => {
        if (this.initializing === entry) this.initializing = undefined;
      });
      this.initializing = entry;
      await entry.promise;
    }
  }

  async aclose(): Promise<void> {
    this.connectionGeneration += 1;
    const initializing = this.initializing?.promise;
    const client = this.client;
    const connectingClient = this.connectingClient;
    this.connectingClient = null;
    this.resetConnection();
    if (connectingClient) {
      await this.closeClient(connectingClient);
    }
    await initializing?.catch(() => undefined);
    if (client && client !== connectingClient) {
      await this.closeClient(client);
    }
  }

  async listTools(options: Record<string, MCPToolOptions> = {}): Promise<FunctionTool[]> {
    const descriptors = this.filterTools(await this.listRawTools());
    return descriptors.map((descriptor) =>
      this.makeTool(descriptor, { ...DEFAULT_TOOL_OPTIONS, ...options[descriptor.name] }),
    );
  }

  protected abstract createTransport(): Promise<unknown>;

  protected filterTools(tools: readonly MCPToolDescriptor[]): readonly MCPToolDescriptor[] {
    return tools;
  }

  private async listRawTools(): Promise<MCPToolDescriptor[]> {
    const client = this.client;
    if (!client) throw new Error('MCPServer is not initialized');
    if (!this.toolsDirty && this.cachedTools) return this.cachedTools;

    try {
      const toolListGeneration = this.toolListGeneration;
      const tools: MCPToolDescriptor[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(
          cursor === undefined ? undefined : { cursor },
          this.requestOptions(),
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      if (toolListGeneration === this.toolListGeneration) {
        this.cachedTools = tools;
        this.toolsDirty = false;
      }
      return tools;
    } catch (error) {
      if (isConnectionError(error)) {
        await this.disconnectClient(client);
        throw new Error(MCP_SERVER_UNAVAILABLE);
      }
      throw error;
    }
  }

  private makeTool(
    descriptor: MCPToolDescriptor,
    options: Required<MCPToolOptions>,
  ): FunctionTool<JSONObject> {
    const { name } = descriptor;
    return tool({
      name,
      description: descriptor.description ?? '',
      parameters: descriptor.inputSchema as JSONSchema7,
      flags: options.flags,
      onDuplicate: options.onDuplicate,
      execute: async (args, { ctx, abortSignal }) => {
        const client = this.client;
        if (!client) throw new ToolError(MCP_SERVER_UNAVAILABLE);

        let response: unknown;
        try {
          response = await client.callTool(
            { name, arguments: args },
            undefined,
            this.requestOptions(
              options.reportProgress
                ? ({ message }) => {
                    if (message) {
                      void ctx.update(message).catch((error) => {
                        this.logger.warn(
                          { errorType: safeErrorType(error), toolName: name },
                          'failed to report progress for MCP tool',
                        );
                      });
                    }
                  }
                : undefined,
              abortSignal,
            ),
          );
        } catch (error) {
          if (isConnectionError(error)) {
            await this.disconnectClient(client);
            throw new ToolError(MCP_SERVER_UNAVAILABLE);
          }
          throw new ToolError(MCP_TOOL_CALL_FAILED);
        }
        if (!isMCPToolCallResult(response)) {
          throw new ToolError(`Tool '${name}' returned an unsupported legacy result.`);
        }

        if (response.isError)
          throw new ToolError(
            response.content
              .map((part) =>
                'text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part),
              )
              .join('\n'),
          );
        try {
          const resolved = await this.toolResultResolver({
            toolName: name,
            arguments: args,
            result: response,
          });
          if (resolved instanceof Error) throw resolved;
          return resolved;
        } catch {
          throw new ToolError(MCP_TOOL_RESULT_PROCESSING_FAILED);
        }
      },
    }) as FunctionTool<JSONObject>;
  }

  private requestOptions(
    onprogress?: RequestOptions['onprogress'],
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    return this.clientSessionTimeout === null && !onprogress && !signal
      ? undefined
      : {
          ...(this.clientSessionTimeout === null ? {} : { timeout: this.clientSessionTimeout }),
          onprogress,
          signal,
        };
  }

  private resetConnection(): void {
    this.client = null;
    this.cachedTools = undefined;
    this.invalidateCache();
  }

  private async disconnectClient(client: Client): Promise<void> {
    if (this.client !== client) return;
    this.resetConnection();
    await this.closeClient(client);
  }

  private async closeClient(client: Client): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      this.logger.warn({ errorType: safeErrorType(error) }, 'error closing MCP client');
    }
  }
}

export type MCPHTTPTransportType = 'sse' | 'streamable_http';

export interface MCPServerHTTPOptions extends MCPServerOptions {
  url: string;
  transportType?: MCPHTTPTransportType;
  allowedTools?: string[];
  headers?: Record<string, string>;
  /** Allow plaintext HTTP. Intended only for trusted local development. */
  allowInsecureHttp?: boolean;
}
export class MCPServerHTTP extends MCPServer {
  readonly url: string;
  readonly transportType: MCPHTTPTransportType;
  private readonly headers: Record<string, string>;
  private readonly allowed?: Set<string>;

  constructor(options: MCPServerHTTPOptions) {
    super(options);
    const url = new URL(options.url);
    if (
      url.protocol !== 'https:' &&
      !(options.allowInsecureHttp === true && url.protocol === 'http:')
    ) {
      throw new Error(
        'MCPServerHTTP requires an https: URL. Set allowInsecureHttp to true only for trusted local development.',
      );
    }
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.allowed = options.allowedTools?.length ? new Set(options.allowedTools) : undefined;
    this.transportType =
      options.transportType ??
      (url.pathname.replace(/\/$/, '').endsWith('/mcp') ? 'streamable_http' : 'sse');
  }

  protected override async createTransport(): Promise<unknown> {
    const requestInit: RequestInit = { headers: this.headers };
    if (this.transportType === 'streamable_http') {
      const { StreamableHTTPClientTransport } = await loadMCPModule(
        () => import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      );
      return new StreamableHTTPClientTransport(new URL(this.url), { requestInit });
    }
    const { SSEClientTransport } = await loadMCPModule(
      () => import('@modelcontextprotocol/sdk/client/sse.js'),
    );
    return new SSEClientTransport(new URL(this.url), { requestInit });
  }

  protected override filterTools(
    tools: readonly MCPToolDescriptor[],
  ): readonly MCPToolDescriptor[] {
    const allowed = this.allowed;
    return allowed ? tools.filter(({ name }) => allowed.has(name)) : tools;
  }
}
export interface MCPServerStdioOptions extends MCPServerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class MCPServerStdio extends MCPServer {
  readonly command: string;
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;

  constructor(options: MCPServerStdioOptions) {
    super(options);
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env;
    this.cwd = options.cwd;
  }

  protected override async createTransport(): Promise<unknown> {
    const { StdioClientTransport } = await loadMCPModule(
      () => import('@modelcontextprotocol/sdk/client/stdio.js'),
    );
    return new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: this.env,
      cwd: this.cwd,
    });
  }
}

export interface MCPToolsetOptions {
  id: string;
  mcpServer: MCPServer;
  toolOptions?: Record<string, MCPToolOptions>;
  toolHandling?: AsyncToolsetCreateOptions['toolHandling'];
}

export class MCPToolset extends AsyncToolset {
  private readonly server: MCPServer;
  private readonly options: Record<string, MCPToolOptions>;
  private unsubscribe?: () => void;
  private refreshPromise?: Promise<void>;
  private refreshRequested = false;
  private refreshGeneration = 0;
  private context?: ToolsetContext;

  constructor({ id, mcpServer, toolOptions, toolHandling }: MCPToolsetOptions) {
    super({ id, tools: [], toolHandling });
    this.server = mcpServer;
    this.options = toolOptions ?? {};
  }

  override async setup(ctx: ToolsetContext): Promise<void> {
    this.context = ctx;
    this.refreshGeneration += 1;
    this.unsubscribe ??= this.server.onToolsChanged(() => this.requestRefresh());
    await this.requestRefresh();
  }

  override async aclose(): Promise<void> {
    this.context = undefined;
    this.refreshGeneration += 1;
    this.refreshRequested = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // An unbounded request must be interrupted so executor drain cannot block shutdown forever.
    if (!this.server._hasBoundedRequests) {
      await this.server.aclose();
      await this.settleRefresh();
      await super.aclose();
      return;
    }

    try {
      await super.aclose();
    } finally {
      await this.server.aclose();
      await this.settleRefresh();
    }
  }

  private async requestRefresh(): Promise<void> {
    this.refreshRequested = true;
    this.refreshPromise ??= this.refreshTools().finally(() => {
      this.refreshPromise = undefined;
    });
    await this.refreshPromise;
  }

  private async refreshTools(): Promise<void> {
    while (this.refreshRequested) {
      this.refreshRequested = false;
      const context = this.context;
      const generation = this.refreshGeneration;
      if (!context) continue;

      try {
        await this.server.initialize();
        const tools = await this.server.listTools(this.options);
        if (context === this.context && generation === this.refreshGeneration) {
          context.updateTools(tools);
        }
      } catch (error) {
        if (context === this.context && generation === this.refreshGeneration) throw error;
      }
    }
  }

  private async settleRefresh(): Promise<void> {
    await this.refreshPromise?.catch(() => undefined);
  }
}
