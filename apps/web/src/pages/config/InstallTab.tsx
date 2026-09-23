import { Download, Share, ShieldAlert, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON, ICON_SM } from '../../components/icons';
import { Card } from '../../components/ui';
import { useInstallState } from '../../lib/pwa';

/**
 * Installing Agentry on the device that is reading this.
 *
 * Android and the desktop hand the page their own install prompt, which may only be shown from a
 * click — so it is held and offered as a button here. iOS has no such API and never will: the only
 * honest thing to do is name the two taps. The card disappears once the app is the one running.
 */
export function InstallTab() {
  const { t } = useTranslation('config');
  const { status, install, secure, origin } = useInstallState();

  return (
    <Card title={t('install.title')}>
      <div className="stack" data-testid="install-card">
        <p className="small muted">{t('install.intro')}</p>

        {status === 'installed' && (
          <p className="alert small" role="status">
            <Smartphone className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t('install.installed')}</span>
          </p>
        )}

        {status === 'prompt' && (
          <div>
            <button type="button" className="btn btn-primary" onClick={install}>
              <Download {...ICON} /> {t('install.action')}
            </button>
          </div>
        )}

        {status === 'ios' && (
          <p className="alert small" role="status">
            <Share className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t('install.ios')}</span>
          </p>
        )}

        {status === 'manual' && <p className="small">{t('install.manual')}</p>}

        {!secure && (
          <p className="alert alert-warn small" role="status" data-testid="install-insecure">
            <ShieldAlert className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t('install.insecure', { origin })}</span>
          </p>
        )}
      </div>
    </Card>
  );
}
