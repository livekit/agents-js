// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { JSONSchema7 } from 'json-schema';
import { log } from '../log.js';
import {
  type FunctionTool,
  type JSONObject,
  type ToolContext,
  ToolError,
  tool,
} from './tool_context.js';

// `@modelcontextprotocol/sdk` is an optional peer dependency. The types below
// describe the minimal subset of the SDK we rely on so the rest of the file
// can typecheck without the SDK being present at build time.
type MCPClient = {
  connect: (transport: MCPTransport) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools: MCPToolDescriptor[] }>;
  callTool: (params: { name: string; arguments?: JSONObject }) => Promise<MCPToolCallResult>;
};

type MCPTransport = unknown;

interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: JSONObject;
    required?: string[];
    [k: string]: unknown;
  };
  _meta?: JSONObject;
}

interface MCPTextContent {
  type: 'text';
  text: string;
  [k: string]: unknown;
}

interface MCPImageContent {
  type: 'image';
  data: string;
  mimeType: string;
  [k: string]: unknown;
}

interface MCPOtherContent {
  type: string;
  [k: string]: unknown;
}

export type MCPToolContent = MCPTextContent | MCPImageContent | MCPOtherContent;

export interface MCPToolCallResult {
  content: MCPToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
}

export interface MCPToolResultContext {
  toolName: string;
  arguments: JSONObject;
  result: MCPToolCallResult;
}

/**
 * Resolver invoked to convert an MCP tool result into the value that is
 * returned to the LLM. The default implementation serializes the content
 * blocks to JSON.
 */
export type MCPToolResultResolver = (ctx: MCPToolResultContext) => unknown | Promise<unknown>;

const defaultToolResultResolver: MCPToolResultResolver = (ctx) => {
  const content = ctx.result.content;
  if (content.length === 1) {
    return JSON.stringify(content[0]);
  }
  if (content.length > 1) {
    return JSON.stringify(content);
  }
  throw new ToolError(
    `Tool '${ctx.toolName}' completed without producing a result. ` +
      'This might indicate an issue with internal processing.',
  );
};

export interface MCPServerOptions {
  /**
   * Per-request timeout (in milliseconds) for the underlying MCP client
   * session. `null` disables the timeout.
   */
  clientSessionTimeout?: number | null;
  /**
   * Callback used to convert the raw MCP tool result into a value returned to
   * the LLM. Defaults to a JSON serializer.
   */
  toolResultResolver?: MCPToolResultResolver;
}

const DEFAULT_CLIENT_SESSION_TIMEOUT = 5000;

/**
 * Lazily-imported handle to the MCP SDK so users that do not need MCP do not
 * have to install `@modelcontextprotocol/sdk`. We only resolve the SDK when
 * an `MCPServer` is initialized.
 */
async function loadMCPClient(): Promise<
  new (info: { name: string; version: string }) => MCPClient
> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import of optional peer
    const mod: any = await import('@modelcontextprotocol/sdk/client/index.js');
    return mod.Client;
  } catch (err) {
    throw new Error(
      "The '@modelcontextprotocol/sdk' package is required to use MCP servers but is not installed.\n" +
        'Install it with: pnpm add @modelcontextprotocol/sdk',
    );
  }
}

/**
 * Base class for an MCP server connection. Concrete subclasses provide a
 * transport (HTTP/SSE/stdio) by implementing :meth:`createTransport`.
 */
export abstract class MCPServer {
  protected logger = log();
  private _client: MCPClient | null = null;
  private _initializing: Promise<void> | null = null;
  private _cacheDirty = true;
  private _cachedTools: ToolContext | null = null;
  private readonly _clientSessionTimeout: number | null;
  private readonly _toolResultResolver: MCPToolResultResolver;

  constructor(options: MCPServerOptions = {}) {
    this._clientSessionTimeout =
      options.clientSessionTimeout === undefined
        ? DEFAULT_CLIENT_SESSION_TIMEOUT
        : options.clientSessionTimeout;
    this._toolResultResolver = options.toolResultResolver ?? defaultToolResultResolver;
  }

  get initialized(): boolean {
    return this._client !== null;
  }

  invalidateCache(): void {
    this._cacheDirty = true;
  }

  /**
   * Connect to the MCP server. Subsequent calls while a connection is active
   * are a no-op.
   */
  async initialize(): Promise<void> {
    if (this._client) return;
    if (this._initializing) {
      await this._initializing;
      return;
    }

    this._initializing = (async () => {
      const ClientCtor = await loadMCPClient();
      const client = new ClientCtor({ name: 'livekit-agents', version: '1.0.0' });
      const transport = await this.createTransport();
      await client.connect(transport);
      this._client = client;
    })();

    try {
      await this._initializing;
    } finally {
      this._initializing = null;
    }
  }

  /** Close the MCP server connection. */
  async aclose(): Promise<void> {
    const client = this._client;
    this._client = null;
    this._cachedTools = null;
    this._cacheDirty = true;
    if (client) {
      try {
        await client.close();
      } catch (err) {
        this.logger.warn({ err }, 'error closing MCP client');
      }
    }
  }

