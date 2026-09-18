import type { PermissionRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ShieldQuestion, X } from 'lucide-react';
import { useState } from 'react';
import { api, keys } from '../api';
import { ICON_SM } from './icons';
import { ErrorBox } from './ui';

/** The shell command, the file, the url — whatever this particular tool is actually about. */
function summarize(request: PermissionRequest): string {
  const input = request.input;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return JSON.stringify(input);
}

function Prompt({ request }: { request: PermissionRequest }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const answer = useMutation({
    mutationFn: (decision: { behavior: 'allow' | 'deny' }) =>
      api.answerPermission(request.runId, request.id, {
        behavior: decision.behavior,
        ...(decision.behavior === 'deny' && reason.trim() ? { message: reason.trim() } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.runPermissions(request.runId) }),
  });

  return (
    <li className="permission" aria-live="polite">
      <div className="permission-head">
        <ShieldQuestion {...ICON_SM} aria-hidden />
        <strong>{request.toolName}</strong>
        <span className="muted small">wants to run</span>
      </div>
      <pre className="permission-input">{summarize(request)}</pre>
      {typeof request.input.description === 'string' && <p className="muted small">{request.input.description}</p>}
      <div className="permission-actions">
        <button
          type="button"
          className="btn btn-primary btn-small"
          disabled={answer.isPending}
          onClick={() => answer.mutate({ behavior: 'allow' })}
        >
          <Check {...ICON_SM} /> Allow
        </button>
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={answer.isPending}
          onClick={() => answer.mutate({ behavior: 'deny' })}
        >
          <X {...ICON_SM} /> Deny
        </button>
        {/* A denial the model can learn from beats one it can only retry blindly */}
        <input
          className="permission-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why not? (sent to the model when denying)"
          disabled={answer.isPending}
        />
      </div>
      <ErrorBox error={answer.error} />
    </li>
  );
}

/**
 * Tool calls the run is holding until someone decides. Polled rather than streamed: a request that
 * arrives while the page is closed must still be waiting when it opens, and the run's event stream
 * only carries the notice that one appeared.
 */
export function PermissionPrompts({ runId, live }: { runId: string; live: boolean }) {
  const { data } = useQuery({
    queryKey: keys.runPermissions(runId),
    queryFn: () => api.runPermissions(runId),
    refetchInterval: live ? 2000 : false,
  });
  if (!data?.length) return null;
  return (
    <section className="permission-list" aria-label="Permission requests">
      <ul>
        {data.map((request) => (
          <Prompt key={request.id} request={request} />
        ))}
      </ul>
    </section>
  );
}
