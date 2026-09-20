import type { FastifyPluginAsync } from 'fastify';
import { previewCron, type Core } from '@agentry/core';
import type { CreateScheduleRequest, UpdateScheduleRequest } from '@agentry/shared';

/** Recurring chats and orchestrations. The definitions are JSON, the history is rows. */
export const scheduleRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  const { schedules } = core;

  app.get('/schedules', () => schedules.list());

  // What an expression will do, for a form to show while it is typed. Registered ahead of
  // `/schedules/:id`, which would otherwise take "preview" for an id.
  app.get<{ Querystring: { cron?: string; timezone?: string; count?: string } }>('/schedules/preview', (req) => {
    const count = Number(req.query.count);
    return previewCron(req.query.cron ?? '', req.query.timezone || undefined, Number.isFinite(count) && count > 0 ? count : undefined);
  });

  app.post<{ Body: CreateScheduleRequest }>('/schedules', async (req, reply) =>
    reply.status(201).send(await schedules.create(req.body ?? ({} as CreateScheduleRequest))),
  );

  app.get<{ Params: { id: string } }>('/schedules/:id', (req) => schedules.get(req.params.id));

  // Also how a schedule is switched on and off: `{ "enabled": false }`
  app.patch<{ Params: { id: string }; Body: UpdateScheduleRequest }>('/schedules/:id', (req) => schedules.update(req.params.id, req.body ?? {}));

  app.delete<{ Params: { id: string } }>('/schedules/:id', async (req) => {
    await schedules.remove(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/schedules/:id/enable', (req) => schedules.update(req.params.id, { enabled: true }));
  app.post<{ Params: { id: string } }>('/schedules/:id/disable', (req) => schedules.update(req.params.id, { enabled: false }));

  // Starts the target now, whatever the timetable says. The run it records has no slot.
  app.post<{ Params: { id: string } }>('/schedules/:id/run', async (req, reply) => reply.status(201).send(await schedules.runNow(req.params.id)));

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/schedules/:id/runs', (req) => {
    const limit = Number(req.query.limit);
    return schedules.history(req.params.id, Number.isFinite(limit) && limit > 0 ? limit : undefined);
  });
};
