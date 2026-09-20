// Every namespace of both languages, bundled: the UI never waits on a request to show its text.
import enChat from './locales/en/chat.json';
import enChats from './locales/en/chats.json';
import enCommon from './locales/en/common.json';
import enComponents from './locales/en/components.json';
import enConfig from './locales/en/config.json';
import enHome from './locales/en/home.json';
import enObserve from './locales/en/observe.json';
import enOrchestration from './locales/en/orchestration.json';
import enOrchestrationDetail from './locales/en/orchestrationDetail.json';
import enProjects from './locales/en/projects.json';
import enWork from './locales/en/work.json';
import esChat from './locales/es/chat.json';
import esChats from './locales/es/chats.json';
import esCommon from './locales/es/common.json';
import esComponents from './locales/es/components.json';
import esConfig from './locales/es/config.json';
import esHome from './locales/es/home.json';
import esObserve from './locales/es/observe.json';
import esOrchestration from './locales/es/orchestration.json';
import esOrchestrationDetail from './locales/es/orchestrationDetail.json';
import esProjects from './locales/es/projects.json';
import esWork from './locales/es/work.json';

export const defaultNS = 'common';

export const en = {
  common: enCommon,
  components: enComponents,
  config: enConfig,
  work: enWork,
  chat: enChat,
  chats: enChats,
  home: enHome,
  projects: enProjects,
  orchestration: enOrchestration,
  orchestrationDetail: enOrchestrationDetail,
  observe: enObserve,
};

export type Namespace = keyof typeof en;

/** Same tree as English with every leaf a string: a missing Spanish key fails `pnpm typecheck`. */
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

export const es = {
  common: esCommon,
  components: esComponents,
  config: esConfig,
  work: esWork,
  chat: esChat,
  chats: esChats,
  home: esHome,
  projects: esProjects,
  orchestration: esOrchestration,
  orchestrationDetail: esOrchestrationDetail,
  observe: esObserve,
} satisfies Shape<typeof en>;

// `satisfies` only catches keys Spanish lacks; a key only Spanish has is caught here instead, so a
// renamed English key cannot leave its old translation behind.
type Paths<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}` }[keyof T & string];
type Expect<T extends true> = T;
export type SpanishHasNoExtraKeys = Expect<[Exclude<Paths<typeof es>, Paths<typeof en>>] extends [never] ? true : false>;

interface Tree {
  [key: string]: string | Tree;
}

/**
 * Spanish has a CLDR `many` category (1000000, 1e6) that English lacks, and i18next falls back to
 * English when `_many` is missing. With digits it reads like `_other`, so it is derived here and
 * both JSON files keep exactly the same keys.
 */
export function withManyPlurals(tree: Tree): Tree {
  const out: Tree = {};
  for (const [key, value] of Object.entries(tree)) {
    out[key] = typeof value === 'string' ? value : withManyPlurals(value);
    if (typeof value === 'string' && key.endsWith('_other')) {
      const many = `${key.slice(0, -'_other'.length)}_many`;
      if (!(many in tree)) out[many] = value;
    }
  }
  return out;
}

export const resources = { en, es: withManyPlurals(es) };
