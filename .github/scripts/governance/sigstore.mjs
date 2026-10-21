import sigstore from '../vendor/opencode-governance/sigstore.cjs';

export const { bundleFromJSON, TrustedRoot, Verifier, toSignedEntity, toTrustMaterial } = sigstore;
