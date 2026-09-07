'use strict';

const warningFor = (write) => (line) => write(`::warning::${String(line).replace(/\r?\n/g, ' ')}`);

const warn = warningFor((said) => process.stderr.write(`${said}\n`));

module.exports = { warn, warningFor };
