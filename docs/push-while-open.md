---
created_at: 2026-09-27T15:40:00Z
updated_at: 2026-09-27T15:40:00Z
tags:
    - push
    - pwa
    - ios
    - fix
---
# Push while the app is open

What the service worker does with a push that arrives while a window of Agentry is open, and why
that rule changed after the first release of Web Push ([[plans/mobile.md]]).

## The bug

The worker showed nothing whenever any window of ours reported `visibilityState === 'visible'`, on
the reasoning that the page was already showing the same news as a toast. On an iPhone that made push
look dead:

- **Test never worked from the phone.** Settings → Notifications → **Test** is pressed from the open
  app, so the worker always saw a visible window and dropped it. A test push never goes through the
  event bus, so the page had no toast either: the UI said "sent" and nothing appeared anywhere.
- **iOS punishes a push that shows nothing.** WebKit treats it as a silent push, which Web Push does
  not allow, and revokes the subscription after a few. Every dropped test brought the phone closer to
  losing push altogether, while the server went on getting `201` from Apple.
- **A backgrounded iOS app can still report `visible`**, so real notifications could be swallowed
  with the app in the multitasking switcher.

The server side was never at fault: the VAPID keypair, the `sub` claim and the subscription were all
accepted by `web.push.apple.com`.

## The rule now

In `apps/web/public/sw.js`, a push is dropped only when a window of ours is **focused** and visible —
the one case where the person is looking at the toast. Two pushes are always shown:

- **A test push**, recognised by its key starting with `TEST_PUSH_KEY_PREFIX` (`push:test:`, in
  `packages/shared/src/notifications.ts`; the worker holds the same literal and
  `apps/web/test/pwa.test.ts` asserts they match).
- **Any push through Apple's push service** (the subscription's endpoint host ends in
  `push.apple.com`). On iOS a notification shown twice — toast and banner — is a far smaller cost
  than a revoked subscription.

The endpoint host is used instead of the user agent because it is exactly the condition that
matters: WebKit's rule comes with Apple's push service.

## Not changed

The default interruption level stays `important`. A chat that finishes normally is `normal`
priority with an `ok` tone and is not pushed at that level; a person who wants those picks **All**
for the device in Settings → Notifications.

## Related

[[plans/mobile.md]] · [[deploy.md]]
