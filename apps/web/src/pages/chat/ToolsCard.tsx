import type { Chat } from '@agentry/shared';
import { useTranslation } from 'react-i18next';
import { Tag } from '../../components/ui';
import { Section } from './Side';

function RuleList({ rules }: { rules: string[] }) {
  const { t } = useTranslation('chat');
  if (rules.length === 0) return <span className="muted">{t('tools.card.none')}</span>;
  return (
    <div className="chips">
      {rules.map((rule) => (
        <span key={rule} className="chip chip-static">
          {rule}
        </span>
      ))}
    </div>
  );
}

/**
 * The tool preset and MCP servers a chat was started with: what explains a tool that was refused or
 * a server that was never there. Nothing is shown for a chat Agentry did not configure.
 */
export function ToolsCard({ chat }: { chat: Chat }) {
  const { t } = useTranslation('chat');
  const { tools } = chat;
  if (!tools) return null;
  return (
    <Section title={t('tools.card.title')}>
      <dl className="kv kv-narrow">
        <dt>{t('tools.preset')}</dt>
        <dd>{tools.preset ? <Tag tone="info">{tools.preset.name}</Tag> : <span className="muted">{t('tools.card.noPreset')}</span>}</dd>
        <dt>{t('tools.card.allowed')}</dt>
        <dd>
          <RuleList rules={tools.allowedTools} />
        </dd>
        <dt>{t('tools.card.disallowed')}</dt>
        <dd>
          <RuleList rules={tools.disallowedTools} />
        </dd>
        <dt>{t('tools.servers')}</dt>
        <dd>
          {tools.mcp ? (
            tools.mcp.servers.length > 0 ? (
              <div className="chips">
                {tools.mcp.servers.map((name) => (
                  <Tag key={name} tone="idle">
                    {name}
                  </Tag>
                ))}
              </div>
            ) : (
              <span className="muted">{t('tools.card.noServers')}</span>
            )
          ) : (
            <span className="muted">{t('tools.card.serversDefault')}</span>
          )}
        </dd>
      </dl>
      <p className="small muted">{tools.mcp ? `${t('tools.card.strictNote')} ${t('tools.card.frozenNote')}` : t('tools.card.frozenNote')}</p>
    </Section>
  );
}
