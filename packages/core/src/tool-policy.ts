import type { PolicyTranslation, ProviderId, ToolPolicy } from '@agentry/shared';
import { translationFor } from './providers/registry.ts';

/** The rules a run starts with, in its provider's own terms. */
export type ProviderRules = PolicyTranslation['rules'];

/** A policy names a part the provider cannot enforce, so a run that relies on it must not start. */
export class PolicyUnsupportedError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly unsupported: string[],
  ) {
    super(`${provider} cannot enforce this policy: ${unsupported.join(', ')}`);
    this.name = 'PolicyUnsupportedError';
  }
}

/**
 * The one neutral entry point: a policy as the provider's rules, with the person's native rules
 * appended after it. Throws when the provider lists a part as unsupported, or has no driver.
 */
export function rulesFor(
  provider: ProviderId,
  policy: ToolPolicy,
  native: { allowedTools?: readonly string[]; disallowedTools?: readonly string[] } = {},
): ProviderRules {
  const translate = translationFor(provider);
  if (!translate) throw new PolicyUnsupportedError(provider, ['provider']);
  const { rules, unsupported } = translate(policy);
  if (unsupported.length > 0) throw new PolicyUnsupportedError(provider, unsupported);
  const out: ProviderRules = {
    allowedTools: [...new Set([...rules.allowedTools, ...(native.allowedTools ?? [])])],
    disallowedTools: [...new Set([...rules.disallowedTools, ...(native.disallowedTools ?? [])])],
  };
  if (rules.tools) out.tools = rules.tools;
  return out;
}

/**
 * A policy as the rules of the driver that runs it: what a run starts with, or moves to, on any provider
 * that has a driver. `rulesFor` is the pure entry for the providers whose translation is registered
 * without a runtime (Claude Code); this one asks the driver, which is the translation the candidates
 * weigh, so what the filter let through is what the launch enforces.
 */
export function rulesOnDriver(driver: { translatePolicy(policy: ToolPolicy): PolicyTranslation }, provider: ProviderId, policy: ToolPolicy): ProviderRules {
  const { rules, unsupported } = driver.translatePolicy(policy);
  if (unsupported.length > 0) throw new PolicyUnsupportedError(provider, unsupported);
  return rules;
}
