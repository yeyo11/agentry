import type { PushSubscriptionSummary } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Smartphone, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { useConfirm } from '../../components/Dialog';
import { ICON_SM } from '../../components/icons';
import { NotificationPreferences } from '../../components/NotificationPreferences';
import { useToast } from '../../components/Toast';
import { Card, Empty, ErrorBox, Skeleton, Tag } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { disablePush, usePushState } from '../../lib/push';

/**
 * What reaches a person, and where.
 *
 * The switches are the browser's own bookkeeping and live in localStorage; the device list is the
 * server's, and every row in it is an install this wrapper will push to. They are shown together
 * because from where a person stands they are one question — "how do I get told?" — and because the
 * per-kind preferences travel with the subscription: the server sends what the install asked for.
 */
export function NotificationsTab() {
  const { t } = useTranslation('config');

  return (
    <>
      <Card title={t('notifications.title')}>
        <p className="small muted">{t('notifications.intro')}</p>
        <NotificationPreferences />
      </Card>
      <DevicesCard />
    </>
  );
}

/**
 * Every install registered for push. A subscription belongs to an install and not to a person —
 * Agentry has one credential for everyone who holds it — so this list is shared, and removing a
 * row silences that device for everybody.
 */
function DevicesCard() {
  const { t } = useTranslation('config');
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const push = usePushState();
  const { data, error, isLoading } = useQuery({ queryKey: keys.pushSubscriptions, queryFn: api.pushSubscriptions });
  const devices = data ?? [];

  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.pushSubscriptions });

  const remove = useMutation({
    mutationFn: async (device: PushSubscriptionSummary) => {
      // The row is this browser's: drop the subscription here too, or the browser would keep one
      // the server no longer knows and the switch would say it is on
      if (device.id === push.id) return void (await disablePush());
      await api.removePush({ id: device.id });
    },
    onSuccess: refresh,
    onError: (err) => toast.error(t('notifications.devices.removeFailed'), err),
  });

  const test = useMutation({
    mutationFn: (device: PushSubscriptionSummary) => api.testPush({ id: device.id }),
    onSuccess: (result) => {
      if (result.sent > 0) toast.success(t('notifications.devices.testSent'));
      else if (result.removed > 0) toast.error(t('notifications.devices.testGone'));
      else toast.error(t('notifications.devices.testFailed'));
      refresh();
    },
    onError: (err) => toast.error(t('notifications.devices.testFailed'), err),
  });

  return (
    <Card title={t('notifications.devices.title')}>
      <p className="small muted">{t('notifications.devices.intro')}</p>
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={3} />
      ) : devices.length === 0 ? (
        <Empty title={t('notifications.devices.none')} icon={Smartphone}>
          {t('notifications.devices.noneHint')}
        </Empty>
      ) : (
        <ul className="list" data-testid="push-devices">
          {devices.map((device) => (
            <li key={device.id} className="list-row-wrap">
              <div className="list-row">
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span className="strong break">{device.label}</span>
                    {device.id === push.id && <Tag tone="ok">{t('notifications.devices.thisDevice')}</Tag>}
                  </div>
                  <div className="muted small mono break">{device.endpoint}</div>
                  <div className="meta">
                    <span>{t('notifications.devices.kinds', { count: device.kinds.length })}</span>
                    <span>{t('notifications.devices.lastSeen', { when: timeAgo(device.lastSeenAt) })}</span>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={test.isPending}
                    aria-label={t('notifications.devices.testNamed', { name: device.label })}
                    onClick={() => test.mutate(device)}
                  >
                    <Send {...ICON_SM} /> {t('notifications.devices.test')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={remove.isPending}
                    aria-label={t('notifications.devices.removeNamed', { name: device.label })}
                    onClick={() =>
                      void confirm({
                        title: t('notifications.devices.removeTitle'),
                        body: t('notifications.devices.removeBody', { name: device.label }),
                        confirmLabel: t('notifications.devices.remove'),
                        danger: true,
                      }).then((ok) => ok && remove.mutate(device))
                    }
                  >
                    <Trash2 {...ICON_SM} /> {t('notifications.devices.remove')}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
