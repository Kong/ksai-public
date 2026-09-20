'use strict';

const { canonicalJson } = require('./json.cjs');

const TYPE = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const SCHEMA_KEYWORDS = Object.freeze([
  '$schema', '$id', '$defs', '$ref', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'maxItems', 'maxProperties', 'uniqueItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'allOf', 'anyOf', 'oneOf',
  'description', 'title', 'default', 'examples', 'format',
]);
const KEYWORDS = new Set(SCHEMA_KEYWORDS);
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

function overCodePoints(value, limit) {
  if (value.length <= limit) return false;
  if (value.length > limit * 2) return true;
  let count = 0;
  for (const at of value) {
    count += Math.min(at.length, 1);
    if (count > limit) return true;
  }
  return false;
}

function pointer(root, fragment, reference) {
  if (fragment === '' || fragment === '#') return root;
  if (!fragment.startsWith('#/')) throw new Error(`schema reference ${reference} is not a JSON Pointer`);
  let held = root;
  for (const raw of fragment.slice(2).split('/')) {
    if (/~(?:[^01]|$)/u.test(raw)) throw new Error(`schema reference ${reference} has an invalid JSON Pointer escape`);
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if ((!object(held) && !Array.isArray(held)) || !Object.hasOwn(held, key)) {
      throw new Error(`schema reference ${reference} does not resolve`);
    }
    held = held[key];
  }
  return held;
}

function referenced(root, reference, path, resolveReference) {
  if (typeof reference !== 'string') throw new Error(`${path} schema $ref is not a string`);
  if (reference.startsWith('#')) return { schema: pointer(root, reference, reference), root, path };
  if (!resolveReference) throw new Error(`schema reference ${reference} is not local`);
  const marker = reference.indexOf('#');
  const relative = marker === -1 ? reference : reference.slice(0, marker);
  const fragment = marker === -1 ? '' : reference.slice(marker);
  const resolved = resolveReference(relative, path);
  return { schema: pointer(resolved.schema, fragment, reference), root: resolved.schema, path: resolved.path };
}

function assertInteger(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${where} is not a non-negative integer`);
}

function inspect(schema, root, path, resolveReference, seen, resourceRoot, idBase) {
  if (typeof schema === 'boolean') return;
  if (!object(schema)) throw new Error(`${path} schema is not an object or boolean`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${path} schema uses unsupported keyword ${key}`);
  }
  if (schema.$schema !== undefined && schema.$schema !== DIALECT) throw new Error(`${path} schema dialect is unsupported`);
  if (schema.$id !== undefined && typeof schema.$id !== 'string') throw new Error(`${path} schema $id is not a string`);
  if (schema.$id !== undefined && !resourceRoot) throw new Error(`${path} schema uses unsupported nested $id`);
  const ownsIdBase = idBase || schema.$id !== undefined;
  if (schema.$ref !== undefined) {
    if (ownsIdBase && typeof schema.$ref === 'string' && !schema.$ref.startsWith('#')) {
      throw new Error(`${path} schema uses unsupported package-file $ref under $id`);
    }
    const target = referenced(root, schema.$ref, path, resolveReference);
    const identity = `${target.path}\0${schema.$ref}`;
    if (!seen.has(identity)) inspect(
      target.schema, target.root, target.path, resolveReference,
      new Set([...seen, identity]), target.schema === target.root, ownsIdBase,
    );
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if ((schema.type !== undefined && types.length === 0)
    || types.some((type) => !TYPE.has(type)) || new Set(types).size !== types.length) {
    throw new Error(`${path} schema names an unsupported or duplicated type`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) throw new Error(`${path} schema enum is empty`);
  if (schema.required !== undefined && (!Array.isArray(schema.required)
    || schema.required.some((key) => typeof key !== 'string')
    || new Set(schema.required).size !== schema.required.length)) throw new Error(`${path} schema required is invalid`);
  for (const keyword of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (schema[keyword] !== undefined) assertInteger(schema[keyword], `${path} schema ${keyword}`);
  }
  if (schema.minItems > schema.maxItems || schema.minLength > schema.maxLength) throw new Error(`${path} schema minimum exceeds its maximum`);
  for (const keyword of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== 'number') throw new Error(`${path} schema ${keyword} is not a number`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') throw new Error(`${path} schema pattern is not a string`);
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      throw new Error(`${path} schema pattern is invalid`);
    }
  }
  for (const keyword of ['description', 'title', 'format']) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== 'string') throw new Error(`${path} schema ${keyword} is not a string`);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) throw new Error(`${path} schema ${keyword} is empty`);
    schema[keyword].forEach((branch) => inspect(branch, root, path, resolveReference, seen, false, ownsIdBase));
  }
  for (const keyword of ['$defs', 'properties']) {
    if (schema[keyword] === undefined) continue;
    if (!object(schema[keyword])) throw new Error(`${path} schema ${keyword} is invalid`);
    for (const branch of Object.values(schema[keyword])) inspect(branch, root, path, resolveReference, seen, false, ownsIdBase);
  }
  for (const keyword of ['items', 'additionalProperties']) {
    if (schema[keyword] !== undefined) inspect(schema[keyword], root, path, resolveReference, seen, false, ownsIdBase);
  }
}

/** Check every supported local schema keyword, including branches fixtures do not reach. */
function validateSchemaDefinition(schema) {
  inspect(schema, schema, 'schema', undefined, new Set(['schema\0#']), true, false);
}

