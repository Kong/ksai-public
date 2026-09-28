export const PROVIDER = 'anthropic';

const tokens = (value) => Number.isInteger(value) && value > 0;

const price = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

export function modelInfo(model) {
  const limit = model?.limit;
  if (typeof model?.id !== 'string' || !model.id || !tokens(limit?.context) || !tokens(limit?.output)) {
    throw new Error('the plan names no model with the limits it reads and answers with');
  }
  const variants = Array.isArray(model.variants) ? model.variants : [];
  return {
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER,
    name: typeof model.name === 'string' && model.name ? model.name : model.id,
    capabilities: { tools: true, input: model.image === true ? ['text', 'image'] : ['text'], output: ['text'] },
    variants: variants
      .filter((one) => typeof one?.id === 'string' && one.id)
      .map((one) => (one.settings && typeof one.settings === 'object' ? { id: one.id, settings: one.settings } : { id: one.id })),
    time: { released: 0 },
    cost: [{ input: price(model.cost?.input), output: price(model.cost?.output), cache: { read: price(model.cost?.cache_read), write: price(model.cost?.cache_write) } }],
    status: 'active',
    enabled: true,
    limit: { context: limit.context, output: limit.output },
  };
}

export async function serve(ctx, given) {
  const model = modelInfo(given);
  await ctx.provider.transform((editor) => editor.models.set(PROVIDER, [model]));
  return model;
}

export function capped(model) {
  return (event) => {
    if (event.model?.id === model.id && event.options) event.options.maxTokens = Math.min(model.limit.output, Number(event.options.maxTokens) || model.limit.output);
  };
}
