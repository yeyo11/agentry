import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { AddAccountTokenRequest, AutoSwitchSettings, SetAccountAliasRequest, SwitchAccountRequest } from '@agentry/shared';

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
};
