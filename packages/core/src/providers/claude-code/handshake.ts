import type { ProviderCapability } from '@agentry/shared';
import { satisfiesRange } from '../detector.ts';
import type { CapabilityConfirmation, SessionInit } from '../driver.ts';
import { claudeCodeManifest } from './manifest.ts';

/**
 * What `system/init` of a session Agentry was starting anyway says about the installed CLI. A
 * handshake of its own would spend tokens, so this is the only one. The capabilities nobody can
 * read off the init (interrupt, fork, effort...) stay declared until a run exercises them.
 *
 * An empty tool list is an init we could not read, not a CLI that has no tools, so it contradicts
 * nothing.
 */
export function confirmClaudeInit(init: SessionInit): CapabilityConfirmation {
  const declared = claudeCodeManifest.capabilities;
  const range = claudeCodeManifest.versions.range;
  // A version outside what the driver is tested against confirms nothing: the detector reports it
  if (init.version && range && satisfiesRange(init.version, range) !== 'in') {
    return { version: init.version, confirmed: [], missing: [] };
  }

  const confirmed: ProviderCapability[] = [];
  const missing: ProviderCapability[] = [];
  const check = (capability: ProviderCapability, present: boolean, contradicts: boolean): void => {
    if (!declared.includes(capability)) return;
    if (present) confirmed.push(capability);
    else if (contradicts) missing.push(capability);
  };

  const hasTools = init.tools.length > 0;
  check('subagents', init.tools.includes('Task') || init.tools.includes('Agent'), hasTools);
  check('workflowTool', init.tools.includes('Workflow'), hasTools);
  // No servers configured is the usual case, so only a server confirms; it never contradicts
  check('mcp', init.mcpServers.length > 0, false);
  check('structuredOutput', init.structuredOutput, false);
  return { version: init.version, confirmed, missing };
}
