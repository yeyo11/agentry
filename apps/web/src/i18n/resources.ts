// Every namespace of both languages, bundled: the UI never waits on a request to show its text.
// `common` and `primitives` belong to @agentry/ui and `chat` to @agentry/chat-ui; all three are spread in from them.
import { chatUiEn, chatUiEs } from '@agentry/chat-ui/locales';
import { uiEn, uiEs } from '@agentry/ui/i18n/resources';
import enAccountsConfig from './locales/en/accountsConfig.json';
import enAssistant from './locales/en/assistant.json';
import enChanges from './locales/en/changes.json';
import enChecks from './locales/en/checks.json';
import enChats from './locales/en/chats.json';
import enComponents from './locales/en/components.json';
import enConfig from './locales/en/config.json';
import enConnectors from './locales/en/connectors.json';
import enDecisions from './locales/en/decisions.json';
import enDocuments from './locales/en/documents.json';
import enHome from './locales/en/home.json';
import enObserve from './locales/en/observe.json';
import enOrchestration from './locales/en/orchestration.json';
import enOrchestrationDetail from './locales/en/orchestrationDetail.json';
import enOrchestrationV2 from './locales/en/orchestrationV2.json';
import enProjects from './locales/en/projects.json';
import enIntegrations from './locales/en/integrations.json';
import enIssues from './locales/en/issues.json';
import enMerge from './locales/en/merge.json';
import enProviders from './locales/en/providers.json';
import enReviews from './locales/en/reviews.json';
import enSchedules from './locales/en/schedules.json';
import enServer from './locales/en/server.json';
import enShell from './locales/en/shell.json';
import enSuggestion from './locales/en/suggestion.json';
import enTasks from './locales/en/tasks.json';
import enTeam from './locales/en/team.json';
import enUsage from './locales/en/usage.json';
import enWork from './locales/en/work.json';
import enWorkItem from './locales/en/workItem.json';
import esAccountsConfig from './locales/es/accountsConfig.json';
import esAssistant from './locales/es/assistant.json';
import esChanges from './locales/es/changes.json';
import esChecks from './locales/es/checks.json';
import esChats from './locales/es/chats.json';
import esComponents from './locales/es/components.json';
import esConfig from './locales/es/config.json';
import esConnectors from './locales/es/connectors.json';
import esDecisions from './locales/es/decisions.json';
import esDocuments from './locales/es/documents.json';
import esHome from './locales/es/home.json';
import esObserve from './locales/es/observe.json';
import esOrchestration from './locales/es/orchestration.json';
import esOrchestrationDetail from './locales/es/orchestrationDetail.json';
import esOrchestrationV2 from './locales/es/orchestrationV2.json';
import esProjects from './locales/es/projects.json';
import esIntegrations from './locales/es/integrations.json';
import esIssues from './locales/es/issues.json';
import esMerge from './locales/es/merge.json';
import esProviders from './locales/es/providers.json';
import esReviews from './locales/es/reviews.json';
import esSchedules from './locales/es/schedules.json';
import esServer from './locales/es/server.json';
import esShell from './locales/es/shell.json';
import esSuggestion from './locales/es/suggestion.json';
import esTasks from './locales/es/tasks.json';
import esTeam from './locales/es/team.json';
import esUsage from './locales/es/usage.json';
import esWork from './locales/es/work.json';
import esWorkItem from './locales/es/workItem.json';

export const defaultNS = 'common';

export const en = {
  ...uiEn,
  assistant: enAssistant,
  components: enComponents,
  config: enConfig,
  work: enWork,
  ...chatUiEn,
  chats: enChats,
  home: enHome,
  projects: enProjects,
  providers: enProviders,
  reviews: enReviews,
  integrations: enIntegrations,
  issues: enIssues,
  merge: enMerge,
  orchestration: enOrchestration,
  orchestrationDetail: enOrchestrationDetail,
  observe: enObserve,
  changes: enChanges,
  checks: enChecks,
  schedules: enSchedules,
  usage: enUsage,
  orchestrationV2: enOrchestrationV2,
  accountsConfig: enAccountsConfig,
  connectors: enConnectors,
  server: enServer,
  shell: enShell,
  tasks: enTasks,
  team: enTeam,
  workItem: enWorkItem,
  decisions: enDecisions,
  documents: enDocuments,
  suggestion: enSuggestion,
};

export type Namespace = keyof typeof en;

/** Same tree as English with every leaf a string: a missing Spanish key fails `pnpm typecheck`. */
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

export const es = {
  ...uiEs,
  assistant: esAssistant,
  components: esComponents,
  config: esConfig,
  work: esWork,
  ...chatUiEs,
  chats: esChats,
  home: esHome,
  projects: esProjects,
  providers: esProviders,
  reviews: esReviews,
  integrations: esIntegrations,
  issues: esIssues,
  merge: esMerge,
  orchestration: esOrchestration,
  orchestrationDetail: esOrchestrationDetail,
  observe: esObserve,
  changes: esChanges,
  checks: esChecks,
  schedules: esSchedules,
  usage: esUsage,
  orchestrationV2: esOrchestrationV2,
  accountsConfig: esAccountsConfig,
  connectors: esConnectors,
  server: esServer,
  shell: esShell,
  tasks: esTasks,
  team: esTeam,
  workItem: esWorkItem,
  decisions: esDecisions,
  documents: esDocuments,
  suggestion: esSuggestion,
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