/** Check a schema closure with package-relative references. */
function validateSchemaDefinitionWithReferences(schema, path, resolveReference) {
  inspect(schema, schema, path, resolveReference, new Set([`${path}\0#`]), true, false);
}

/** List every schema ID in one document, including IDs on nested subschemas. */
function collectSchemaIds(schema, path = 'schema') {
  const found = [];
  const walk = (held, location) => {
    if (typeof held === 'boolean') return;
    if (held.$id !== undefined) found.push({ id: held.$id, location });
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      (held[keyword] ?? []).forEach((branch, index) => walk(branch, `${location}/${keyword}/${index}`));
    }
    for (const keyword of ['$defs', 'properties']) {
      for (const [name, branch] of Object.entries(held[keyword] ?? {})) {
        const token = name.replace(/~/gu, '~0').replace(/\//gu, '~1');
        walk(branch, `${location}/${keyword}/${token}`);
      }
    }
    for (const keyword of ['items', 'additionalProperties']) {
      if (held[keyword] !== undefined) walk(held[keyword], `${location}/${keyword}`);
    }
  };
  walk(schema, path);
  return found;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(schema, value, root, path, where, problems, seen, resolveReference) {
  if (schema === true) return false;
  if (schema === false) {
    problems.push(`${where} is forbidden by its schema`);
    return false;
  }
  if (!object(schema)) throw new Error(`${where} schema is not an object or boolean`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${where} schema uses unsupported keyword ${key}`);
  }
  let blocked = false;
  if (schema.$ref !== undefined) {
    const target = referenced(root, schema.$ref, path, resolveReference);
    const identity = `${target.path}\0${schema.$ref}\0${where}`;
    if (seen.has(identity)) blocked = true;
    else if (check(
      target.schema, value, target.root, target.path, where, problems,
      new Set([...seen, identity]), resolveReference,
    )) blocked = true;
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some((type) => !TYPE.has(type))) throw new Error(`${where} schema names an unsupported type`);
  const actual = typeOf(value);
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
    problems.push(`${where} must be ${types.join(' or ')}`);
    return blocked;
  }
  if (Array.isArray(schema.enum)) {
    const held = canonicalJson(value);
    if (!schema.enum.some((one) => canonicalJson(one) === held)) problems.push(`${where} is not an allowed value`);
  }
  if (Object.hasOwn(schema, 'const') && !same(schema.const, value)) problems.push(`${where} is not the required value`);

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) throw new Error(`${where} schema ${keyword} is empty`);
    const outcomes = schema[keyword].map((branch) => {
      const held = [];
      const branchBlocked = check(branch, value, root, path, where, held, seen, resolveReference);
      return { blocked: branchBlocked, problems: held };
    });
    if (keyword === 'allOf') outcomes.flatMap((outcome) => outcome.problems).forEach((problem) => problems.push(problem));
    const matches = outcomes.filter((outcome) => !outcome.blocked && outcome.problems.length === 0).length;
    if (keyword === 'anyOf' && matches === 0) problems.push(`${where} matches no allowed schema`);
    if (keyword === 'oneOf' && matches !== 1) problems.push(`${where} does not match exactly one schema`);
    if (outcomes.some((outcome) => outcome.blocked)) blocked = true;
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength * 2 && [...value].length < schema.minLength) problems.push(`${where} is too short`);
    if (Number.isInteger(schema.maxLength) && overCodePoints(value, schema.maxLength)) problems.push(`${where} is too long`);
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
    if (schema.uniqueItems === true && new Set(value.map((one) => canonicalJson(one))).size !== value.length) problems.push(`${where} repeats an item`);
    if (schema.items !== undefined) value.forEach((item, index) => {
      if (check(schema.items, item, root, path, `${where}[${index}]`, problems, seen, resolveReference)) blocked = true;
    });
  }
  if (object(value)) {
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) problems.push(`${where} carries too many properties`);
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) throw new Error(`${where} schema required is invalid`);
    for (const key of required) if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is required`);
    const properties = schema.properties ?? {};
    if (!object(properties)) throw new Error(`${where} schema properties is invalid`);
    for (const [key, held] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (check(properties[key], held, root, path, `${where}.${key}`, problems, seen, resolveReference)) blocked = true;
      }
      else if (schema.additionalProperties === false) problems.push(`${where}.${key} is not declared`);
      else if (object(schema.additionalProperties) || typeof schema.additionalProperties === 'boolean') {
        blocked = check(
          schema.additionalProperties, held, root, path, `${where}.${key}`, problems, seen, resolveReference,
        ) || blocked;
      }
    }
  }
  return blocked;
}

/** Validate a value against the dependency-free runner schema subset. */
function validateSchema(schema, value, where = 'output') {
  const problems = [];
  check(schema, value, schema, 'schema', where, problems, new Set(['schema\0#']), undefined);
  return problems;
}

/** Validate a value against a package-relative schema closure. */
function validateSchemaWithReferences(schema, value, where, path, resolveReference) {
  const problems = [];
  check(schema, value, schema, path, where, problems, new Set([`${path}\0#`]), resolveReference);
  return problems;
}

module.exports = { SCHEMA_KEYWORDS, collectSchemaIds, validateSchema, validateSchemaDefinition, validateSchemaDefinitionWithReferences, validateSchemaWithReferences };
