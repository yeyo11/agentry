// MCP stdio server the CLI spawns to ask whether a tool call may proceed (--permission-prompt-tool).
//
// It owns no policy: it forwards the request to the wrapper over a unix socket and returns whatever
// a person decided. The CLI swallows this process's stderr, so nothing is logged here — a failure
// has to surface as a denial with a reason the model can read.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const SOCKET = process.env.AGENTRY_PERMISSION_SOCKET;
const RUN_ID = process.env.AGENTRY_RUN_ID ?? '';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const result = (id, payload) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });

const TOOL = {
  name: 'approve',
  description:
    'Ask the person running Agentry whether this tool call may proceed. Returns allow or deny.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Tool the model wants to use' },
      input: { type: 'object', description: 'Arguments it would be called with' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name'],
    additionalProperties: true,
  },
};

/** One request, one connection: the wrapper answers when a person does, which may take minutes. */
function askWrapper(payload) {
  return new Promise((resolve) => {
    if (!SOCKET) return resolve({ behavior: 'deny', message: 'Agentry is not listening for permission requests' });
    const socket = connect(SOCKET);
    let buffer = '';
    const fail = (message) => resolve({ behavior: 'deny', message });
    socket.on('error', () => fail('could not reach Agentry to ask for permission'));
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const line = buffer.indexOf('\n');
      if (line === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, line)));
      } catch {
        fail('Agentry returned an unreadable decision');
      }
      socket.end();
    });
    socket.on('close', () => fail('Agentry closed the connection before deciding'));
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentry-permissions', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } });
  } else if (msg.method === 'tools/call') {
    const args = msg.params?.arguments ?? {};
    void askWrapper({
      runId: RUN_ID,
      toolName: args.tool_name ?? msg.params?.name ?? 'unknown',
      toolUseId: args.tool_use_id ?? msg.params?._meta?.['claudecode/toolUseId'] ?? '',
      input: args.input ?? {},
    }).then((decision) => {
      // The CLI reads `behavior`; `updatedInput` is required when allowing.
      if (decision.behavior === 'allow') result(msg.id, { behavior: 'allow', updatedInput: decision.updatedInput ?? args.input ?? {} });
      else result(msg.id, { behavior: 'deny', message: decision.message ?? 'denied' });
    });
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
