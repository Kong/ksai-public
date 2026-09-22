const CURRENT_PATH = '/v1/run/settings';
const FORMER_PATH = '/fleetconfig';

export async function fetchRunSettings(fetch, endpoint, options) {
  const root = endpoint.replace(/\/+$/, '');
  const current = await fetch(`${root}${CURRENT_PATH}`, options);
  if (current.status !== 404) return current;
  return fetch(`${root}${FORMER_PATH}`, options);
}
