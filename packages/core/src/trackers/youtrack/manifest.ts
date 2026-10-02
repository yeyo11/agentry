import type { TrackerManifest } from '../manifest.ts';

// Listed but not recorded: no youtrack-app capture exists yet (docs/plans/code-hosts.md, "Phase 5
// in two steps"), so there is no release floor, no adapter and no action until the owner records it.
export const youtrackManifest: TrackerManifest = {
  id: 'youtrack',
  label: 'YouTrack',
  cli: 'youtrack-app',
  host: null,
  recording: null,
};
