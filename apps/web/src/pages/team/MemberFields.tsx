import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StringListEditor } from '../../components/editors';
import { Segmented } from '../../components/ui';
import { commandsProblem, type CommandScope, type WriteScope } from './model';

/** Where a member may write: anywhere, only the documents folder, or these paths. */
export function WritesField({
  scope,
  paths,
  onChange,
  badge,
}: {
  scope: WriteScope;
  paths: string[];
  onChange: (patch: { scope?: WriteScope; paths?: string[] }) => void;
  /** "Unsaved", which a phone shows beside the first field's label */
  badge?: ReactNode;
}) {
  const { t } = useTranslation('team');
  return (
    <div className="member-field">
      <span className="member-field-head">
        <span className="section-label">{t('member.writes')}</span>
        {badge}
      </span>
      <Segmented<WriteScope>
        label={t('member.writes')}
        value={scope}
        onChange={(next) => onChange({ scope: next })}
        options={[
          { value: 'anywhere', label: t('member.scope.anywhere') },
          { value: 'documents', label: t('member.scope.documents') },
          { value: 'paths', label: t('member.scope.paths') },
        ]}
      />
      {scope === 'paths' && (
        <div className="member-writes">
          <StringListEditor values={paths} onChange={(next) => onChange({ paths: next })} placeholder={t('member.addPath')} label={t('member.addPath')} emptyText={t('member.writesNone')} />
        </div>
      )}
      <span className="field-hint">{t(`member.scopeHint.${scope}`)}</span>
    </div>
  );
}

/**
 * The shell a member has when it works on an item: any command, none, or only these patterns, which
 * the flow hands the CLI as `Bash(<pattern>)` rules. Refining and verifying keep their own tools.
 */
export function CommandsField({
  scope,
  commands,
  onChange,
}: {
  scope: CommandScope;
  commands: string[];
  onChange: (patch: { scope?: CommandScope; commands?: string[] }) => void;
}) {
  const { t } = useTranslation('team');
  const problem = scope === 'listed' ? commandsProblem(commands) : null;
  return (
    <div className="member-field">
      <span className="member-field-head">
        <span className="section-label">{t('member.commands')}</span>
      </span>
      <Segmented<CommandScope>
        label={t('member.commands')}
        value={scope}
        onChange={(next) => onChange({ scope: next })}
        options={[
          { value: 'any', label: t('member.commandScope.any') },
          { value: 'none', label: t('member.commandScope.none') },
          { value: 'listed', label: t('member.commandScope.listed') },
        ]}
      />
      {scope === 'listed' && (
        <div className="member-writes member-commands">
          <StringListEditor
            values={commands}
            onChange={(next) => onChange({ commands: next })}
            placeholder={t('member.addCommand')}
            label={t('member.addCommand')}
            emptyText={t('member.commandsNone')}
          />
        </div>
      )}
      {problem ? (
        <span className="field-error" role="alert">
          {t(`member.commandProblem.${problem}`)}
        </span>
      ) : (
        <span className="field-hint">{t(`member.commandHint.${scope}`)}</span>
      )}
    </div>
  );
}
