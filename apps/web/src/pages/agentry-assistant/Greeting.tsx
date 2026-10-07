import { useTranslation } from 'react-i18next';
import { AssistantMark } from '../../components/assistant/run';

/**
 * The first message of every chat of the Agentry assistant, drawn from i18n and not a model turn:
 * it is instant, the same every time, and the chat's title stays the person's first prompt.
 */
export function AssistantGreeting() {
  const { t } = useTranslation('assistant');
  return (
    <div className="as-greeting">
      <AssistantMark small />
      <p>{t('agentry.greeting')}</p>
    </div>
  );
}
