import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useTeam } from '../../api';
import { useRoleName } from '../../pages/team/RoleAvatar';

/**
 * The Team tab's crumbs: "Equipo", and below it "Equipo / Flujo", "Equipo / Actividad" or
 * "Equipo / Desarrollador", with Equipo leading back, as the flow's, the activity's and the member's
 * references draw them.
 */
export function TeamCrumbs({ projectId, search }: { projectId: string; search: string }) {
  const { t } = useTranslation(['home', 'team']);
  const roleName = useRoleName();
  const params = new URLSearchParams(search);
  const agent = params.get('member');
  const section = params.get('section');
  const view = section === 'flow' ? t('team:flow.title') : section === 'activity' ? t('team:log.title') : null;
  const members = useTeam(agent ? projectId : null).data?.members;
  if (!agent && !view) return <span className="crumb-page ellipsis">{t('home:tabs.team')}</span>;
  const role = agent ? (members?.find((m) => m.agent === agent)?.role ?? agent) : null;
  return (
    <>
      <Link to={`/?${new URLSearchParams({ project: projectId, view: 'team' }).toString()}`} className="crumb-page muted ellipsis">
        {t('home:tabs.team')}
      </Link>
      <span className="crumb-sep" aria-hidden>
        /
      </span>
      <span className="crumb-page ellipsis">{role ? roleName(role) : view}</span>
    </>
  );
}
