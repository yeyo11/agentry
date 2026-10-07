import i18n, { type TOptions } from 'i18next';

/*
 * The prompts of the assistant's write tools (`mcp__agentry__<name>`), said in the person's words.
 * The title is what the call would do and the detail is what it carries, built from the input: a
 * tool's wire name, a field name or a status code never reaches the screen.
 */

export interface WritePrompt {
  title: string;
  /** One line per thing the call carries; empty when the title says it all */
  detail: string;
}

const PREFIX = 'mcp__agentry__';
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
};

// The keys are assembled from the tool's name and the input's values, so the typed resource lookup cannot follow them
const t = (key: string, options: TOptions = {}): string => i18n.t(`chat:permissions.writes.${key}` as 'chat:permissions.writes.anItem', options);

/** A word from one of the lists in the locale; a value it does not know is left out rather than shown as the code it is */
function word(list: 'types' | 'statuses' | 'priorities', value: string): string {
  return i18n.exists(`chat:permissions.writes.${list}.${value}`) ? t(`${list}.${value}`) : '';
}

/** A key such as CW-12 is how the person names an item; an id is not, so it becomes "a work item" */
const itemName = (input: Record<string, unknown>): string => {
  const ref = str(input, 'item');
  return KEY.test(ref) ? ref.toUpperCase() : t('anItem');
};

function fields(input: Record<string, unknown>, names: readonly string[]): string[] {
  const lines: string[] = [];
  for (const name of names) {
    const value = input[name];
    if (name === 'description' || name === 'body' || name === 'prompt') {
      if (typeof value === 'string' && value.trim()) lines.push(value.trim());
    } else if (name === 'title' || name === 'model') {
      if (typeof value === 'string' && value.trim()) lines.push(t(`fields.${name}`, { value: value.trim() }));
    } else if (name === 'status' || name === 'priority' || name === 'type') {
      const shown = typeof value === 'string' ? word(name === 'status' ? 'statuses' : name === 'priority' ? 'priorities' : 'types', value) : '';
      if (shown) lines.push(t(`fields.${name}`, { value: shown }));
    } else if (name === 'labels') {
      if (Array.isArray(value) && value.length) lines.push(t('fields.labels', { value: value.filter((l) => typeof l === 'string').join(', ') }));
    } else if (name === 'acceptanceCriteria') {
      if (Array.isArray(value)) {
        const texts = value.map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : '')).filter(Boolean);
        if (texts.length) lines.push(t('fields.criteria', { value: texts.join(' · ') }));
      }
    }
  }
  return lines;
}

/** Null for any tool this does not know, so its prompt stays what it was */
export function describeWrite(toolName: string, input: Record<string, unknown>): WritePrompt | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const done = (title: string, lines: string[] = []): WritePrompt => ({ title, detail: lines.join('\n') });
  switch (toolName.slice(PREFIX.length)) {
    case 'create_work_item':
      // The type defaults to a task, as the tool does
      return done(t('createWorkItem', { type: word('types', str(input, 'type') || 'task') || word('types', 'task'), title: str(input, 'title') }), fields(input, ['description', 'status', 'priority', 'labels', 'acceptanceCriteria']));
    case 'update_work_item':
      return done(t('updateWorkItem', { item: itemName(input) }), fields(input, ['title', 'type', 'priority', 'labels', 'description', 'acceptanceCriteria']));
    case 'move_work_item':
      return done(t('moveWorkItem', { item: itemName(input), status: word('statuses', str(input, 'status')) }));
    case 'comment_work_item':
      return done(t('commentWorkItem', { item: itemName(input) }), fields(input, ['body']));
    case 'retry_flow_run':
      return done(t('retryFlowRun'));
    case 'retry_orchestration_task':
      return done(t('retryOrchestrationTask'));
    case 'start_chat':
      return done(t('startChat'), fields(input, ['prompt', 'model']));
    case 'accept_assistant_proposal':
      return done(t('acceptProposal'));
    case 'discard_assistant_proposal':
      return done(t('discardProposal'));
    default:
      return null;
  }
}
