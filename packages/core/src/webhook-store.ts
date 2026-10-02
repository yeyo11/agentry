import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CodeHostId, WebhookLastResponse, WebhookRegistration, WebhookState } from '@agentry/shared';

/** How long a delivery id is remembered: a host retries within hours, never within a week. */
export const WEBHOOK_DELIVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** A long-running server prunes the deliveries again after this many recorded ones. */
const PRUNE_EVERY = 200;

export interface WebhookRegistrationRow {
  id: string;
  project_id: string;
  host: string;
  hostname: string;
  repo_path: string;
  remote_hook_id: string | null;
  url: string;
  events: string;
  state: string;
  last_delivery_at: string | null;
  last_ping_at: string | null;
  last_response: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  delivery_id: string;
  registration_id: string;
  event: string;
  received_at: string;
}

/** What a registration is created with: the store sets the state, the timestamps and the empty deliveries. */
export interface NewWebhookRegistration {
  id: string;
  projectId: string;
  host: CodeHostId;
  hostname: string;
  repoPath: string;
  remoteHookId: string | null;
  url: string;
  events: string[];
}

/** The fields of a registration that change after it exists; absent ones stay as they are. */
export interface WebhookRegistrationPatch {
  remoteHookId?: string | null;
  url?: string;
  events?: string[];
  state?: WebhookState;
  lastDeliveryAt?: string | null;
  lastPingAt?: string | null;
  lastResponse?: WebhookLastResponse | null;
}

export function webhookRegistrationOf(row: WebhookRegistrationRow): WebhookRegistration {
  return {
    id: row.id,
    projectId: row.project_id,
    host: row.host as CodeHostId,
    hostname: row.hostname,
    repoPath: row.repo_path,
    remoteHookId: row.remote_hook_id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    state: row.state as WebhookState,
    lastDeliveryAt: row.last_delivery_at,
    lastPingAt: row.last_ping_at,
    lastResponse: row.last_response ? (JSON.parse(row.last_response) as WebhookLastResponse) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Forgets the delivery ids older than a week. Returns how many went. */
export function pruneWebhookDeliveries(sql: DatabaseSync, now = Date.now()): number {
  const before = new Date(now - WEBHOOK_DELIVERY_KEEP_MS).toISOString();
  return Number(sql.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').run(before).changes);
}

/**
 * The webhook tables: the hooks Agentry registered and the deliveries it has seen. The signing
 * secret is not here (it lives in a 0600 file), so no row this store returns can leak it.
 */
export class WebhookStore {
  private writes = 0;

  constructor(private readonly sql: DatabaseSync) {}

  create(input: NewWebhookRegistration, now = new Date().toISOString()): WebhookRegistration {
    this.sql
      .prepare(
        `INSERT INTO webhook_registrations (id, project_id, host, hostname, repo_path, remote_hook_id, url, events, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(input.id, input.projectId, input.host, input.hostname, input.repoPath, input.remoteHookId, input.url, JSON.stringify(input.events), now, now);
    const created = this.get(input.id);
    if (!created) throw new Error('webhook registration vanished after insert');
    return created;
  }

  get(id: string): WebhookRegistration | null {
    const row = this.sql.prepare('SELECT * FROM webhook_registrations WHERE id = ?').get(id) as WebhookRegistrationRow | undefined;
    return row ? webhookRegistrationOf(row) : null;
  }

  /** A project's registrations, oldest first. Removed ones stay listed until they are deleted. */
  list(projectId: string): WebhookRegistration[] {
    const rows = this.sql.prepare('SELECT * FROM webhook_registrations WHERE project_id = ? ORDER BY created_at, id').all(projectId) as unknown as WebhookRegistrationRow[];
    return rows.map(webhookRegistrationOf);
  }

  /** Every registration that is not removed, for the work that spans projects (re-pointing a hook). */
  listLive(): WebhookRegistration[] {
    const rows = this.sql.prepare("SELECT * FROM webhook_registrations WHERE state != 'removed' ORDER BY created_at, id").all() as unknown as WebhookRegistrationRow[];
    return rows.map(webhookRegistrationOf);
  }

  update(id: string, patch: WebhookRegistrationPatch, now = new Date().toISOString()): WebhookRegistration | null {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if ('remoteHookId' in patch) set('remote_hook_id', patch.remoteHookId ?? null);
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.events !== undefined) set('events', JSON.stringify(patch.events));
    if (patch.state !== undefined) set('state', patch.state);
    if ('lastDeliveryAt' in patch) set('last_delivery_at', patch.lastDeliveryAt ?? null);
    if ('lastPingAt' in patch) set('last_ping_at', patch.lastPingAt ?? null);
    if ('lastResponse' in patch) set('last_response', patch.lastResponse ? JSON.stringify(patch.lastResponse) : null);
    set('updated_at', now);
    this.sql.prepare(`UPDATE webhook_registrations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.get(id);
  }

  /** The registration and its delivery ids go together. False when there was no such registration. */
  delete(id: string): boolean {
    this.sql.prepare('DELETE FROM webhook_deliveries WHERE registration_id = ?').run(id);
    return Number(this.sql.prepare('DELETE FROM webhook_registrations WHERE id = ?').run(id).changes) > 0;
  }

  /**
   * Remembers a delivery id. False when it was seen already (the host's retry or a replay), which is
   * how the receiver answers it without doing the work twice.
   */
  recordDelivery(deliveryId: string, registrationId: string, event: string, now = new Date().toISOString()): boolean {
    const result = this.sql
      .prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id, registration_id, event, received_at) VALUES (?, ?, ?, ?)')
      .run(deliveryId, registrationId, event, now);
    if (++this.writes % PRUNE_EVERY === 0) this.pruneDeliveries();
    return Number(result.changes) > 0;
  }

  deliveries(registrationId: string): WebhookDeliveryRow[] {
    return this.sql.prepare('SELECT * FROM webhook_deliveries WHERE registration_id = ? ORDER BY received_at, delivery_id').all(registrationId) as unknown as WebhookDeliveryRow[];
  }

  pruneDeliveries(now = Date.now()): number {
    return pruneWebhookDeliveries(this.sql, now);
  }
}
