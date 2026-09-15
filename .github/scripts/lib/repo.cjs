'use strict';

const headRepoOf = (pull) => String(pull?.head?.repo?.full_name ?? '');

function sameRepo(pull, fullName) {
  const head = headRepoOf(pull);
  return head !== '' && head.toLowerCase() === String(fullName ?? '').toLowerCase();
}

function headOrigin(pull) {
  const head = headRepoOf(pull);
  return head === '' ? 'a fork that no longer exists' : `\`${head}\``;
}

module.exports = { headOrigin, sameRepo };
