import type { SecretStorageStatus } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Lock, TriangleAlert } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { ICON, ICON_SM } from '@agentry/ui/components/icons';
import { Card, Tag } from '@agentry/ui/components/ui';

/** Where passing the key in the environment is explained: the README's table of variables. */
export const SECRET_KEY_DOCS = 'https://github.com/yeyo11/agentry#environment-variables';

const mono = { mono: <span className="mono" /> };

function HowLink() {
  const { t } = useTranslation('setup');
  return (
    <a className="c-accent signin-link" href={SECRET_KEY_DOCS} target="_blank" rel="noopener noreferrer">
      {t('secrets.how')}
      <ExternalLink {...ICON_SM} />
      <span className="sr-only"> ({t('panel.opensNewTab')})</span>
    </a>
  );
}

/**
 * Settings → Security's first card: how the keys and tokens Agentry hands a CLI are kept
 * (`SecretStorageStatus` in `GET /setup`). Sealed is ok; a key beside the data it seals is a warning
 * that recommends the environment; no key at all is a warning that values are plain.
 */
export function SecretsCard() {
  const { t } = useTranslation('setup');
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }) });
  const secrets = setup.data?.secrets;
  if (!secrets) return null;
  return (
    <Card
      className="secrets-card"
      title={
        <span className="card-title-icon">
          <Lock {...ICON_SM} />
          {t('secrets.title')}
        </span>
      }
      actions={secrets.sealed ? <Tag tone="ok">{t('secrets.sealed')}</Tag> : <Tag tone="warn">{t('secrets.plain')}</Tag>}
    >
      <p className="small muted">
        <Trans t={t} i18nKey={secrets.sealed ? 'secrets.body' : 'secrets.bodyPlain'} components={mono} />
      </p>
      <SecretsWarning secrets={secrets} />
    </Card>
  );
}

/** The warning under the card, when there is one to give. */
function SecretsWarning({ secrets }: { secrets: SecretStorageStatus }) {
  const { t } = useTranslation('setup');
  if (secrets.sealed && !secrets.keyBeside) return null;
  return (
    <div className="alert alert-warn secrets-warning" role="note">
      <TriangleAlert {...ICON} className="alert-icon" />
      <div className="alert-body">
        <strong>{t(secrets.sealed ? 'secrets.besideTitle' : 'secrets.plainTitle')}</strong>
        <span>
          <Trans t={t} i18nKey={secrets.sealed ? 'secrets.besideBody' : 'secrets.plainBody'} components={mono} />
        </span>
        {secrets.sealed && (
          <span>
            <Trans t={t} i18nKey="secrets.recommend" components={mono} />
          </span>
        )}
        <HowLink />
      </div>
    </div>
  );
}

/**
 * The assistant's Access step names the one thing about secrets a person should know before pasting
 * any: a key kept beside the data. Nothing when the key comes from the environment.
 */
export function SecretsCallout({ secrets }: { secrets: SecretStorageStatus }) {
  const { t } = useTranslation('setup');
  if (!secrets.keyBeside) return null;
  return (
    <div className="alert alert-warn secrets-warning" role="note">
      <Lock {...ICON} className="alert-icon" />
      <div className="alert-body">
        <strong>{t('secrets.setupTitle')}</strong>
        <span>
          <Trans t={t} i18nKey="secrets.setupBody" components={mono} />
        </span>
        <HowLink />
      </div>
    </div>
  );
}
