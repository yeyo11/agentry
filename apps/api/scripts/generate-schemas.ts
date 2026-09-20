// Generates src/openapi/schemas.json (OpenAPI component schemas) from the shared TypeScript types,
// so the API reference can never drift from the contract. Run: pnpm --filter @agentry/api openapi:schemas
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = dirname(fileURLToPath(import.meta.url));
const typesFile = resolve(here, '../../../packages/shared/src/types.ts');
const out = resolve(here, '../src/openapi/schemas.json');

// Root types used by the routes; everything they reference is pulled in automatically.
const ROOT_TYPES = [
  'ApiError', 'SystemInfo', 'Overview', 'AuthStatus', 'AuthVerification', 'SetCredentialsRequest', 'ActiveCliSession',
  'ProjectSummary', 'CreateProjectRequest', 'SessionSummary', 'SessionDetail', 'TranscriptSearchResult',
  'RunOptions', 'RunSummary', 'RunDetail', 'RunEvent', 'EffectiveEnvironment', 'BackgroundTask', 'BackgroundTaskOutput', 'SubagentInfo', 'AgentTranscript', 'WorkflowRun', 'WorkflowDefinition', 'RunWorkflowRequest', 'SaveOrchestrationWorkflowRequest',
  'Orchestration', 'OrchestrationSpec', 'PlanRequest', 'PlanDraftSummary', 'PermissionRequest', 'PermissionDecision', 'RunSettingsUpdate', 'ResumeOrchestrationRequest',
  'SettingsDoc', 'InstructionsDoc', 'McpServerEntry', 'McpServerHealth', 'MarkdownResource',
  'ConfigFileRoot', 'ConfigFileNode', 'ConfigFileContent', 'WriteConfigFileRequest',
  'MemoryFile', 'MemoryProjectSummary', 'PluginsOverview', 'AvailablePlugin', 'PluginActionRequest', 'CliTextResult',
  'Attachment', 'AccountsOverview', 'AccountSummary', 'SwitchAccountRequest', 'SwitchResult', 'AddAccountTokenRequest',
  'SetAccountAliasRequest', 'AutoSwitchSettings', 'AutoSwitchEvent',
  'AgentryEvent', 'StreamHelloEvent', 'StreamResyncEvent',
  // Agentry's own model: chats, executions, projects
  'Chat', 'ChatDetail', 'NewChatRequest', 'ResumeChatRequest', 'ForkChatRequest', 'ChatMessageRequest', 'ChatSettingsUpdate',
  'TaskHintRequest', 'Project', 'ProjectCandidate', 'ImportProjectRequest', 'UpdateProjectRequest',
];

const generator = createGenerator({
  path: typesFile,
  tsconfig: resolve(here, '../../../packages/shared/tsconfig.json'),
  expose: 'export',
  topRef: true,
  jsDoc: 'extended',
  additionalProperties: true, // documentation only: the API never rejects extra fields
  skipTypeCheck: true,
});
const schema = { definitions: {} as Record<string, unknown> };
for (const type of ROOT_TYPES) Object.assign(schema.definitions, generator.createSchema(type).definitions);

// JSON Schema `#/definitions/X` -> OpenAPI `#/components/schemas/X`
const definitions = JSON.parse(JSON.stringify(schema.definitions ?? {}).replaceAll('#/definitions/', '#/components/schemas/'));
writeFileSync(out, `${JSON.stringify(definitions, null, 2)}\n`);
console.log(`wrote ${Object.keys(definitions).length} schemas to ${out}`);
