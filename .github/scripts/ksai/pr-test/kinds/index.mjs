import * as dockerCompose from './docker-compose.mjs';
import * as target from './target.mjs';

const modules = [dockerCompose, target];

export const moduleFor = (kind) => {
  const module = modules.find(
    (candidate) => candidate.kind === kind || (candidate.alsoImplements ?? []).includes(kind),
  );
  if (!module) throw new Error(`no module implements kind ${kind}`);
  return module;
};
