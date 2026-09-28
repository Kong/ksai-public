import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { validateSchema } = require('./json-schema.cjs');

export const VERSION = 1;
export const PAYLOAD_TYPE = 'application/vnd.ksai.link.v1+json';
export const SUBPROTOCOL = 'ksai.link.v1';
export const MAX_FRAME = 8 << 20;
export const PARTIES = Object.freeze(['engine', 'host', 'plugin']);

const MAX_DEPTH = 32;
const SCHEMAS = fileURLToPath(new URL('./link-schemas/v1', import.meta.url));
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const LINK = /^[a-z0-9][a-z0-9-]{7,63}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_KEYS = ['payloadType', 'payload', 'signatures'];
const MESSAGE_KEYS = ['v', 'link', 'job', 'epoch', 'from', 'to', 'seq', 'ack', 'id', 'kind', 'body'];

const NAMED = new Set([
  'engine>host:need',
  'engine>host:session.start',
  'engine>host:task',
  'engine>host:kill',
  'engine>host:done',
  'engine>plugin:plan',
  'engine>plugin:note',
  'engine>plugin:stop',
  'engine>plugin:stop.enforce',
  'engine>plugin:interrupt',
  'engine>plugin:retry.answer',
  'host>engine:facts',
  'host>engine:credential',
  'host>engine:task.result',
  'host>engine:session.started',
  'host>engine:session.ended',
  'plugin>engine:retry.ask',
  'plugin>engine:note.delivered',
]);

const EPHEMERAL = new Set([
  'engine>host:welcome',
  'engine>host:lease',
  'engine>host:reconnect',
  'host>engine:hello',
  'host>engine:proof',
  'host>engine:ping',
  'host>engine:bye',
]);

export class LinkRefused extends Error {}

const refused = (why) => new LinkRefused(`link: refused: ${why}`);

const routeOf = (from, to, kind) => `${from}>${to}:${kind}`;

function loadRoutes() {
  const held = Object.create(null);
  for (const file of readdirSync(SCHEMAS).filter((name) => name.endsWith('.json')).sort()) {
    const name = file.slice(0, -'.json'.length);
    const dot = name.indexOf('.');
    const [from, to] = name.slice(0, dot).split('-');
    const kind = name.slice(dot + 1);
    const key = routeOf(from, to, kind);
    held[key] = Object.freeze({
      from, to, kind, named: NAMED.has(key), ephemeral: EPHEMERAL.has(key), schema: JSON.parse(readFileSync(join(SCHEMAS, file), 'utf8')),
    });
  }
  for (const key of [...NAMED, ...EPHEMERAL]) {
    if (!held[key]) throw new Error(`link: ${key} is listed and has no schema`);
  }
  return Object.freeze(held);
}

const ROUTES = loadRoutes();

export const routes = () => Object.values(ROUTES).map(({ from, to, kind, named, ephemeral }) => ({ from, to, kind, named, ephemeral }));

