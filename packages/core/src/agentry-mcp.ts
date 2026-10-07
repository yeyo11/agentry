import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTRY_MCP_READ_TOOLS, AGENTRY_MCP_SERVER } from '@agentry/mcp';
import type { ChatToolConfig, McpSelection, PermissionMode } from '@agentry/shared';
import { writeMcpConfigSync } from './chat-tools.ts';
import type { ChatConfinement } from './live-chat.ts';

/** The absolute path of the bundled `mcp.mjs`. The API bundle and the desktop app set it; from source it is unset. */
export const MCP_ENTRY_ENV = 'AGENTRY_MCP_ENTRY';

/** What a caller spreads into the options of a chat to hand it Agentry's own MCP server and nothing else. */
export interface AgentryMcpLaunch {
  /** `--mcp-config` (with `--strict-mcp-config`): a file holding only the `agentry` server */
  mcp: McpSelection & { config: string };
  /** `--allowedTools`: the read tools, by the names the CLI gives them */
  allowedTools: string[];
  /** `--tools=` and `--setting-sources=`, both empty: no built-in tool, no settings file */
  confine: ChatConfinement;
  /** Whatever is not allowed is denied, not prompted */
  permissionMode: PermissionMode;
}

export interface AgentryMcpOptions {
  dataDir: string;
  /** `AGENTRY_API_URL` of the wrapper that runs the chat; null while the API is not listening */
  apiUrl: string | null;
  /** The version the server reports, so a client can tell which Agentry it talks to */
  version: string;
  env?: NodeJS.ProcessEnv;
  /** The binary that runs the server: Node, or the Electron binary acting as Node */
  execPath?: string;
}

/**
 * How the CLI starts the server, in each of the three runtimes: the bundled file when the runtime
 * handed one over (`AGENTRY_MCP_ENTRY`: the API bundle and the desktop app), else the source file
 * through `tsx`. Throws rather than return a command the CLI could not start.
 */
export function mcpCommand(env: NodeJS.ProcessEnv, execPath: string): { command: string; args: string[] } {
  const bundled = env[MCP_ENTRY_ENV];
  if (bundled) {
    if (!existsSync(bundled)) throw new Error(`Agentry's MCP server is not at ${bundled} (${MCP_ENTRY_ENV})`);
    return { command: execPath, args: [bundled] };
  }
  const source = fileURLToPath(new URL('../../mcp/src/main.ts', import.meta.url));
  if (existsSync(source)) {
    try {
      // tsx is the mcp package's own dev dependency: resolved from the file it runs, not from the chat's directory
      const tsx = join(dirname(createRequire(source).resolve('tsx/package.json')), 'dist', 'loader.mjs');
      return { command: execPath, args: ['--import', pathToFileURL(tsx).href, source] };
    } catch {
      // falls through to the error below
    }
  }
  throw new Error(`Agentry's MCP server cannot be started: ${MCP_ENTRY_ENV} is not set and the source is not runnable here`);
}

/**
 * Writes the config file of Agentry's own MCP server and the flags that confine a chat to its read
 * tools. The CLI starts the server; this never talks to it.
 *
 * The file is the same for every chat. It holds the URL, which is the bound address of this wrapper,
 * and refers to the chat's id and token by `${NAME}`, which the CLI expands from the environment of
 * the process it starts: both are only known once the process spawns (the token is minted per
 * process), and referring to them keeps the secret out of the file. Checked against the real CLI:
 * it expands them, and passes the rest of its environment through as well.
 */
export async function agentryMcp(opts: AgentryMcpOptions): Promise<AgentryMcpLaunch> {
  return agentryMcpSync(opts);
}

/** `agentryMcp` for a caller that cannot wait: a process about to spawn. */
export function agentryMcpSync(opts: AgentryMcpOptions): AgentryMcpLaunch {
  if (!opts.apiUrl) throw new Error("Agentry's MCP server needs the API's address, and the API is not listening yet");
  const env = opts.env ?? process.env;
  const { command, args } = mcpCommand(env, opts.execPath ?? process.execPath);
  const config = writeMcpConfigSync(opts.dataDir, {
    [AGENTRY_MCP_SERVER]: {
      command,
      args,
      env: {
        AGENTRY_API_URL: opts.apiUrl,
        AGENTRY_CHAT_ID: '${AGENTRY_CHAT_ID}',
        AGENTRY_API_TOKEN: '${AGENTRY_API_TOKEN}',
        AGENTRY_VERSION: opts.version,
        // The desktop's Electron binary runs the bundle as Node only with this
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    },
  });
  return {
    mcp: { servers: [AGENTRY_MCP_SERVER], config },
    allowedTools: [...AGENTRY_MCP_READ_TOOLS],
    confine: { tools: [], settingSources: [] },
    permissionMode: 'dontAsk',
  };
}

/**
 * What an Agentry assistant chat runs with, whoever asked for what. This is the one place its argv
 * is decided: the core applies it again at every process of the chat (start, resume, fork, a turn
 * after a restart), over whatever the request or the stored record held. The write tools extend
 * this function, and nothing else.
 */
export interface AssistantChatOptions {
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  toolConfig: ChatToolConfig;
  mcp: AgentryMcpLaunch['mcp'];
  confine: ChatConfinement;
  permissionMode: PermissionMode;
  permissionPrompts: 'none' | 'host';
  /** No uploads directory: the chat reads nothing the person attached to other chats */
  uploads: false;
  keepAlive: true;
}

export function assistantChatOptions(launch: AgentryMcpLaunch, guide: string): AssistantChatOptions {
  return {
    appendSystemPrompt: guide,
    allowedTools: launch.allowedTools,
    disallowedTools: [],
    toolConfig: { preset: null, allowedTools: launch.allowedTools, disallowedTools: [], mcp: launch.mcp },
    mcp: launch.mcp,
    confine: launch.confine,
    // Read tools under dontAsk: whatever is not allowed is denied, and nothing can bypass it
    permissionMode: launch.permissionMode,
    permissionPrompts: 'none',
    uploads: false,
    keepAlive: true,
  };
}
