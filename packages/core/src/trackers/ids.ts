import type { TrackerId } from '@agentry/shared';

const IDS: Record<TrackerId, true> = { 'github-issues': true, 'gitlab-issues': true, jira: true, youtrack: true };

/** Every tracker Agentry knows, ready or not: settings and a project's tracker are validated against it. */
export const TRACKER_IDS = Object.keys(IDS) as TrackerId[];

export const isTrackerId = (value: unknown): value is TrackerId => typeof value === 'string' && (TRACKER_IDS as readonly string[]).includes(value);
