const shipped = require('./model-catalog.json');

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const MODEL = new RegExp(`^${SEGMENT}(/${SEGMENT}){0,2}$`);

const MAX_MODELS = 200;

const rate = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function modelsOf(served) {
  if (!object(served) || !Array.isArray(served.models)) return null;
  if (served.models.length === 0 || served.models.length > MAX_MODELS) return null;
  if (served.tiers !== undefined && !Array.isArray(served.tiers)) return null;

  const held = [];
  const named = new Set();
  for (const model of served.models) {
    if (!object(model)) return null;

    const id = String(model.id ?? '');
    const input = rate(model.input);
    const output = rate(model.output);
    if (!MODEL.test(id) || input === null || output === null) return null;

    const aliases = model.aliases === undefined ? [] : model.aliases;
    if (!Array.isArray(aliases) || aliases.some((one) => !MODEL.test(String(one ?? '')))) return null;

    const cacheRead = model.cache_read === undefined ? null : rate(model.cache_read);
    if (model.cache_read !== undefined && cacheRead === null) return null;

    if (model.opencode !== undefined && !object(model.opencode)) return null;

    for (const name of [id, ...aliases]) {
      const key = String(name).toLowerCase();
      if (named.has(key)) return null;
      named.add(key);
    }

    held.push({
      id,
      tier: typeof model.tier === 'string' ? model.tier : '',
      aliases: aliases.map(String),
      input,
      output,
      cacheRead,
      effort: typeof model.effort === 'string' ? model.effort : '',
      opencode: model.opencode === undefined ? null : model.opencode,
    });
  }

    const runnable = new Set(
    held.filter((model) => model.opencode !== null).map((model) => model.id.toLowerCase()),
  );
  for (const id of Object.values(shipped.aliases ?? {})) {
    if (!runnable.has(String(id).toLowerCase())) return null;
  }

  return held;
}

function catalogOf(models, tiers) {
  const modelTiers = Object.create(null);
  const vendorAliases = Object.create(null);
  const rates = Object.create(null);
  const opencodeModels = Object.create(null);
  const defaultEfforts = Object.create(null);
  const knownModels = [];
  const allowedModels = [];
  const claudeModels = [];

  for (const model of models) {
    if (model.tier !== '') modelTiers[model.id] = model.tier;
    if (model.effort !== '') defaultEfforts[model.id] = model.effort;
    for (const alias of model.aliases) vendorAliases[alias] = model.id;

    rates[model.id] = {
      input: model.input,
      output: model.output,
      ...(model.cacheRead === null ? {} : { cacheRead: model.cacheRead }),
    };

    knownModels.push(model.id);
    if (model.opencode !== null) {
      allowedModels.push(model.id);
      if (Object.keys(model.opencode).length > 0) opencodeModels[model.id] = model.opencode;
    }
    if (model.id.startsWith('claude-')) claudeModels.push(model.id);
  }

  const vendorTiers = Object.create(null);
  for (const [alias, id] of Object.entries(vendorAliases)) {
    if (modelTiers[id] !== undefined) vendorTiers[alias] = modelTiers[id];
  }

  const order = Array.isArray(tiers) && tiers.length > 0 ? tiers.map(String) : shipped.tierOrder;

  return {
    ...shipped,
    tierOrder: order,
    modelTiers,
    vendorAliases,
    vendorTiers,
    legacyModelIds: vendorAliases,
    rates,
    opencodeModels,
    defaultEfforts,
    knownModels,
    allowedModels,
    claudeModels,
  };
}

function read(env = process.env, load = require) {
  const at = String(env.KSAI_MODEL_CATALOG ?? '').trim();
  if (at === '') return { ...shipped };

  let served;
  try {
    served = load(at);
  } catch {
    return { ...shipped };
  }

  const models = modelsOf(served);
  return models === null ? { ...shipped } : catalogOf(models, served.tiers);
}

const catalog = read();

for (const [name, held] of Object.entries({ read, modelsOf, catalogOf, shipped })) {
  Object.defineProperty(catalog, name, { value: held, enumerable: false });
}

module.exports = catalog;
