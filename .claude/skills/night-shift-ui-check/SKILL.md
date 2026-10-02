---
name: night-shift-ui-check
description: Checklist for any UI change in apps/web: Night Shift tokens, both themes, controls, i18n en/es parity, phone layout, motion levels, accessibility. Use before finishing a screen or component change.
---

# Night Shift UI checklist

A UI change that breaks one of these is not done. The rules are in `docs/design-system.md` and `CONTRIBUTING.md`; the reference for every screen is in `docs/design-system/reference/` (static prototype and dark and light screenshots).

**Before you change a screen:** open its reference. **Before you finish:** compare the result against it.

## Checklist
- [ ] **Tokens only.** No hex, `rgb()`, pixel radius or millisecond value outside `packages/ui/src/styles/tokens.css` (the only exception is `#fff` on the brand gradient). The web test that guards this passes.
- [ ] **Both themes.** Dark is the default; the screen also works in `[data-theme='light']`. Text contrast >= 4.5:1, large numbers >= 3:1.
- [ ] **Controls** come from `packages/ui/src/components/controls` (Select, Checkbox, Switch, Slider, Menu, Sheet, Tabs...). Never a native select, checkbox, range or number input, `<details>`, or `title=` on an interactive element. Modules loaded on first paint import the file they need, not the barrel.
- [ ] **Type.** Geist for the UI; Geist Mono for ids, paths, commands, counts, times and section labels; numbers tabular.
- [ ] **Gradient sparingly.** `--grad` only on one primary action per zone, the FAB, the logo and the active-account avatar; at most two gradient surfaces per screen; the energy border on one surface only.
- [ ] **Only live things move.** `--live` (cyan) and loops mean an agent is working now. Every animation stops under `[data-motion='subtle']`, `[data-motion='off']`, `prefers-reduced-motion` and in a hidden tab; `motion.spec.mjs` stays green.
- [ ] **Status colours** mean one thing each (ok, warn, bad, idle) and always come with a word or an icon (reuse `StatusBadge` and `Tag`). Usage bars: neutral below 60 %, warn from 60 %, bad from 75 %.
- [ ] **Phone.** Touch targets >= 44 px, inputs at 16 px, "..." menus as a `Sheet`, no always-visible checkboxes, the four-tab bar and the gradient FAB.
- [ ] **Copy.** Every string goes through i18n with `en`/`es` parity; `es` follows `apps/web/src/i18n/GLOSSARY.md` (Spanish from Spain, infinitive buttons, sentence case, no `text-transform: capitalize` on sentences).
- [ ] **Restyle, don't duplicate.** Reuse the classes the app already has; a new variant goes into `docs/design-system.md` and `agentry-ds.css` in the same change. Keep the classes the e2e specs select.
- [ ] **Diffs** are drawn with `DiffView` from the API's unified text; no diff library, no link to an editor.
- [ ] **Illustrations**: `Empty` with an illustration from `components/illustrations`, at most one per screen, colours from `styles/illustrations.css`, ids from `useId()`, `aria-hidden`.
- [ ] **Accessibility.** Icon-only buttons carry an `aria-label`; everything is keyboard-reachable with a visible focus ring; `e2e/specs/a11y-*.spec.mjs` passes in both themes and at phone width.
- [ ] **Lazy routes** use `lazyPage()`, never a bare `React.lazy`.

Run `pnpm --filter @agentry/web test`, then `pnpm build && pnpm e2e` (or the specs your change touches).
