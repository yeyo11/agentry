import { ApiError, type ApiClient } from './client.ts';
import { validate } from './schema.ts';
import { TOOLS, type Tool } from './tools.ts';

/** Longest tool result, in characters, before it is cut */
export const RESULT_MAX_CHARS = 50_000;

/** Newest first: the version the client asked for is used when it is in this list */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const TRUNCATION_HINT = 'The result was cut. Narrow the call: a smaller limit, one id, or a path.';

interface Request {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export interface Server {
  /** One line of the protocol in, the reply line out; undefined for a notification */
  handleLine(line: string): Promise<string | undefined>;
}

const reply = (id: Request['id'], result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Request['id'], code: number, message: string): string => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Compact JSON, cut at the cap with a marker that says so */
export function render(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  if (json.length <= RESULT_MAX_CHARS) return json;
  return `${json.slice(0, RESULT_MAX_CHARS)}…\n{"truncated":true,"hint":${JSON.stringify(TRUNCATION_HINT)}}`;
}

export function createServer(options: { api: ApiClient; version: string; tools?: readonly Tool[] }): Server {
  const tools = options.tools ?? TOOLS;
  const byName = new Map(tools.map((tool) => [tool.name as string, tool]));

  async function call(params: unknown): Promise<unknown> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    const outcome = (message: string, isError: boolean) => ({ content: [{ type: 'text', text: message }], isError });
    if (!tool) return outcome(`unknown tool: ${String(name)}`, true);
    const problem = validate(tool.inputSchema, args);
    if (problem) return outcome(`invalid arguments for ${tool.name}: ${problem}`, true);
    try {
      return outcome(render(await tool.run((args ?? {}) as Record<string, unknown>, options.api)), false);
    } catch (err) {
      if (err instanceof ApiError) return outcome(`${tool.name} failed: ${err.message}`, true);
      return outcome(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  async function handleLine(line: string): Promise<string | undefined> {
    if (!line.trim()) return undefined;
    let message: Request;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(null, -32600, 'a request is a JSON object');
      message = parsed as Request;
    } catch {
      return fail(null, -32700, 'parse error');
    }
    const { id, method } = message;
    // A notification has no id and gets no answer
    if (id === undefined) return undefined;
    switch (method) {
      case 'initialize': {
        const asked = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        return reply(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'agentry', version: options.version } });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call':
        return reply(id, await call(message.params));
      default:
        return fail(id, -32601, `method not found: ${String(method)}`);
    }
  }

  return { handleLine };
}
