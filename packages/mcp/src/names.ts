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
  'list_accounts',
] as const;

export type AgentryMcpReadToolName = (typeof AGENTRY_MCP_READ_TOOL_NAMES)[number];

/** The names as the CLI sees them, which is what `--allowedTools` takes */
export const AGENTRY_MCP_READ_TOOLS: readonly string[] = AGENTRY_MCP_READ_TOOL_NAMES.map((name) => `mcp__${AGENTRY_MCP_SERVER}__${name}`);
