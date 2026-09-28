import { useTranslation } from 'react-i18next';
import { intentParts } from './steps/steps-model';

/**
 * What Claude wrote before an edit, in the language's quotes, with what it put between backticks
 * as code. The why line of Result and the heading of Step by step quote it the same way.
 */
export function Intent({ text }: { text: string }) {
  const { t } = useTranslation('changes');
  return (
    <>
      {t('steps.quoteOpen')}
      {intentParts(text).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
      {t('steps.quoteClose')}
    </>
  );
}
