const { bundleFromJSON } = require('@sigstore/bundle');
const { TrustedRoot } = require('@sigstore/protobuf-specs');
const { Verifier, toSignedEntity, toTrustMaterial } = require('@sigstore/verify');

module.exports = { bundleFromJSON, TrustedRoot, Verifier, toSignedEntity, toTrustMaterial };
