import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import lock from '../vendor/opencode-governance/package-lock.json' with { type: 'json' };

const PACKAGES = ['@sigstore/bundle', '@sigstore/protobuf-specs', '@sigstore/verify'];

function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(new URL(`../vendor/opencode-governance/node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    throw new Error(`${name} is not installed: run \`mise run install\` to put the governance vendor where this reads it`, { cause: error });
  }
}

for (const name of PACKAGES) {
  const locked = lock.packages?.[`node_modules/${name}`]?.version;
  const installed = installedVersion(name);
  if (!locked || installed !== locked) {
    throw new Error(`${name} ${installed} is installed where the governance lock pins ${locked ?? 'nothing'}`);
  }
}

const vendored = createRequire(new URL('../vendor/opencode-governance/package.json', import.meta.url));

export const { bundleFromJSON } = vendored('@sigstore/bundle');
export const { TrustedRoot } = vendored('@sigstore/protobuf-specs');
export const { Verifier, toSignedEntity, toTrustMaterial } = vendored('@sigstore/verify');
