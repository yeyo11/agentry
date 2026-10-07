import type { TrackerManifest } from '../manifest.ts';

// youtrack-app 1.0.3 was recorded against YouTrack 2026.2 on 2026-10-07
// (test/fixtures/recordings/youtrack-app/NOTES.md), so it is the release floor. The instance and the
// token are Agentry's to keep (code hosts decision 3); the CLI is the person's to install.
export const youtrackManifest: TrackerManifest = {
  id: 'youtrack',
  label: 'YouTrack',
  cli: 'youtrack-app',
  host: null,
  recording: 'own',
  minimum: '1.0.3',
  recorded: ['1.0.3'],
};
