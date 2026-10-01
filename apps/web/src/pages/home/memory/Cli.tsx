import type { MemoryFile } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { BookText, ChevronRight, FileText, Folder, GitCommitVertical, Pencil } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useJournal } from '../../../api';
import { CodeEditor } from '../../../components/CodeEditor';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { formatBytes, formatNumber } from '@agentry/ui/lib/format';
import { byteSize, memoryDir, sortMemoryFiles } from './model';

/** The project's `CLAUDE.md` and the CLI's memory files: what every chat of the project reads. */
export function useCliMemory(projectId: string) {
  const scope = { projectId };
  const instructions = useQuery({ queryKey: keys.instructions(scope, 'shared'), queryFn: () => api.getInstructions(scope, 'shared') });
  const files = useQuery({ queryKey: keys.memoryFiles(projectId), queryFn: () => api.memoryFiles(projectId) });
  const list = sortMemoryFiles(files.data ?? []);
  const claudeMd = instructions.data?.exists ? instructions.data : null;
  return {
    claudeMd,
    claudeMdBytes: claudeMd ? byteSize(claudeMd.content) : 0,
    files: list,
    filesBytes: list.reduce((sum, file) => sum + byteSize(file.content), 0),
    dir: memoryDir(list),
    loading: instructions.isLoading || files.isLoading,
  };
}

type CliMemory = ReturnType<typeof useCliMemory>;

const depth = (n: number) => ({ '--depth': n }) as CSSProperties;

function FileRow({ file, href }: { file: MemoryFile; href: string }) {
  return (
    <li>
      <Link to={href} className="tree-row memory-tree-row" style={depth(1)}>
        <span className="tree-spacer" aria-hidden />
        <FileText {...ICON_SM} className="tree-icon" />
        <span className="tree-name">{file.name}</span>
        <span className="tree-size mono tnum">{formatBytes(byteSize(file.content))}</span>
      </Link>
    </li>
  );
}

/**
 * The CLI's own memory beside Agentry's: `CLAUDE.md` and the memory directory, which terminal chats
 * read too and where approved proposals are written. Each file opens in the editor.
 */
export function CliMemoryCard({ cli, editorHref }: { cli: CliMemory; editorHref: (file?: string) => string }) {
  const { t } = useTranslation('home');
  return (
    <section className="card memory-card" aria-labelledby="memory-cli-title">
      <div className="card-head">
        <h2 id="memory-cli-title">{t('memoryTab.cli.title')}</h2>
        <span className="doc-fill" />
        <Link to={editorHref()} className="link-btn small">
          {t('memoryTab.cli.openEditor')}
        </Link>
      </div>
      <p className="small muted memory-card-note">{t('memoryTab.cli.intro')}</p>
      <ul className="tree-group memory-tree" aria-label={t('memoryTab.cli.title')}>
        <li>
          <Link to={editorHref('CLAUDE.md')} className="tree-row memory-tree-row" style={depth(0)}>
            <span className="tree-spacer" aria-hidden />
            <FileText {...ICON_SM} className="tree-icon" />
            <span className="tree-name">CLAUDE.md</span>
            <span className="tree-size mono tnum">{cli.claudeMd ? formatBytes(cli.claudeMdBytes) : t('memoryTab.cli.none')}</span>
          </Link>
        </li>
        <li>
          <div className="tree-row memory-tree-row is-static" style={depth(0)}>
            <ChevronRight {...ICON_SM} className="tree-chevron is-open" />
            <Folder {...ICON_SM} className="tree-icon" />
            <span className="tree-name is-dir">memory/</span>
            <span className="tree-size mono tnum">{t('memoryTab.cli.fileCount', { count: cli.files.length, n: formatNumber(cli.files.length) })}</span>
          </div>
          <ul className="tree-group">
            {cli.files.map((file) => (
              <FileRow key={file.name} file={file} href={editorHref(file.name)} />
            ))}
          </ul>
        </li>
      </ul>
      {cli.dir && (
        <p className="mono small muted memory-card-path ellipsis" title={cli.dir}>
          {cli.dir}
        </p>
      )}
    </section>
  );
}