export function privateKeyOf(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('link: an ed25519 seed is 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
}

export function publicKeyOf(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('link: an ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKey(key) {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export const keyId = (raw) => createHash('sha256').update(raw).digest('hex');

export const linkId = ({ repository, runId, attempt, job }) =>
  `link-${createHash('sha256').update(`${String(repository).toLowerCase()}/${runId}/${attempt}/${job}`).digest('hex').slice(0, 24)}`;

export function pae(payloadType, payload) {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${payload.length} `), payload]);
}

function depthOf(value, depth = 0) {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) return value.reduce((most, one) => Math.max(most, depthOf(one, depth + 1)), depth + 1);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((most, one) => Math.max(most, depthOf(one, depth + 1)), depth + 1);
  }
  return depth;
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function only(value, keys, what) {
  if (!plainObject(value)) throw refused(`${what} is not an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw refused(`${what} has a field ${JSON.stringify(key)} it does not name`);
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;

export const relayed = (from, to) => from === 'plugin' || to === 'plugin';

function check(message) {
  if (message.v !== VERSION) throw refused(`the message is version ${message.v}`);
  if (typeof message.link !== 'string' || !LINK.test(message.link)) throw refused(`the link ${JSON.stringify(message.link)} is not a link name`);
  if (typeof message.job !== 'string' || !JOB.test(message.job)) throw refused(`the job ${JSON.stringify(message.job)} is not a job name`);
  const carried = relayed(message.from, message.to);
  if (!count(message.epoch) || carried !== (message.epoch === 0)) {
    throw refused(carried ? `a message the host relays carries epoch 0, not ${message.epoch}` : `the epoch is ${message.epoch}`);
  }
  if (!count(message.seq)) throw refused(`the seq is ${message.seq}`);
  if (!count(message.ack)) throw refused(`the ack is ${message.ack}`);
  const route = ROUTES[routeOf(message.from, message.to, message.kind)];
  if (!route) throw refused(`${message.from} does not send ${message.to} ${JSON.stringify(message.kind)}`);
  if (route.ephemeral !== (message.seq === 0)) {
    throw refused(route.ephemeral
      ? `${message.kind} keeps the connection going and carries seq 0, not ${message.seq}`
      : `${message.kind} is applied in order and carries a seq from 1`);
  }
  const id = message.id ?? '';
  if (route.named !== (id !== '')) {
    throw refused(route.named ? `${message.kind} names no id` : `${message.kind} names id ${JSON.stringify(id)}, and it is not a message that answers to one`);
  }
  if (id !== '' && (typeof id !== 'string' || !ID.test(id))) throw refused(`the id ${JSON.stringify(id)} is not a message id`);
  const problems = validateSchema(route.schema, message.body, 'body');
  if (problems.length) throw refused(`${message.from} ${message.kind}: ${problems.join('; ')}`);
}

export function sign(privateKey, message) {
  check(message);
  const { id, ...rest } = message;
  const ordered = { v: rest.v, link: rest.link, job: rest.job, epoch: rest.epoch, from: rest.from, to: rest.to, seq: rest.seq, ack: rest.ack };
  const payload = Buffer.from(JSON.stringify({ ...ordered, ...(id ? { id } : {}), kind: rest.kind, body: rest.body }), 'utf8');
  const raw = rawPublicKey(privateKey);
  const frame = JSON.stringify({
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: keyId(raw), sig: signBytes(null, pae(PAYLOAD_TYPE, payload), privateKey).toString('base64') }],
  });
  if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error(`link: ${message.kind} is ${Buffer.byteLength(frame)} bytes, over the ${MAX_FRAME} a frame may carry`);
  return frame;
}

function decodedBase64(value, what) {
  if (typeof value !== 'string' || !BASE64.test(value)) throw refused(`${what} is not base64`);
  return Buffer.from(value, 'base64');
}

export function open(frame, want) {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(String(frame), 'utf8');
  if (bytes.length > MAX_FRAME) throw refused(`the frame is ${bytes.length} bytes, over the ${MAX_FRAME} a frame may carry`);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let envelope;
  try {
    envelope = JSON.parse(text.decode(bytes));
  } catch (error) {
    throw refused(`the frame is not an envelope: ${error.message}`);
  }
  only(envelope, ENVELOPE_KEYS, 'the envelope');
  if (envelope.payloadType !== PAYLOAD_TYPE) throw refused(`the payload type is ${JSON.stringify(envelope.payloadType)}`);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw refused(`the envelope carries ${Array.isArray(envelope.signatures) ? envelope.signatures.length : 'no'} signatures, and a link message carries one`);
  }
  const [signature] = envelope.signatures;
  only(signature, ['keyid', 'sig'], 'the signature');
  const signer = want.signers?.[signature.keyid];
  if (!signer) throw refused(`the envelope is signed by ${JSON.stringify(signature.keyid)}, which this link does not know`);
  const payload = decodedBase64(envelope.payload, 'the payload');
  const sig = decodedBase64(signature.sig, 'the signature');
  if (!verifyBytes(null, pae(PAYLOAD_TYPE, payload), signer.key, sig)) throw refused('the signature does not verify');
  let message;
  try {
    message = JSON.parse(text.decode(payload));
  } catch (error) {
    throw refused(`the payload is not a message: ${error.message}`);
  }
  if (depthOf(message) > MAX_DEPTH) throw refused(`the payload nests deeper than ${MAX_DEPTH}`);
  only(message, MESSAGE_KEYS, 'the message');
  if (message.from !== signer.party) throw refused(`${signer.party} signed a message from ${message.from}`);
  const epoch = relayed(message.from, message.to) ? 0 : want.epoch;
  if (message.link !== want.link || message.job !== want.job || message.epoch !== epoch) {
    throw refused(`the message is for link ${message.link} job ${message.job} epoch ${message.epoch}, and this is link ${want.link} job ${want.job} epoch ${epoch}`);
  }
  if (message.to !== want.to) throw refused(`the message is for ${message.to}, and this is ${want.to}`);
  check(message);
  return message;
}

export class GapError extends Error {}

export class Cursor {
  #last;

  constructor(last = 0) {
    this.#last = last;
  }

  get last() {
    return this.#last;
  }

  accept(seq) {
    if (seq === this.#last + 1) {
      this.#last = seq;
      return true;
    }
    if (seq <= this.#last) return false;
    throw new GapError(`link: a message is missing before this one: expected ${this.#last + 1}, got ${seq}`);
  }
}
