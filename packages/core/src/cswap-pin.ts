import { compareVersions } from './version-check.ts';

/**
 * The claude-swap Agentry installs, and the versions whose `--json` output it parses. The Dockerfile's
 * `CLAUDE_SWAP_VERSION` default has to equal `CSWAP_VERSION` (the packaging test checks it): a new
 * release that reshapes that output would otherwise break the accounts page without a word.
 */
export const CSWAP_VERSION = '0.26.0';
/** Inclusive lower bound, exclusive upper bound */
export const CSWAP_COMPATIBLE = { min: '0.26.0', below: '0.27.0' } as const;

/**
 * The uv release the managed install downloads. Its digests come from the `.sha256` file GitHub
 * publishes beside each asset; bump the version and the digests together.
 */
export const UV_VERSION = '0.12.18';
const UV_ASSETS: Record<string, { target: string; sha256: string }> = {
  'linux-x64': { target: 'x86_64-unknown-linux-gnu', sha256: '89eadd7c76fc063887959510d5ba0ab1264dfd5f1143b925ddb73021a40acf16' },
  'linux-arm64': { target: 'aarch64-unknown-linux-gnu', sha256: 'afb6291f3f0a6b4521fc67b947822506c41dde5b60d2189dd8f3695b2ac8c9e7' },
};

export interface UvAsset {
  url: string;
  sha256: string;
  /** Directory the archive unpacks into */
  dir: string;
}

/** The uv archive for this platform, or null where there is no pinned build. */
export function uvAsset(platform: string = process.platform, arch: string = process.arch): UvAsset | null {
  const asset = UV_ASSETS[`${platform}-${arch}`];
  if (!asset) return null;
  const dir = `uv-${asset.target}`;
  return { url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${dir}.tar.gz`, sha256: asset.sha256, dir };
}

export function cswapCompatible(version: string | null): boolean {
  if (!version) return false;
  return compareVersions(version, CSWAP_COMPATIBLE.min) >= 0 && compareVersions(version, CSWAP_COMPATIBLE.below) < 0;
}
