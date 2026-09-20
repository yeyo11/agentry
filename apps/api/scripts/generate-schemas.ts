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
  'ApiError', 'SystemInfo', 'Overview', 'AuthStatus', 'AuthVerification', 'SetCredentialsRequest',
  'CreateProjectRequest', 'TranscriptSearchResult',
  'RunEvent', 'EffectiveEnvironment', 'BackgroundTaskOutput', 'AgentTranscript', 'WorkflowDefinition', 'RunWorkflowRequest', 'SaveOrchestrationWorkflowRequest',
  'Orchestration', 'OrchestrationSpec', 'PlanRequest', 'PlanDraftSummary', 'PermissionRequest', 'PermissionDecision', 'ResumeOrchestrationRequest',
  'SettingsDoc', 'InstructionsDoc', 'McpServerEntry', 'McpServerHealth', 'ConfigResource',
  'ConfigFileRoot', 'ConfigFileNode', 'ConfigFileContent', 'WriteConfigFileRequest',
  'MemoryFile', 'MemoryProjectSummary', 'PluginsOverview', 'AvailablePlugin', 'PluginActionRequest', 'CliTextResult',
  'Attachment', 'AccountsOverview', 'AccountSummary', 'SwitchAccountRequest', 'SwitchResult', 'AddAccountTokenRequest',
  'SetAccountAliasRequest', 'AutoSwitchSettings', 'AutoSwitchEvent',
  'AgentryEvent', 'StreamHelloEvent', 'StreamResyncEvent',
  // Agentry's own model: chats, executions, projects
  'Chat', 'ChatSummary', 'ChatDetail', 'ChatBackgroundTaskEntry', 'ChatSubagentEntry', 'ChatWorkflowEntry', 'NewChatRequest', 'ResumeChatRequest', 'ForkChatRequest', 'ChatMessageRequest', 'ChatSettingsUpdate',
  'UsageReport',
  'TaskHintRequest', 'Project', 'ProjectCandidate', 'ImportProjectRequest', 'UpdateProjectRequest',
  // What a chat or a task changed on disk, and how to open it in an editor
  'ChangeSummary', 'FileDiff', 'ChatChanges', 'Checklist', 'EditorSettings',
  // Stepping in on a worker that is stuck
  'Health', 'TaskLimits', 'HintRequest', 'CancelCommandRequest',
  // Orchestration v2 and the verification phase
  'VerificationSpec', 'VerificationState', 'RelaunchOrchestrationRequest', 'OrchestrationTemplate',
  'SaveOrchestrationTemplateRequest', 'UpdateOrchestrationTemplateRequest', 'LaunchOrchestrationTemplateRequest',
  // Security
  'AuthConfig', 'UpdateAuthConfigRequest', 'SetAuthTokenRequest', 'AuthTokenResult', 'AuditEntry', 'AuditPage',
  // Per-chat MCP servers and tool presets
  'McpSelection', 'ToolPreset', 'ChatToolConfig',
  // claude.ai connectors
  'Connector', 'ConnectorAction', 'ConnectorGuide', 'ConnectorLimit', 'ConnectorsOverview',
  // Multi-account: a config dir and a rotation policy per account, usage kept over time
  'AccountConfig', 'RotationPolicy', 'UpdateAccountConfigRequest', 'UsageHistoryPoint',
  // Scheduling
  'Schedule', 'ScheduleRun', 'CreateScheduleRequest', 'UpdateScheduleRequest',
  // Usage and cost over time, and transcript export
  'UsageSeries', 'UsageBreakdown', 'ExportFormat',
  // Packaging
  'CliVersionInfo',
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
