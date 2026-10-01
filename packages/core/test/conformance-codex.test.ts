import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { CoreConfig } from '../src/paths.ts';
import { CodexDriver } from '../src/providers/codex/driver.ts';
import { codexManifest } from '../src/providers/codex/manifest.ts';
import type { BranchTracker, DriverEvent, DriverSession, LaunchPlan, SessionIO, SessionLaunch, UserTurn } from '../src/providers/driver.ts';
import { driverConformance } from './conformance/suite.ts';

// The Codex driver through the conformance suite, on the fake app-server (fixtures/fake-codex-app-server.mjs),
// which replays what was recorded from codex-cli 0.159.3. The prompt's first word scripts the turn.

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const SLOW = 'SLOW holds the handshake back';
const SIGNED_OUT = 'SIGNEDOUT never gets this far';

/**
 * The fake answers the handshake at once and is signed in, so two cases need the harness's help: a
 * handshake that is slow (the turn is sent while it runs), and an account that is signed out (the
 * prompt cannot say so before the handshake that comes first). The probe sits between the process and
 * the driver and changes only when what the driver reads arrives, or what `account/read` says.
 */
class Probe implements DriverSession {
  private held: string[] | null = null;
  private signedOut = false;

  constructor(private readonly inner: DriverSession) {}

  send(turn: UserTurn): string {
    if (turn.text === SLOW) this.held = [];
    if (turn.text === SIGNED_OUT) this.signedOut = true;
    if (this.held) setTimeout(() => this.release(), 400).unref();
    return this.inner.send(turn);
  }

  private release(): void {
    const lines = this.held ?? [];
    this.held = null;
    for (const line of lines) this.inner.readLine(line);
  }

  readLine(line: string): void {
    let text = line;
    if (this.signedOut && line.includes('"requiresOpenaiAuth"')) {
      const message = JSON.parse(line) as { result?: Record<string, unknown> };
      if (message.result && 'requiresOpenaiAuth' in message.result) text = JSON.stringify({ ...message, result: { account: null, requiresOpenaiAuth: true } });
    }
    if (this.held) this.held.push(text);
    else this.inner.readLine(text);
  }

  interrupt = () => this.inner.interrupt();
  setOption: DriverSession['setOption'] = (option) => this.inner.setOption(option);
  answerPermission: DriverSession['answerPermission'] = (id, decision) => this.inner.answerPermission(id, decision);
  readError = (line: string) => this.inner.readError(line);
  endInput = () => this.inner.endInput();
  dispose = (reason: string) => this.inner.dispose(reason);
}

class FakeBackedCodex extends CodexDriver {
  constructor(private readonly state: string) {
    super(FAKE_CODEX);
  }

  /** Threads live in a file, so a later process can resume or fork one an earlier process made */
  override launch(spec: SessionLaunch): LaunchPlan {
    const plan = super.launch(spec);
    return { ...plan, env: { ...plan.env, FAKE_CODEX_STATE: this.state } };
  }

  override attach(io: SessionIO, sink: (event: DriverEvent) => void, branches: BranchTracker): DriverSession {
    return new Probe(super.attach(io, sink, branches));
  }
}

driverConformance('codex', {
  manifest: codexManifest,
  driver: (config: CoreConfig) => new FakeBackedCodex(join(config.dataDir, 'fake-codex-threads.json')),
  script: {
    turn: 'TURN hello',
    ask: () => 'ASK command',
    unexpected: 'ODD',
    // Codex reports no budget and no cost: the case is skipped, the script is never sent
    budget: 'TURN budget',
    rateLimit: 'RATE',
    structured: 'STRUCTURED {"verdict":"pass","notes":["a","b"]}',
    noisy: 'NOISY',
    delegating: 'DELEGATE look around',
    slowHandshake: SLOW,
    gitPush: 'GITPUSH',
    holdUntilCancel: 'ASK command',
    signedOut: SIGNED_OUT,
  },
  structuredResult: { verdict: 'pass', notes: ['a', 'b'] },
  decision: (result) => (/^declined/.test(result) ? 'deny' : /^(done|pushed)/.test(result) ? 'allow' : null),
  stderrText: 'ERROR codex_core::something: a log line, not a protocol message',
});
