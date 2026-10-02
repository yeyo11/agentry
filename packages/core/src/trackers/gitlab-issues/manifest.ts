import type { TrackerManifest } from '../manifest.ts';

export const gitlabIssuesManifest: TrackerManifest = {
  id: 'gitlab-issues',
  label: 'GitLab Issues',
  cli: 'glab',
  host: 'gitlab',
  recording: 'host',
};
