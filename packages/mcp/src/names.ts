/**
 * The tools of Agentry's own MCP server, by name. A file of its own, with no import, so the core can
 * build an allow list from it without loading the server: a test checks the catalogue in tools.ts
 * against this list, which keeps the two the same.
 */
export const AGENTRY_MCP_SERVER = 'agentry';

export const AGENTRY_MCP_READ_TOOL_NAMES = [
  'list_projects',
  'get_overview',
  'get_board',
  'get_work_item',
  'list_orchestrations',
  'get_orchestration',
  'get_team',
  'list_flow_runs',
  'get_journal',
  'list_documents',
  'read_document',
  'list_chats',
  'get_chat',
  'get_usage',
  'list_providers',
] as const;

export type AgentryMcpReadToolName = (typeof AGENTRY_MCP_READ_TOOL_NAMES)[number];

/** The names as the CLI sees them, which is what `--allowedTools` takes */
export const AGENTRY_MCP_READ_TOOLS: readonly string[] = AGENTRY_MCP_READ_TOOL_NAMES.map((name) => `mcp__${AGENTRY_MCP_SERVER}__${name}`);

/**
 * The tools that change something. None is ever in `--allowedTools`: each call reaches the person as
 * a permission prompt in the chat, and a call nobody confirms never reaches the API.
 */
export const AGENTRY_MCP_WRITE_TOOL_NAMES = [
  'create_work_item',
  'update_work_item',
  'move_work_item',
  'comment_work_item',
  'retry_flow_run',
  'retry_orchestration_task',
  'start_chat',
  'accept_assistant_proposal',
  'discard_assistant_proposal',
] as const;

export type AgentryMcpWriteToolName = (typeof AGENTRY_MCP_WRITE_TOOL_NAMES)[number];
export type AgentryMcpToolName = AgentryMcpReadToolName | AgentryMcpWriteToolName;

export const AGENTRY_MCP_WRITE_TOOLS: readonly string[] = AGENTRY_MCP_WRITE_TOOL_NAMES.map((name) => `mcp__${AGENTRY_MCP_SERVER}__${name}`);

/** Whether the CLI's name for a tool is one of Agentry's write tools */
export const isAgentryMcpWriteTool = (toolName: string): boolean => AGENTRY_MCP_WRITE_TOOLS.includes(toolName);
