import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProviderCapability, RateLimitInfo } from '@agentry/shared';
import { satisfiesRange } from '../detector.ts';
import type { CapabilityConfirmation, HandshakeResult, SessionInit } from '../driver.ts';
import { rateLimitInfo } from './events.ts';
import { codexManifest } from './manifest.ts';
import { codexModelOptions } from './models.ts';
import type { AccountReadResponse, GetAccountRateLimitsResponse, InitializeResponse, ModelEntry } from './protocol/types.ts';
import { JsonRpc } from './rpc.ts';
import { versionOfUserAgent } from './session.ts';

/** What the first event of a session says about the installed CLI; the version is all that can contradict the declaration. */
export function confirmCodexInit(init: SessionInit): CapabilityConfirmation {
  const range = codexManifest.versions.range;
  // A version outside what the driver is tested against confirms nothing: the detector reports it
  if (init.version && range && satisfiesRange(init.version, range) !== 'in') return { version: init.version, confirmed: [], missing: [] };
  const confirmed: ProviderCapability[] = [];
  // No server configured is the usual case, so only a server confirms; it never contradicts
  if (codexManifest.capabilities.includes('mcp') && init.mcpServers.length > 0) confirmed.push('mcp');
  return { version: init.version, confirmed, missing: [] };
}

/** How long the detection handshake may take before it is given up. */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/** A handshake and what the account's limits read when it is signed in; `null` when it is not, or the read failed. */
export type CodexHandshakeResult = HandshakeResult & { rateLimits: RateLimitInfo | null };

/**
 * `initialize`, `account/read`, `model/list` and, signed in, `account/rateLimits/read` on a process of its own: none of them spends
 * anything (recorded), and the process ends when its stdin does. Rejects when the process cannot be
 * started or does not answer, with the reason.
 */
export function codexHandshake(bin: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CodexHandshakeResult> {
  return new Promise<CodexHandshakeResult>((resolve, reject) => {
    const proc = spawn(bin, args, { env, stdio: 'pipe' });
    const stop = () => {
      proc.stdin.end();
      proc.kill('SIGTERM');
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('codex did not complete the handshake in time'));
    }, HANDSHAKE_TIMEOUT_MS);
    const abort = () => {
      stop();
      reject(new Error('the handshake was cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    const rpc = new JsonRpc((line) => proc.stdin.write(line), {
      request: (id) => rpc.fail(id, -32601, 'Agentry answers no requests while detecting'),
      notification: () => {},
      unreadable: () => {},
    });
    createInterface({ input: proc.stdout }).on('line', (line) => rpc.line(line));
    proc.stdin.on('error', () => {});
    proc.on('error', (error) => reject(error));
    proc.on('exit', () => rpc.dispose('codex exited during the handshake'));

    void (async () => {
      try {
        const hello = await rpc.request<InitializeResponse>('initialize', {
          clientInfo: { name: 'agentry', title: 'Agentry', version: '0.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        rpc.notify('initialized');
        const account = await rpc.request<AccountReadResponse>('account/read', {});
        const list = await rpc.request<{ data?: ModelEntry[] }>('model/list', {});
        const models = codexModelOptions(list.data ?? []);
        const confirmed: ProviderCapability[] = [];
        if ((list.data ?? []).length > 0) confirmed.push('setModel');
        if ((list.data ?? []).some((m) => Array.isArray((m as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts))) confirmed.push('effort');
        const who = account.account;
        // The read costs nothing; a failure (a plan with no limits, an older server) is no reading, not a failed handshake
        const limits = who === null ? null : await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read', {}).catch(() => null);
        resolve({
          version: versionOfUserAgent(hello.userAgent),
          account: who === null ? null : who.type === 'apiKey' ? 'API key' : (who.email ?? (who.planType ? `ChatGPT ${who.planType}` : 'ChatGPT')),
          models,
          confirmed: confirmed.filter((c) => codexManifest.capabilities.includes(c)),
          rateLimits: limits?.rateLimits ? rateLimitInfo(limits.rateLimits) : null,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        stop();
      }
    })();
  });
}
