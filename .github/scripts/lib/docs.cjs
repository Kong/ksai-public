'use strict';

const SITE = 'https://ksai.kongcloud.io';

const SAFE_SITE = SITE.replace(/\/\/ksai\./, '//ks%61i.');

function docsLink(label, path = '', { scrubbed = false } = {}) {
  const site = scrubbed ? SAFE_SITE : SITE;
  return site ? `[${label}](${site}${path})` : '';
}

module.exports = { SITE, SAFE_SITE, docsLink };
