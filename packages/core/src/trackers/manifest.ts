import type { CodeHostId, TrackerId } from '@agentry/shared';

/**
 * The data half of an issue tracker: what detection needs and nothing that runs. One per folder in
 * `trackers/<id>/manifest.ts`; the registry is the only place that lists them.
 */
export interface TrackerManifest {
  id: TrackerId;
  label: string;
  /** The binary the tracker is reached through */
  cli: 'gh' | 'glab' | 'acli' | 'youtrack-app';
  /**
   * The code host whose CLI, release floor and sign-in this tracker reuses, and which must be the
   * host of the project using it (`#12` on GitHub means nothing to a project that lives on GitLab).
   * Null for a tracker with a CLI of its own.
   */
  host: CodeHostId | null;
  /**
   * `host` when the CLI facts are the host's own recordings, so the release floor is the host's.
   * Null while nobody has recorded the CLI: the tracker is listed, reads `unknown` with the reason
   * `not-recorded`, and has no adapter and no action.
   */
  recording: 'host' | null;
}
