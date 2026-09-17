'use strict';

function bareEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint ?? ''));
  } catch {
    return false;
  }

  return url.protocol === 'https:' && url.hostname !== '' && url.search === '' && url.hash === ''
    && url.username === '' && url.password === '';
}

module.exports = { bareEndpoint };
