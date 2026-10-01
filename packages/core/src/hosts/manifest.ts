import type { CodeHostId } from '@agentry/shared';
import type { ProviderConfigHome } from '../providers/manifest.ts';

/**
 * How a code host's CLI says whether it is signed in. `hosts-json` is one call that lists every
 * host with its accounts (gh), so it also gives the CLI's own list of known hosts. `exit-code` is
 * one call per host that is read by its exit code only (glab): the status text goes to stderr and
 * is never parsed. The host is appended after `hostFlag`, and only a host the CLI already lists.
 */
export type CodeHostAuth =
  | { kind: 'hosts-json'; args: string[] }
  | { kind: 'exit-code'; args: string[]; hostFlag: string };

/**
 * The data half of a code host: everything detection and the adapter's checks need and nothing that
 * runs. One per folder in `hosts/<id>/manifest.ts`; the registry is the only place that lists them.
 */
export interface CodeHostManifest {
  id: CodeHostId;
  label: string;
  /** The binary name: the only CLI this host is reached through */
  cli: 'gh' | 'glab';
  versions: {
    /** Arguments that print the version */
    args: string[];
    /** The oldest release Agentry works with: below it a project cannot open change requests */
    minimum: string;
    /** The releases every fact in the adapter was recorded on */
    recorded: string[];
    /** What a release above `minimum` that is not in `recorded` reads as */
    untested: 'ready' | 'degraded';
  };
  auth: CodeHostAuth;
  /** Hosts matched without asking the CLI which it knows */
  defaultHosts: string[];
  /** The CLI's own configuration directory, watched for sign-ins */
  configHome: ProviderConfigHome;
  install: { url: string };
  /** The vendor's sign-in docs */
  signInUrl: string;
  /** The vendor's CLI documentation */
  docsUrl: string;
  /** How the host writes a change request's number: `#12` or `!12` */
  refPrefix: '#' | '!';
  changeRequestNoun: 'pull request' | 'merge request';
}