  /**
   * List the tools exposed by the server, returned as a {@link ToolContext}
   * keyed by tool name. The result is cached until {@link invalidateCache} is
   * called.
   */
  async listTools(): Promise<ToolContext> {
    if (!this._client) {
      throw new Error('MCPServer is not initialized');
    }
    if (!this._cacheDirty && this._cachedTools) {
      return this._cachedTools;
    }

    const result = await this._client.listTools();
    const tools: ToolContext = {};
    for (const t of result.tools) {
      tools[t.name] = this._makeFunctionTool(t);
    }
    this._cachedTools = tools;
    this._cacheDirty = false;
    return tools;
  }

  protected abstract createTransport(): Promise<MCPTransport>;

  protected get clientSessionTimeout(): number | null {
    return this._clientSessionTimeout;
  }

  private _makeFunctionTool(descriptor: MCPToolDescriptor): FunctionTool<JSONObject> {
    const name = descriptor.name;
    return tool({
      description: descriptor.description ?? '',
      parameters: descriptor.inputSchema as unknown as JSONSchema7,
      execute: async (args: JSONObject) => {
        const client = this._client;
        if (!client) {
          throw new ToolError(
            'Tool invocation failed: internal service is unavailable. ' +
              'Please check that the MCPServer is still running.',
          );
        }

        const result = await client.callTool({ name, arguments: args });

        if (result.isError) {
          const text = result.content
            .map((part) =>
              'text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part),
            )
            .join('\n');
          throw new ToolError(text);
        }

        return await this._toolResultResolver({
          toolName: name,
          arguments: args,
          result,
        });
      },
    }) as FunctionTool<JSONObject>;
  }
}

export type MCPHTTPTransportType = 'sse' | 'streamable_http';

export interface MCPServerHTTPOptions extends MCPServerOptions {
  /** URL of the MCP server. */
  url: string;
  /**
   * Explicit transport type. If omitted, the type is inferred from the URL
   * path: paths ending with `/mcp` use `streamable_http`, all others fall
   * back to `sse`.
   *
   * Note: SSE is being deprecated in favor of streamable HTTP. See
   * https://github.com/modelcontextprotocol/modelcontextprotocol/pull/206.
   */
  transportType?: MCPHTTPTransportType;
  /** Optional list of tool names to expose. When set, all other tools are filtered out. */
  allowedTools?: string[];
  /** HTTP headers to include in requests. */
  headers?: Record<string, string>;
  /** Connection timeout in milliseconds. Defaults to `5000`. */
  timeout?: number;
  /** SSE read timeout in milliseconds. Defaults to `300000` (5 minutes). */
  sseReadTimeout?: number;
}

/**
 * HTTP-based MCP server, supporting SSE and streamable HTTP transports.
 */
export class MCPServerHTTP extends MCPServer {
  readonly url: string;
  readonly transportType: MCPHTTPTransportType;
  private readonly _headers: Record<string, string>;
  private readonly _allowedTools: Set<string> | null;

  constructor(options: MCPServerHTTPOptions) {
    super(options);
    this.url = options.url;
    this._headers = options.headers ?? {};
    this._allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
    this.transportType = options.transportType ?? this._inferTransportType(options.url);
  }

  protected async createTransport(): Promise<MCPTransport> {
    const requestInit: RequestInit = {
      headers: this._headers,
    };
    const url = new URL(this.url);

    if (this.transportType === 'streamable_http') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional peer dep
        const mod: any = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        return new mod.StreamableHTTPClientTransport(url, { requestInit });
      } catch (err) {
        throw new Error(
          "Failed to load '@modelcontextprotocol/sdk/client/streamableHttp.js'. " +
            'Install with: pnpm add @modelcontextprotocol/sdk',
        );
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional peer dep
      const mod: any = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new mod.SSEClientTransport(url, { requestInit });
    } catch (err) {
      throw new Error(
        "Failed to load '@modelcontextprotocol/sdk/client/sse.js'. " +
          'Install with: pnpm add @modelcontextprotocol/sdk',
      );
    }
  }

  override async listTools(): Promise<ToolContext> {
    const all = await super.listTools();
    if (!this._allowedTools) return all;

    const filtered: ToolContext = {};
    for (const [name, t] of Object.entries(all)) {
      if (this._allowedTools.has(name)) {
        filtered[name] = t;
      }
    }
    return filtered;
  }

  private _inferTransportType(url: string): MCPHTTPTransportType {
    try {
      const path = new URL(url).pathname.toLowerCase().replace(/\/$/, '');
      return path.endsWith('/mcp') ? 'streamable_http' : 'sse';
    } catch {
      return 'sse';
    }
  }
}

export interface MCPServerStdioOptions extends MCPServerOptions {
  /** The executable to run to start the server. */
  command: string;
  /** Command line arguments. */
  args?: string[];
  /** Environment variables for the spawned process. */
  env?: Record<string, string>;
  /** Working directory for the spawned process. */
  cwd?: string;
}

/**
 * Stdio-based MCP server. Spawns a subprocess and communicates with it over
 * stdin/stdout.
 */
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

  protected async createTransport(): Promise<MCPTransport> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional peer dep
      const mod: any = await import('@modelcontextprotocol/sdk/client/stdio.js');
      return new mod.StdioClientTransport({
        command: this.command,
        args: this.args,
        env: this.env,
        cwd: this.cwd,
      });
    } catch (err) {
      throw new Error(
        "Failed to load '@modelcontextprotocol/sdk/client/stdio.js'. " +
          'Install with: pnpm add @modelcontextprotocol/sdk',
      );
    }
  }
}
