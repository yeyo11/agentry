import type { AppSettings, AppSettingValues, PermissionMode, UpdateAppSettingsRequest } from '@agentry/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { NumberInput, Select } from '@agentry/ui/components/controls';
import { useToast } from '@agentry/ui/components/Toast';
import { Card, ErrorBox, Field, Skeleton, Tag } from '@agentry/ui/components/ui';
import { PERMISSION_MODES } from '../../components/ui';

/** The variable that sets each one, named where the UI says it cannot change it. */
export const APP_SETTING_ENV: Record<keyof AppSettingValues, string> = {
  allowedHosts: 'AGENTRY_ALLOWED_HOSTS',
  maxConcurrentRuns: 'AGENTRY_MAX_CONCURRENT_RUNS',
  defaultPermissionMode: 'AGENTRY_DEFAULT_PERMISSION_MODE',
  setupSeen: 'AGENTRY_SETUP_SEEN',
};

// The server's own bounds; a value outside them is refused with a 400
const MIN_RUNS = 1;
const MAX_RUNS = 64;

/** One name per line, as the person wrote them, without the blanks. */
export const parseHosts = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

/**
 * What a `PUT` carries: only the keys the draft names whose value moved, and never one the
 * environment set. The server refuses a key the environment owns even when its value is unchanged,
 * because writing it to the file would do nothing until the variable goes away, and then change
 * behaviour by surprise. `allowedHosts` is the exception: the draft holds only the hosts added here,
 * which add to the environment's, so it is compared with that layer and always sendable.
 */
export function changedSettings(saved: AppSettings, draft: Partial<AppSettingValues>): UpdateAppSettingsRequest {
  const out: UpdateAppSettingsRequest = {};
  if (draft.allowedHosts !== undefined && draft.allowedHosts.join('\n') !== saved.allowedHostLayers.file.join('\n')) out.allowedHosts = draft.allowedHosts;
  if (draft.maxConcurrentRuns !== undefined && saved.sources.maxConcurrentRuns !== 'env' && draft.maxConcurrentRuns !== saved.maxConcurrentRuns) {
    out.maxConcurrentRuns = draft.maxConcurrentRuns;
  }
  if (draft.defaultPermissionMode !== undefined && saved.sources.defaultPermissionMode !== 'env' && draft.defaultPermissionMode !== saved.defaultPermissionMode) {
    out.defaultPermissionMode = draft.defaultPermissionMode;
  }
  return out;
}

/** "Set by the environment", with the variable to change instead. */
export function EnvNote({ setting }: { setting: keyof AppSettingValues }) {
  const { t } = useTranslation('config');
  return <p className="small muted">{t('appSettings.envHint', { variable: APP_SETTING_ENV[setting] })}</p>;
}

function useSaveAppSettings(onSaved: (next: AppSettings) => void, savedText: string) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.updateAppSettings,
    onSuccess: (next) => {
      queryClient.setQueryData(keys.appSettings, next);
      onSaved(next);
      toast.success(savedText);
    },
    onError: (err) => toast.error(t('appSettings.saveFailed'), err),
  });
}

/**
 * The layered settings the Security tab holds: the hosts this wrapper answers to, and what a new
 * run gets by default. Each one the environment set is shown, read-only, with the variable to change.
 */
export function AppSettingsCards() {
  const { data, error, isLoading } = useQuery({ queryKey: keys.appSettings, queryFn: api.appSettings });
  return (
    <>
      <ErrorBox error={error} />
      {isLoading && (
        <Card>
          <Skeleton rows={4} />
        </Card>
      )}
      {data && (
        <>
          {/* Remounted from the server's copy, so a draft never outlives a change made elsewhere; the
              tunnel's host coming or going is not such a change, and the draft stays */}
          <HostsCard key={`hosts:${data.allowedHostLayers.file.join(',')}`} saved={data} />
          <RunsCard key={`runs:${data.maxConcurrentRuns}:${data.defaultPermissionMode}:${data.sources.maxConcurrentRuns}:${data.sources.defaultPermissionMode}`} saved={data} />
        </>
      )}
    </>
  );
}

function SourceTag({ settings, keys: owned }: { settings: AppSettings; keys: ReadonlyArray<keyof AppSettingValues> }) {
  const { t } = useTranslation('config');
  return owned.some((key) => settings.sources[key] === 'env') ? <Tag>{t('appSettings.fromEnv')}</Tag> : null;
}

