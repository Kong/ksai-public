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
    const cacheWrite = model.cache_write === undefined ? null : rate(model.cache_write);
    if (model.cache_write !== undefined && cacheWrite === null) return null;

    if (model.runnable !== undefined && typeof model.runnable !== 'boolean') return null;
    const variants = model.variants === undefined ? [] : model.variants;
    if (!Array.isArray(variants) || variants.some((one) => !object(one) || typeof one.id !== 'string')) return null;

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
      cacheWrite,
      effort: typeof model.effort === 'string' ? model.effort : '',
      runnable: model.runnable === true,
      efforts: variants.map((one) => one.id),
    });
  }

  const runnable = new Set(held.filter((model) => model.runnable).map((model) => model.id.toLowerCase()));
  for (const id of Object.values(shipped.aliases ?? {})) {
    if (!runnable.has(String(id).toLowerCase())) return null;
  }

  return held;
}

function catalogOf(models, tiers) {
  const modelTiers = Object.create(null);
  const vendorAliases = Object.create(null);
  const rates = Object.create(null);
  const modelEfforts = Object.create(null);
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
      ...(model.cacheWrite === null ? {} : { cacheWrite: model.cacheWrite }),
    };

    knownModels.push(model.id);
    if (model.runnable) {
      allowedModels.push(model.id);
      modelEfforts[model.id] = model.efforts;
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
    modelEfforts,
    defaultEfforts,
    knownModels,
    allowedModels,
    claudeModels,
  };
}

function read(env = process.env, load = require) {
  const at = String(env.KSAI_MODEL_CATALOG ?? '').trim();
  const inline = String(env.KSAI_MODEL_CATALOG_JSON ?? '').trim();
  if (at === '' && inline === '') return { ...shipped };

  let served;
  try {
    served = at === '' ? JSON.parse(inline) : load(at);
  } catch {
    return { ...shipped };
  }

  const models = modelsOf(served);
  return models === null ? { ...shipped } : catalogOf(models, served.tiers);
}

module.exports = read();
Object.defineProperty(module.exports, 'read', { value: read, enumerable: false });
Object.defineProperty(module.exports, 'modelsOf', { value: modelsOf, enumerable: false });
Object.defineProperty(module.exports, 'catalogOf', { value: catalogOf, enumerable: false });
Object.defineProperty(module.exports, 'shipped', { value: shipped, enumerable: false });
Object.defineProperty(module.exports, 'rate', { value: rate, enumerable: false });