/** What a flow run is handed when it starts (decision 32): the three sources and their size. */
export function HandedCard({ projectId, cli }: { projectId: string; cli: CliMemory }) {
  const { t } = useTranslation('home');
  const journal = useJournal(projectId, { limit: 1 });
  const handed = journal.data?.handed;
  return (
    <section className="card memory-card" aria-labelledby="memory-handed-title">
      <div className="card-head">
        <h2 id="memory-handed-title">{t('memoryTab.handed.title')}</h2>
      </div>
      <ul className="memory-handed">
        <li>
          <FileText {...ICON} className="tree-icon" />
          <span className="doc-fill">CLAUDE.md</span>
          <span className="mono small muted tnum">{cli.claudeMd ? formatBytes(cli.claudeMdBytes) : t('memoryTab.cli.none')}</span>
        </li>
        <li>
          <BookText {...ICON} className="tree-icon" />
          <span className="doc-fill">{t('memoryTab.handed.memory')}</span>
          <span className="mono small muted tnum">
            {t('memoryTab.cli.fileCount', { count: cli.files.length, n: formatNumber(cli.files.length) })} · {formatBytes(cli.filesBytes)}
          </span>
        </li>
        <li>
          <GitCommitVertical {...ICON} className="tree-icon" />
          <span className="doc-fill">{t('memoryTab.handed.journal', { count: handed?.entries ?? 0, n: formatNumber(handed?.entries ?? 0) })}</span>
          <span className="mono small muted tnum">{formatBytes(handed?.bytes ?? 0)}</span>
        </li>
      </ul>
      <p className="small muted memory-card-note">{t('memoryTab.handed.note')}</p>
    </section>
  );
}

/** A phone's "From the CLI": the head of `CLAUDE.md` and the memory directory as cells. */
export function PhoneCli({ cli, editorHref }: { cli: CliMemory; editorHref: (file?: string) => string }) {
  const { t } = useTranslation('home');
  const head = cli.claudeMd ? cli.claudeMd.content.split('\n').slice(0, 6).join('\n') : '';
  return (
    <>
      <p className="small muted memory-phone-intro">{t('memoryTab.cli.intro')}</p>
      <div className="memory-phone-label">
        <span className="section-label doc-fill">{t('memoryTab.cli.claudeMd')}</span>
        {cli.claudeMd && <span className="mono small muted tnum">{formatBytes(cli.claudeMdBytes)}</span>}
        <Link to={editorHref('CLAUDE.md')} className="btn">
          <Pencil {...ICON_SM} />
          {t('memoryTab.cli.edit')}
        </Link>
      </div>
      {cli.claudeMd ? (
        <CodeEditor language="markdown" readOnly value={head} ariaLabel={t('memoryTab.cli.claudeMd')} minHeight="0" />
      ) : (
        <p className="small muted memory-none">{t('memoryTab.cli.noClaudeMd')}</p>
      )}
      <div className="memory-phone-label">
        <span className="section-label doc-fill">{t('memoryTab.cli.projectMemory')}</span>
        <span className="mono small muted tnum">{t('memoryTab.cli.fileCount', { count: cli.files.length, n: formatNumber(cli.files.length) })}</span>
      </div>
      <ul className="card doc-cells">
        <li>
          <Link to={editorHref()} className="doc-cell">
            <Folder {...ICON} className="tree-icon" />
            <span className="doc-cell-name">
              <span className="mono">memory/</span>
              {cli.dir && <span className="mono small muted ellipsis">{cli.dir}</span>}
            </span>
            <ChevronRight {...ICON_SM} className="doc-row-chevron" />
          </Link>
        </li>
        {cli.files.map((file) => (
          <li key={file.name}>
            <Link to={editorHref(file.name)} className="doc-cell is-nested">
              <FileText {...ICON} className="tree-icon" />
              <span className="doc-cell-name mono">{file.name}</span>
              <span className="mono small muted tnum">{formatBytes(byteSize(file.content))}</span>
              <ChevronRight {...ICON_SM} className="doc-row-chevron" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
