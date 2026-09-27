import type { FastifyPluginAsync } from 'fastify';
import type { Core } from '@agentry/core';
import type { PutTeamMemberRequest, TeamFromTemplateRequest } from '@agentry/shared';

/**
 * A project's team. A member is a CLI agent file plus the metadata Agentry keeps beside it; these
 * routes change the metadata and write starting files, and the file itself is edited through
 * `/config/resources/agents/:name?project=`. Validation lives in core.
 */
export const teamRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get<{ Params: { id: string } }>('/projects/:id/team', (req) => core.team.team(req.params.id));

  // Registered before `/projects/:id/team/:agent`, which would otherwise read "from-template" as an
  // agent on a PUT or DELETE
  app.post<{ Params: { id: string }; Body: TeamFromTemplateRequest }>('/projects/:id/team/from-template', (req) =>
    core.team.fromTemplate(req.params.id, req.body ?? {}),
  );

  app.put<{ Params: { id: string; agent: string }; Body: PutTeamMemberRequest }>('/projects/:id/team/:agent', (req) =>
    core.team.putMember(req.params.id, req.params.agent, req.body),
  );

  // The agent file stays on disk: taking a member off the team is not deleting its instructions
  app.delete<{ Params: { id: string; agent: string } }>('/projects/:id/team/:agent', async (req) => {
    await core.team.removeMember(req.params.id, req.params.agent);
    return { ok: true as const };
  });
};
