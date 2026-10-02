import type { TrackerManifest } from '../manifest.ts';

// Listed but not recorded: no acli capture exists yet (docs/plans/code-hosts.md, "Phase 5 in two
// steps"), so there is no release floor, no adapter and no action until the owner records it.
export const jiraManifest: TrackerManifest = {
  id: 'jira',
  label: 'Jira',
  cli: 'acli',
  host: null,
  recording: null,
};
