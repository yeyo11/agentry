import { Code2, SquareArrowOutUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { diffCommand, editorLink, joinPath, useEditorSettings } from '../../lib/editor';
import { ICON_SM } from '../icons';
import { CopyButton } from '../ui';

/*
 * Links into the person's own editor. They are plain anchors to whatever the template builds
 * (`vscode://file/…` by default), so a browser hands them to the OS; nothing is opened by Agentry.
 */

/** Opens a file, or a directory when there is no file, in the editor. Says nothing when the template is unusable. */
export function EditorLink({ dir, file, line, label }: { dir: string; file?: string; line?: number; label: string }) {
  const settings = useEditorSettings();
  const href = editorLink(settings, file ? joinPath(dir, file) : dir, line);
  if (!href) return null;
  return (
    <a className="icon-btn" href={href} aria-label={label} title={label}>
      <SquareArrowOutUpRight {...ICON_SM} />
    </a>
  );
}

/** The whole worktree, as a labelled button: the link a person reaches for first. */
export function OpenWorktree({ dir }: { dir: string }) {
  const { t } = useTranslation('observe');
  const settings = useEditorSettings();
  const href = editorLink(settings, dir);
  if (!href) return null;
  return (
    <a className="btn btn-small" href={href}>
      <Code2 {...ICON_SM} /> {t('editor.openWorktree')}
    </a>
  );
}

/**
 * A side-by-side diff needs two files on disk: the worktree's and the main checkout's. A browser
 * cannot start `code --diff`, so the button copies the command for the person's terminal.
 */
export function DiffCommandButton({ left, right }: { left: string; right: string }) {
  const { t } = useTranslation('observe');
  const settings = useEditorSettings();
  const command = diffCommand(settings, left, right);
  if (!command) return null;
  return <CopyButton text={command} label={t('editor.copyDiffCommand')} />;
}
