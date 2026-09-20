import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type {
  AddAccountTokenRequest,
  AutoSwitchSettings,
  RotationPolicyRequest,
  SetAccountAliasRequest,
  SwitchAccountRequest,
  UpdateAccountConfigRequest,
  UsageWindowKind,
} from '@agentry/shared';

/**
 * Multi-account support, delegated to claude-swap (`cswap`): it owns the credentials, the usage
 * polling and the rotation policy. Every route degrades to `cswap.installed === false`.
 */
export const accountRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Querystring: { refresh?: string } }>('/accounts', (req) => core.accountsOverview(req.query.refresh === '1'));

  app.post<{ Body: SwitchAccountRequest }>('/accounts/switch', async (req) => {
    const { target, strategy } = req.body ?? {};
    return core.accounts.switch(target, strategy);
  });

  // The token arrives in the body and is handed to `cswap add-token` over stdin; it is never returned.
  app.post<{ Body: AddAccountTokenRequest }>('/accounts/token', async (req, reply) => {
    const { token, slot, email } = req.body ?? ({} as AddAccountTokenRequest);
    await core.accounts.addToken(token, { slot, email });
    return reply.status(201).send(await core.accountsOverview(true));
  });

  app.delete<{ Params: { number: string } }>('/accounts/:number', async (req) => {
    await core.accounts.remove(req.params.number);
    return { ok: true };
  });

  app.post<{ Params: { number: string } }>('/accounts/:number/enable', async (req) => {
    await core.accounts.enable(req.params.number);
    return { ok: true };
  });

  app.post<{ Params: { number: string } }>('/accounts/:number/disable', async (req) => {
    await core.accounts.disable(req.params.number);
    return { ok: true };
  });

  app.put<{ Params: { number: string }; Body: SetAccountAliasRequest }>('/accounts/:number/alias', async (req) => {
    await core.accounts.setAlias(req.params.number, req.body?.alias ?? null);
    return { ok: true };
  });

  // Rotation history outlives the process, so "the account changed on its own" stays diagnosable
  // after a restart — `GET /accounts` only carries the most recent window of it.
  app.get<{ Querystring: { limit?: string; since?: string } }>('/accounts/events', (req) => {
    const limit = Number(req.query.limit);
    return core.accounts.history({
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(req.query.since ? { since: req.query.since } : {}),
    });
  });

  app.get('/accounts/autoswitch', () => core.accounts.autoSwitch);

  app.put<{ Body: Partial<AutoSwitchSettings> }>('/accounts/autoswitch', (req) => core.accounts.setAutoSwitch(req.body ?? {}));

  // A config directory is opt-in per account and undone by sending null: nothing is moved, only
  // the symlinks Agentry made are taken away again.
  app.put<{ Params: { number: string }; Body: UpdateAccountConfigRequest }>('/accounts/:number/config', async (req) => {
    const body = req.body;
    if (!body || (typeof body.configDir !== 'string' && body.configDir !== null)) throw new Error('configDir must be a path or null');
    const config = await core.accounts.setConfig(req.params.number, body);
    return config ?? { number: Number(req.params.number), configDir: null, links: [] };
  });

  app.get('/accounts/policies', () => core.accounts.configs.policies());

  app.post<{ Body: RotationPolicyRequest }>('/accounts/policies', async (req, reply) => reply.status(201).send(await core.accounts.configs.createPolicy(req.body)));

  app.put<{ Params: { id: string }; Body: RotationPolicyRequest }>('/accounts/policies/:id', (req) => core.accounts.configs.updatePolicy(req.params.id, req.body));

  app.delete<{ Params: { id: string } }>('/accounts/policies/:id', async (req) => {
    await core.accounts.configs.deletePolicy(req.params.id);
    return { ok: true };
  });

  // The readings behind the usage chart, oldest first
  app.get<{ Querystring: { account?: string; window?: string; since?: string; until?: string; limit?: string } }>('/accounts/usage', (req) => {
    const { account, window, since, until, limit } = req.query;
    if (window !== undefined && window !== '5h' && window !== '7d') throw new Error("window must be '5h' or '7d'");
    const number = account === undefined ? undefined : Number(account);
    if (number !== undefined && !Number.isInteger(number)) throw new Error('account must be a slot number');
    const max = limit === undefined ? undefined : Number(limit);
    return core.accounts.usageHistory({
      ...(number !== undefined ? { account: number } : {}),
      ...(window ? { window: window as UsageWindowKind } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(max !== undefined && Number.isFinite(max) ? { limit: max } : {}),
    });
  });
};
