import type { PermissionDecision, PermissionUpdate } from '@agentry/shared';
import type { NeutralRequest } from '../../policy-judge.ts';
import type { PermissionQuestion } from '../driver.ts';
import type { ApprovalDecision, FileUpdateChange } from './protocol/types.ts';

/** "Allow always" for a Codex approval is an acceptance for the rest of the session. */
const SESSION_SUGGESTION: PermissionUpdate = { type: 'allowForSession' };

/** A server request that asks the client to approve something, and how each answer is written back. */
export interface Approval {
  /** What the approval is about: `acceptEdits` takes the `edit` ones without asking */
  kind: 'command' | 'edit' | 'network';
  question: Omit<PermissionQuestion, 'id'>;
  /** The result to send for a person's (or the judge's) decision */
  reply(decision: PermissionDecision): unknown;
  /** The result that ends the turn the way an interrupt does */
  cancel: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** A path as the judge reads it: relative to the project when it is inside it. */
function relative(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

const decide = (decision: PermissionDecision): ApprovalDecision => (decision.behavior === 'deny' ? 'decline' : decision.updatedPermissions?.length ? 'acceptForSession' : 'accept');

/**
 * The approvals Codex asks of a client, in neutral terms (`NeutralRequest` for the judge, a
 * `PermissionQuestion` for a person). Null for any other server request: the caller refuses it,
 * since an unanswered request would hold the turn forever.
 *
 * `changes` is what `item/started` said the file change would touch: the approval request itself
 * names no file.
 */
export function approvalFor(method: string, params: Record<string, unknown>, cwd: string, changes: ReadonlyMap<string, FileUpdateChange[]>): Approval | null {
  const toolUseId = text(params.itemId) ?? '';
  const reason = text(params.reason);
  if (method === 'item/commandExecution/requestApproval') {
    const command = text(params.command);
    const network = params.networkApprovalContext !== undefined && params.networkApprovalContext !== null;
    const request: NeutralRequest = command !== undefined ? { kind: 'command', command } : network ? { kind: 'fetch' } : { kind: 'other' };
    return {
      kind: network && command === undefined ? 'network' : 'command',
      question: {
        toolName: 'Bash',
        toolUseId,
        input: { command: command ?? '', ...(text(params.cwd) ? { cwd: params.cwd } : {}) },
        ...(reason ? { description: reason } : {}),
        suggestions: [SESSION_SUGGESTION],
        request,
      },
      reply: (decision) => ({ decision: decide(decision) }),
      cancel: { decision: 'cancel' },
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const touched = changes.get(toolUseId) ?? [];
    const paths = touched.map((c) => relative(c.path, cwd));
    return {
      kind: 'edit',
      question: {
        toolName: 'Edit',
        toolUseId,
        input: { ...(paths[0] ? { file_path: touched[0]?.path } : {}), paths },
        ...(reason ? { description: reason } : {}),
        suggestions: [SESSION_SUGGESTION],
        // Without the item no file is known: the judge asks rather than allows
        request: { kind: 'edit', ...(paths.length ? { paths } : {}) },
      },
      reply: (decision) => ({ decision: decide(decision) }),
      cancel: { decision: 'cancel' },
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const asked = (params.permissions ?? {}) as { network?: { enabled?: boolean | null } | null };
    const wantsNetwork = asked.network?.enabled === true;
    return {
      kind: 'network',
      question: {
        toolName: 'Permissions',
        toolUseId,
        input: { permissions: params.permissions ?? {} },
        ...(reason ? { description: reason } : {}),
        suggestions: [SESSION_SUGGESTION],
        // Only a network grant maps onto what the policy talks about; anything else is asked
        request: wantsNetwork ? { kind: 'fetch' } : { kind: 'other' },
      },
      reply: (decision) =>
        decision.behavior === 'deny'
          ? { permissions: {}, scope: 'turn' }
          : { permissions: { ...(wantsNetwork ? { network: { enabled: true } } : {}) }, scope: decision.updatedPermissions?.length ? 'session' : 'turn' },
      cancel: { permissions: {}, scope: 'turn' },
    };
  }
  return null;
}
