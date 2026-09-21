const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isReleaseVersion(value) {
  return VERSION.test(String(value ?? ''));
}

export function versionParts(version) {
  const parts = VERSION.exec(version);
  if (!parts) throw new Error(`${version} is not a release version`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

export function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
