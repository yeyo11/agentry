import { useQueryClient } from '@tanstack/react-query';
import { Info, Share, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keys as queryKeys } from '../api';
import { browserPermission, enableBrowserNotifications, KINDS, setPrefs, useNotificationPrefs } from '../lib/notifications';
import { disablePush, enablePush, ensurePushConfigured, syncPush, usePushState } from '../lib/push';
import type { PushBlocker } from '../lib/push-model';
import { Switch } from './controls/Toggle';
import { ICON_SM } from './icons';
import { useToast } from './Toast';

/**
 * What a person is told when push cannot work here. Each of these is a state in which the browser's
 * push APIs are missing or inert, and a switch would be a lie: an insecure origin — how most people
 * run Agentry on a LAN — has no service worker at all, and Safari delivers a push only to an app on
 * the Home Screen. The sentence names the origin, because "not a secure origin" about an address
 * the person never chose to look at is not something anyone can act on.
 */
const BLOCKER_ICON: Record<PushBlocker, typeof Info> = {
  insecure: ShieldAlert,
  iosTab: Share,
  unsupported: Info,
  unconfigured: ShieldAlert,
  denied: ShieldAlert,
};

/**
 * The notification preferences, shown both in the bell's panel and in Settings → Notifications.
 * One store behind them, so the two are the same switches rather than two copies that drift.
 */
export function NotificationPreferences() {
  const { t } = useTranslation('components');
  const prefs = useNotificationPrefs();
  const [permission, setPermission] = useState(browserPermission);
  const push = usePushState();
  const toast = useToast();
  const queryClient = useQueryClient();

  // Whether the server has a keypair is only worth asking where the answer is shown: the route
  // makes that keypair the first time it is asked for.
  useEffect(() => void ensurePushConfigured(), []);

  const toggleBrowser = async (on: boolean) => {
    if (!on) return setPrefs((p) => ({ ...p, browser: false }));
    // Asked here, from the click, because browsers ignore a permission request made any other way
    setPermission(await enableBrowserNotifications());
  };

  const togglePush = async (on: boolean) => {
    try {
      await (on ? enablePush() : disablePush());
    } catch (err) {
      toast.error(t('push.failed'), err);
    } finally {
      setPermission(browserPermission());
      void queryClient.invalidateQueries({ queryKey: queryKeys.pushSubscriptions });
    }
  };

  const Blocked = push.blocker ? BLOCKER_ICON[push.blocker] : null;

  return (
    <div className="notif-prefs-body">
      <Switch checked={prefs.toasts} onChange={(toasts) => setPrefs((p) => ({ ...p, toasts }))}>
        {t('notificationPanel.popupToasts')}
      </Switch>
      <div>
        <Switch checked={prefs.browser && permission === 'granted'} disabled={permission === 'unsupported'} onChange={toggleBrowser}>
          {t('notificationPanel.browserNotifications')}
        </Switch>
        <div className="field-hint">{t(`notificationPanel.browserHint.${permission}`)}</div>
      </div>
      <div data-testid="push-switch">
        {push.blocker && Blocked ? (
          <p className="alert alert-warn small" role="status" data-testid={`push-blocked-${push.blocker}`}>
            <Blocked className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t(`push.blocked.${push.blocker}`, { origin: push.origin })}</span>
          </p>
        ) : (
          <>
            <Switch checked={push.enabled} disabled={push.busy || !push.ready} onChange={togglePush}>
              {t('push.label')}
            </Switch>
            <div className="field-hint">{t(push.enabled ? 'push.hintOn' : 'push.hintOff')}</div>
          </>
        )}
      </div>
      <div className="notif-prefs-group">{t('notificationPanel.notifyMeWhen')}</div>
      {KINDS.map((kind) => (
        <Switch
          key={kind}
          checked={prefs.kinds[kind]}
          onChange={(on) => {
            setPrefs((p) => ({ ...p, kinds: { ...p.kinds, [kind]: on } }));
            // The server filters by the kinds this install registered with: they travel with it
            void syncPush();
          }}
        >
          {t(`notificationPanel.kinds.${kind}`)}
        </Switch>
      ))}
    </div>
  );
}
