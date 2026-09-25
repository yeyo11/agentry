import { Bell, ChevronRight, Download, Share, ShieldAlert, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON, ICON_SM } from '../../components/icons';
import { Empty } from '../../components/ui';
import { NARROW, useMediaQuery } from '../../lib/media';
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
  const phone = useMediaQuery(NARROW);

  return (
    <div className="install" data-testid="install-card">
      <Empty
        illustration="install"
        size={phone ? 'sm' : 'md'}
        title={t('install.title')}
        action={
          status === 'prompt' && (
            <button type="button" className="btn btn-primary install-action" onClick={install}>
              <Download {...ICON} /> {t('install.action')}
            </button>
          )
        }
      >
        {t('install.intro')}
      </Empty>

      {status === 'installed' && (
        <p className="alert small" role="status">
          <Smartphone className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('install.installed')}</span>
        </p>
      )}

      {status === 'ios' && (
        <p className="alert small" role="status">
          <Share className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('install.ios')}</span>
        </p>
      )}

      {status === 'manual' && (
        <p className="alert small" role="status">
          <Download className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('install.manual')}</span>
        </p>
      )}

      {!secure && (
        <p className="alert alert-warn small" role="status" data-testid="install-insecure">
          <ShieldAlert className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('install.insecure', { origin })}</span>
        </p>
      )}

      {/* The switch itself lives with the other notification choices: one place turns push on */}
      <Link className="card install-push" to="/settings?tab=notifications">
        <span className="install-push-icon" aria-hidden>
          <Bell {...ICON_SM} />
        </span>
        <span className="install-push-text">
          <span className="install-push-title">{t('install.push.title')}</span>
          <span className="small muted">{t('install.push.text')}</span>
        </span>
        <ChevronRight className="install-push-chevron" {...ICON} />
      </Link>
    </div>
  );
}