/**
 * The environment's hosts and the tunnel's are listed, each tagged with who put it there, because
 * nobody may edit them here; the field holds only the hosts added here, which answer beside them.
 */
function HostsCard({ saved }: { saved: AppSettings }) {
  const { t } = useTranslation(['config', 'common']);
  const layers = saved.allowedHostLayers;
  const [text, setText] = useState(layers.file.join('\n'));
  const change = changedSettings(saved, { allowedHosts: parseHosts(text) });
  const dirty = Object.keys(change).length > 0;
  const save = useSaveAppSettings((next) => setText(next.allowedHostLayers.file.join('\n')), t('appSettings.hosts.saved'));
  const fixed = [...layers.env.map((host) => ({ host, tag: t('appSettings.fromEnv') })), ...layers.runtime.map((host) => ({ host, tag: t('appSettings.hosts.fromTunnel') }))];

  return (
    <Card title={t('appSettings.hosts.title')}>
      <p className="small muted">{t('appSettings.hosts.intro')}</p>
      {fixed.length > 0 && (
        <>
          <ul className="app-settings-hosts" data-testid="fixed-hosts">
            {fixed.map(({ host, tag }) => (
              <li key={host} className="app-settings-host">
                <span className="mono">{host}</span>
                <Tag>{tag}</Tag>
              </li>
            ))}
          </ul>
          {layers.env.length > 0 && <EnvNote setting="allowedHosts" />}
        </>
      )}
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate(change);
        }}
      >
        <Field label={t('appSettings.hosts.label')} hint={layers.env.length > 0 ? t('appSettings.hosts.hintBesideEnv') : t('appSettings.hosts.hint')}>
          <textarea
            className="mono"
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder={t('appSettings.hosts.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            data-testid="allowed-hosts"
          />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending}>
            {save.isPending ? t('shared.saving') : t('shared.save')}
          </button>
          {dirty && (
            <button type="button" className="btn" onClick={() => setText(layers.file.join('\n'))}>
              {t('shared.discard')}
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}

function RunsCard({ saved }: { saved: AppSettings }) {
  const { t } = useTranslation(['config', 'common']);
  const [mode, setMode] = useState<PermissionMode>(saved.defaultPermissionMode);
  const [runs, setRuns] = useState<number | undefined>(saved.maxConcurrentRuns);
  const modeFromEnv = saved.sources.defaultPermissionMode === 'env';
  const runsFromEnv = saved.sources.maxConcurrentRuns === 'env';
  const runsValid = runs !== undefined && Number.isInteger(runs) && runs >= MIN_RUNS && runs <= MAX_RUNS;
  const change = changedSettings(saved, { defaultPermissionMode: mode, maxConcurrentRuns: runsValid ? runs : saved.maxConcurrentRuns });
  const save = useSaveAppSettings(
    (next) => {
      setMode(next.defaultPermissionMode);
      setRuns(next.maxConcurrentRuns);
    },
    t('appSettings.runs.saved'),
  );

  return (
    <Card title={t('appSettings.runs.title')} actions={<SourceTag settings={saved} keys={['defaultPermissionMode', 'maxConcurrentRuns']} />}>
      <p className="small muted">{t('appSettings.runs.intro')}</p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (runsValid && Object.keys(change).length > 0) save.mutate(change);
        }}
      >
        <div className="form-grid">
          <Field label={t('appSettings.runs.mode')} hint={modeFromEnv ? t('appSettings.envHint', { variable: APP_SETTING_ENV.defaultPermissionMode }) : t('appSettings.runs.modeHint')}>
            <Select
              aria-label={t('appSettings.runs.mode')}
              value={mode}
              onChange={setMode}
              disabled={modeFromEnv}
              options={PERMISSION_MODES.map((value) => ({ value, label: value }))}
            />
          </Field>
          <Field
            label={t('appSettings.runs.concurrent')}
            hint={runsFromEnv ? t('appSettings.envHint', { variable: APP_SETTING_ENV.maxConcurrentRuns }) : t('appSettings.runs.concurrentHint', { min: MIN_RUNS, max: MAX_RUNS })}
          >
            <NumberInput aria-label={t('appSettings.runs.concurrent')} value={runs} onChange={setRuns} min={MIN_RUNS} max={MAX_RUNS} disabled={runsFromEnv} />
          </Field>
        </div>
        {!(modeFromEnv && runsFromEnv) && (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={!runsValid || Object.keys(change).length === 0 || save.isPending}>
              {save.isPending ? t('shared.saving') : t('shared.save')}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
