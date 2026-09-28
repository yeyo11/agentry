import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/*
 * A list's filters, search, sort and state tab, kept until the person resets them. The address stays
 * where they live — a filtered view can still be linked to and survives Back — and each change is
 * also written to localStorage, per page and per project of the top bar's scope. Coming back to a
 * page with none of its parameters in the address puts the stored ones back; a link that carries
 * some applies them and they become the stored ones.
 */

const PREFIX = 'agentry:filters:';

/** The scope of a page that the top bar's project does not narrow */
export const GLOBAL_SCOPE = 'global';

/** The page's own parameters, by name; one absent is at its default */
export type ListValues = Readonly<Record<string, string>>;

export function storageKey(page: string, scope: string): string {
  return `${PREFIX}${page}:${scope}`;
}

export function pickValues(params: URLSearchParams, owned: readonly string[]): ListValues {
  const values: Record<string, string> = {};
  for (const name of owned) {
    const value = params.get(name);
    if (value !== null && value !== '') values[name] = value;
  }
  return values;
}

export function sameValues(a: ListValues, b: ListValues): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
}

/** What was stored, trusting only strings under the page's own names: anything else is from an older build */
export function parseStored(raw: string | null, owned: readonly string[]): ListValues {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const values: Record<string, string> = {};
  for (const name of owned) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === 'string' && value !== '') values[name] = value;
  }
  return values;
}

/** The address with the page's parameters replaced by `values`, and every other one left alone */
export function withValues(params: URLSearchParams, owned: readonly string[], values: ListValues): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of owned) next.delete(name);
  for (const [name, value] of Object.entries(values)) next.set(name, value);
  return next;
}

/**
 * Which values a page shows, and whether they become the stored ones. The scope changing under an
 * unchanged address is the top bar switching project, so that project's values come back; an
 * address with none of the page's parameters is a plain visit, so the stored ones come back; any
 * other address was set on purpose (a link, Back, a change on the page) and wins.
 */
export function reconcile({
  url,
  stored,
  scopeChanged,
  urlChanged,
}: {
  url: ListValues;
  stored: ListValues;
  scopeChanged: boolean;
  urlChanged: boolean;
}): { values: ListValues; save: boolean } {
  if ((scopeChanged && !urlChanged) || Object.keys(url).length === 0) return { values: stored, save: false };
  return { values: url, save: !sameValues(url, stored) };
}

function read(key: string, owned: readonly string[]): ListValues {
  try {
    return parseStored(localStorage.getItem(key), owned);
  } catch {
    return {};
  }
}

function write(key: string, values: ListValues): void {
  try {
    if (Object.keys(values).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // private mode or a full quota: the filters still work, they just do not outlive the page
  }
}

export interface ListParams {
  /** The address as the page should read it: the stored values already in place on the first render */
  params: URLSearchParams;
  /** Sets or clears (`null` or `''`) some of the page's parameters, and stores the result */
  patch: (changes: Record<string, string | null>) => void;
  /** Drops every parameter of the page, from the address and from storage */
  reset: () => void;
}

/**
 * @param page what the values are stored under, one per list
 * @param owned the parameters that are the list's state; the others (`project`, `new`, `tab`…) are left
 *   alone. A constant of the module: a new array each render would re-run every memo
 * @param scope the top bar's project (`ALL_PROJECTS` for none, `GLOBAL_SCOPE` for a page it does not
 *   narrow), or `null` while it is not settled, so a remembered project's values are not replaced by
 *   All projects' in the meantime
 */
export function useListParams(page: string, owned: readonly string[], scope: string | null): ListParams {
  const [params, setParams] = useSearchParams();
  const key = scope === null ? null : storageKey(page, scope);
  const url = useMemo(() => pickValues(params, owned), [params, owned]);
  const urlText = JSON.stringify(url);
  // What the last decision was taken on, to tell a project switch from a new address
  const seen = useRef<{ key: string; url: string } | null>(null);

  const decision = useMemo(() => {
    if (key === null) return null;
    const previous = seen.current;
    return reconcile({
      url,
      stored: read(key, owned),
      scopeChanged: previous !== null && previous.key !== key,
      urlChanged: previous !== null && previous.url !== urlText,
    });
  }, [key, urlText, owned]);

  useEffect(() => {
    if (key === null || decision === null) return;
    seen.current = { key, url: JSON.stringify(decision.values) };
    if (decision.save) write(key, decision.values);
    if (!sameValues(decision.values, url)) setParams((previous) => withValues(previous, owned, decision.values), { replace: true });
  }, [decision]);

  const effective = useMemo(
    () => (decision && !sameValues(decision.values, url) ? withValues(params, owned, decision.values) : params),
    [decision, params, url, owned],
  );

  const patch = useCallback(
    (changes: Record<string, string | null>) => {
      const values: Record<string, string> = { ...pickValues(effective, owned) };
      for (const [name, value] of Object.entries(changes)) {
        if (value === null || value === '') delete values[name];
        else values[name] = value;
      }
      // Stored before the address changes, so the render that follows finds them already agreeing
      if (key !== null) write(key, values);
      setParams((previous) => withValues(previous, owned, values), { replace: true });
    },
    [effective, key, setParams, owned],
  );

  const reset = useCallback(() => {
    if (key !== null) write(key, {});
    setParams((previous) => withValues(previous, owned, {}), { replace: true });
  }, [key, setParams, owned]);

  return { params: effective, patch, reset };
}
