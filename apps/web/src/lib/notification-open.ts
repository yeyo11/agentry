/**
 * The service worker opens a notification with `notification=<key>` on the address. The page tells
 * the server once that the push was opened (`notification.urgency`'s signal) and takes the
 * parameter off, so a reload or a shared link does not report it again.
 */
export const NOTIFICATION_PARAM = 'notification';

export interface NotificationOpen {
  /** The push key, null when the address carries none */
  key: string | null;
  /** The same query without the parameter, as `?a=b` or an empty string */
  search: string;
}

export function takeNotificationParam(search: string): NotificationOpen {
  const params = new URLSearchParams(search);
  const key = params.get(NOTIFICATION_PARAM);
  if (key === null) return { key: null, search };
  params.delete(NOTIFICATION_PARAM);
  const rest = params.toString();
  return { key: key === '' ? null : key, search: rest ? `?${rest}` : '' };
}
