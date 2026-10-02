import type { TrackerManifest } from '../manifest.ts';

export const githubIssuesManifest: TrackerManifest = {
  id: 'github-issues',
  label: 'GitHub Issues',
  cli: 'gh',
  host: 'github',
  recording: 'host',
};
