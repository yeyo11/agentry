import { createReadStream, existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  entryText,
  normalizeMessage,
  type ProjectSummary,
  type SessionDetail,
  type SessionSummary,
  type TranscriptEntry,
} from '@agentry/shared';
import type { CoreConfig } from './paths.ts';

/** The slash command inside a synthetic user message, e.g. `<command-name>/resume</command-name>`. */
const COMMAND_RE = /<command-name>\s*([^<]+)<\/command-name>/;

interface CacheItem {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // half-written line from a live session
    }
  }
}

export function isTemporaryPath(path: string): boolean {
  const tmp = tmpdir();
  return path === tmp || path.startsWith(`${tmp}/`) || path.startsWith('/tmp/') || path.startsWith('/var/tmp/');
}

/** Reads projects and sessions from ~/.claude/projects (.jsonl transcripts written by the CLI). */
export class SessionStore {
  private readonly cache = new Map<string, CacheItem>();

  constructor(private readonly config: CoreConfig) {}

  private async projectDirs(): Promise<string[]> {
    if (!existsSync(this.config.projectsDir)) return [];
    const entries = await readdir(this.config.projectsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  private async summarize(projectId: string, file: string): Promise<SessionSummary | null> {
    const info = await stat(file).catch(() => null);
    if (!info) return null;
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;

    const summary: SessionSummary = {
      id: basename(file, '.jsonl'),
      projectId,
      projectPath: '',
      title: '',
      firstPrompt: null,
      messageCount: 0,
      startedAt: null,
      updatedAt: null,
      model: null,
      gitBranch: null,
      cliVersion: null,
      sizeBytes: info.size,
      origin: { kind: 'cli' }, // refined by Core, which knows the wrapper's runs
    };
    let customTitle: string | null = null;
    let command: string | undefined;

    for await (const o of readJsonl(file)) {
      if (typeof o.timestamp === 'string') {
        summary.startedAt ??= o.timestamp;
        summary.updatedAt = o.timestamp;
      }
      if (!summary.projectPath && typeof o.cwd === 'string') summary.projectPath = o.cwd;
      if (typeof o.gitBranch === 'string') summary.gitBranch = o.gitBranch;
      if (typeof o.version === 'string') summary.cliVersion = o.version;
      if (o.type === 'summary' && typeof o.summary === 'string') customTitle = o.summary;
      if (o.type === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;

      const entry = normalizeMessage(o);
      if (!entry || entry.isSidechain) continue;
      summary.messageCount++;
      if (entry.model) summary.model = entry.model;
      if (!summary.firstPrompt && entry.role === 'user') {
        const text = entryText(entry).trim();
        // Skip synthetic messages (<command-name>, <system-reminder>, …)
        if (text && !text.startsWith('<')) summary.firstPrompt = text.slice(0, 300);
        // …but remember the command, the only readable thing a session nobody typed in ever has
        else command ??= COMMAND_RE.exec(text)?.[1]?.trim();
      }
    }
    if (summary.messageCount === 0) return null;
    // A session with no user turn (the spare `claude attach` pre-warms) would otherwise be
    // titled with its own uuid, which reads like an id and tells nobody what it is.
    summary.title = customTitle ?? summary.firstPrompt?.split('\n')[0]?.slice(0, 100) ?? command ?? summary.id;
    summary.updatedAt ??= info.mtime.toISOString();
    this.cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, summary });
    return summary;
  }

  async listSessions(projectId?: string): Promise<SessionSummary[]> {
    const dirs = projectId ? [projectId] : await this.projectDirs();
    const all: SessionSummary[] = [];
    for (const dir of dirs) {
      const full = join(this.config.projectsDir, dir);
      const files = await readdir(full).catch(() => [] as string[]);
      const summaries = await Promise.all(
        files.filter((f) => f.endsWith('.jsonl')).map((f) => this.summarize(dir, join(full, f))),
      );
      for (const s of summaries) if (s) all.push(s);
    }
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const sessions = await this.listSessions();
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId) ?? [];
      list.push(s);
      byProject.set(s.projectId, list);
    }
    const projects: ProjectSummary[] = [];
    for (const [id, list] of byProject) {
      const path = list.find((s) => s.projectPath)?.projectPath ?? id;
      projects.push({
        id,
        path,
        name: basename(path) || path,
        sessionCount: list.length,
        lastActivity: list[0]?.updatedAt ?? null,
        activeRuns: 0,
        temporary: isTemporaryPath(path),
        exists: existsSync(path),
      });
    }
    return projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  }

  private async findFile(sessionId: string): Promise<{ projectId: string; file: string } | null> {
    if (!/^[\w-]+$/.test(sessionId)) return null;
    for (const dir of await this.projectDirs()) {
      const file = join(this.config.projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return { projectId: dir, file };
    }
    return null;
  }

  /** The cached summary of one session, without reading its transcript. */
  async summary(sessionId: string): Promise<SessionSummary | null> {
    const found = await this.findFile(sessionId);
    return found ? this.summarize(found.projectId, found.file) : null;
  }

  /** Deletes the transcript and the session's sidecar directory (subagent transcripts, tool results). */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findFile(sessionId);
    if (!found) throw new Error('session not found');
    await rm(found.file);
    await rm(found.file.slice(0, -'.jsonl'.length), { recursive: true, force: true });
    this.cache.delete(found.file);
  }

  async getSession(sessionId: string, opts: { includeSidechains?: boolean } = {}): Promise<SessionDetail | null> {
    const found = await this.findFile(sessionId);
    if (!found) return null;
    const summary = await this.summarize(found.projectId, found.file);
    if (!summary) return null;
    const entries: TranscriptEntry[] = [];
    for await (const o of readJsonl(found.file)) {
      const entry = normalizeMessage(o);
      if (!entry) continue;
      if (entry.isSidechain && !opts.includeSidechains) continue;
      entries.push(entry);
    }
    return { summary, entries };
  }
}
