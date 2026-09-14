import { canonicalJson } from './json.mjs';

const TYPE = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'allOf', 'anyOf', 'oneOf',
  'description', 'title', 'default', 'examples', 'format',
]);

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

function pointer(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new Error(`schema reference ${ref} is not local`);
  let held = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!object(held) || !Object.hasOwn(held, key)) throw new Error(`schema reference ${ref} does not resolve`);
    held = held[key];
  }
  return held;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(schema, value, root, where, problems, seen) {
  if (schema === true) return;
  if (schema === false) {
    problems.push(`${where} is forbidden by its schema`);
    return;
  }
  if (!object(schema)) throw new Error(`${where} schema is not an object or boolean`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${where} schema uses unsupported keyword ${key}`);
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string') throw new Error(`${where} schema $ref is not a string`);
    const target = pointer(root, schema.$ref);
    if (seen.has(target)) return;
    check(target, value, root, where, problems, new Set([...seen, target]));
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((type) => !TYPE.has(type))) throw new Error(`${where} schema names an unsupported type`);
  const actual = typeOf(value);
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
    problems.push(`${where} must be ${types.join(' or ')}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((one) => same(one, value))) problems.push(`${where} is not an allowed value`);
  if (Object.hasOwn(schema, 'const') && !same(schema.const, value)) problems.push(`${where} is not the required value`);

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) throw new Error(`${where} schema ${keyword} is empty`);
    const outcomes = schema[keyword].map((branch) => {
      const held = [];
      check(branch, value, root, where, held, seen);
      return held;
    });
    if (keyword === 'allOf') outcomes.flat().forEach((problem) => problems.push(problem));
    if (keyword === 'anyOf' && outcomes.every((held) => held.length)) problems.push(`${where} matches no allowed schema`);
    if (keyword === 'oneOf' && outcomes.filter((held) => held.length === 0).length !== 1) problems.push(`${where} does not match exactly one schema`);
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && [...value].length < schema.minLength) problems.push(`${where} is too short`);
    if (Number.isInteger(schema.maxLength) && [...value].length > schema.maxLength) problems.push(`${where} is too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${where} does not match its pattern`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${where} is below its minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${where} is above its maximum`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) problems.push(`${where} is not above its minimum`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) problems.push(`${where} is not below its maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) problems.push(`${where} has too few items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) problems.push(`${where} has too many items`);
    if (schema.items !== undefined) value.forEach((item, index) => check(schema.items, item, root, `${where}[${index}]`, problems, seen));
  }
  if (object(value)) {
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) throw new Error(`${where} schema required is invalid`);
    for (const key of required) if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is required`);
    const properties = schema.properties ?? {};
    if (!object(properties)) throw new Error(`${where} schema properties is invalid`);
    for (const [key, held] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) check(properties[key], held, root, `${where}.${key}`, problems, seen);
      else if (schema.additionalProperties === false) problems.push(`${where}.${key} is not declared`);
      else if (object(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
        check(schema.additionalProperties, held, root, `${where}.${key}`, problems, seen);
      }
    }
  }
}

/** Validate a value against the dependency-free runner schema subset. */
export function validateSchema(schema, value, where = 'output') {
  const problems = [];
  check(schema, value, schema, where, problems, new Set([schema]));
  return problems;
}
