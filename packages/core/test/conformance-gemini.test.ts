import { acpHarness } from './acp-harness.ts';
import { driverConformance } from './conformance/suite.ts';

// The ACP driver on the gemini profile of the fake agent, through the conformance suite.
driverConformance('gemini', acpHarness('gemini'));
