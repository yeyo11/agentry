import { acpHarness } from './acp-harness.ts';
import { driverConformance } from './conformance/suite.ts';

// The ACP driver on the opencode profile of the fake agent, through the conformance suite.
driverConformance('opencode', acpHarness('opencode'));
