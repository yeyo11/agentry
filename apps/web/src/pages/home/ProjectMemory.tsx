import type { Project } from '@agentry/shared';
import { ChevronLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Segmented } from '@agentry/ui/components/ui';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { InstructionsTab } from '../config/InstructionsTab';
import { CliMemoryCard, HandedCard, PhoneCli, useCliMemory } from './memory/Cli';
import { MemoryFiles } from './memory/Files';
import { AddJournalDialog, Journal } from './memory/Journal';
import { Proposals, usePendingProposalCount } from './memory/Proposals';

/** The Memory tab's parts, each at `?section=`: a phone's three tabs, and the CLI's files in the editor. */
const PHONE_SECTIONS = ['proposals', 'journal', 'cli'] as const;
type PhoneSection = (typeof PHONE_SECTIONS)[number];
const EDITOR = 'files';

/** Links inside the tab keep the project and the view, and change only the section and the file. */
function useSectionHref() {
  const [params] = useSearchParams();
  return (section: string | null, file?: string) => {
    const next = new URLSearchParams(params);
    if (section) next.set('section', section);
    else next.delete('section');
    if (file) next.set('file', file);
    else next.delete('file');
    return `/?${next.toString()}`;
  };
}

/**
 * The CLI's own files in the editor: `CLAUDE.md` (the config page's editor, scoped to the project)
 * and the memory directory (list and editor), opened on the file the tab linked to.
 */
function CliEditor({ project, file }: { project: Project; file: string | null }) {
  const { t } = useTranslation('home');
  const href = useSectionHref();
  return (
    <div className="memory-editor">
      <Link to={href(null)} className="link-btn memory-editor-back">
        <ChevronLeft {...ICON_SM} />
        {t('memoryTab.cli.back')}
      </Link>
      {file === 'CLAUDE.md' ? (
        <InstructionsTab scope={{ projectId: project.id }} scopeKey={project.id} />
      ) : (
        <>
          <MemoryFiles key={project.id} projectId={project.id} initial={file} />
          <InstructionsTab scope={{ projectId: project.id }} scopeKey={project.id} />
        </>
      )}
    </div>
  );
}

/**
 * The Memory tab (decisions 32 and 33): what the team shares. Proposals the roles made wait for
 * the person, one by one; the project journal records decisions and closed items; the CLI's own
 * memory is what terminal chats read too. A phone shows the three as tabs of one screen.
 */
export function ProjectMemory({ project }: { project: Project }) {
  const { t } = useTranslation('home');
  const narrow = useMediaQuery(NARROW);
  const [params, setParams] = useSearchParams();
  const href = useSectionHref();
  const cli = useCliMemory(project.id);
  const [adding, setAdding] = useState(false);
  const section = params.get('section');
  const pending = usePendingProposalCount(project.id);

  if (section === EDITOR) return <CliEditor key={project.id} project={project} file={params.get('file')} />;

  const editorHref = (file?: string) => href(EDITOR, file);
  const dialog = adding && <AddJournalDialog projectId={project.id} onClose={() => setAdding(false)} />;

  if (narrow) {
    const current: PhoneSection = PHONE_SECTIONS.find((s) => s === section) ?? 'proposals';
    return (
      <div className="memory-phone">
        <Segmented<PhoneSection>
          label={t('memoryTab.sections')}
          value={current}
          onChange={(next) =>
            setParams(
              (old) => {
                const query = new URLSearchParams(old);
                query.set('section', next);
                return query;
              },
              { replace: true },
            )
          }
          options={[
            {
              value: 'proposals',
              label: (
                <>
                  {t('memoryTab.proposals.tab')}
                  {pending > 0 && <span className="segment-count memory-count">{pending}</span>}
                </>
              ),
            },
            { value: 'journal', label: t('memoryTab.journal.tab') },
            { value: 'cli', label: t('memoryTab.cli.tab') },
          ]}
        />
        {current === 'proposals' && <Proposals projectId={project.id} phone />}
        {current === 'journal' && (
          <>
            <Journal projectId={project.id} phone />
            <button type="button" className="btn btn-block" onClick={() => setAdding(true)}>
              <Plus {...ICON_SM} />
              {t('memoryTab.journal.addButton')}
            </button>
          </>
        )}
        {current === 'cli' && <PhoneCli cli={cli} editorHref={editorHref} />}
        {dialog}
      </div>
    );
  }

  return (
    <div className="memory-tab">
      <div className="memory-intro">
        <p className="small muted doc-fill">
          <Trans t={t} i18nKey="memoryTab.intro" components={{ mono: <span className="mono" /> }} />
        </p>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Plus {...ICON_SM} />
          {t('memoryTab.journal.addButton')}
        </button>
      </div>
      <div className="memory-grid">
        <div className="memory-col">
          <Proposals projectId={project.id} />
          <Journal projectId={project.id} />
        </div>
        <div className="memory-col">
          <CliMemoryCard cli={cli} editorHref={editorHref} />
          <HandedCard projectId={project.id} cli={cli} />
        </div>
      </div>
      {dialog}
    </div>
  );
}
