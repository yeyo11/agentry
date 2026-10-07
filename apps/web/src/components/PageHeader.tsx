import type { ReactNode } from 'react';
import { PageHeader as BasePageHeader } from '@agentry/ui/components/ui';
import { PhoneHeader, useOwnPhoneHeader, type PhoneHeaderProps } from './shell/PhoneHeader';

type PhoneHead = Omit<PhoneHeaderProps, 'title'> & { title?: ReactNode };

/**
 * The page header of `@agentry/ui`, which knows nothing of routes, with how the page heads itself on
 * a phone: where its route is marked `phoneHeader: 'page'` (shell/phone-header.ts) the top bar is
 * hidden, so `phone` draws the back arrow, the title and the "⋯" sheet in its place.
 */
export function PageHeader({ phone, ...props }: Parameters<typeof BasePageHeader>[0] & { phone?: PhoneHead }) {
  const desktop = <BasePageHeader {...props} />;
  // Only a page that says how it heads itself on a phone reads the route: the rest render anywhere
  return phone ? <PageOrPhoneHeader title={props.title} phone={phone} desktop={desktop} /> : desktop;
}

function PageOrPhoneHeader({ title, phone, desktop }: { title: ReactNode; phone: PhoneHead; desktop: ReactNode }) {
  const own = useOwnPhoneHeader();
  if (!own) return desktop;
  return <PhoneHeader {...phone} title={phone.title ?? title} />;
}
