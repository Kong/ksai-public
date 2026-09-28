import { createConnection } from 'node:net';

const ASK_MS = 15_000;
const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const whole = (value, least, most) => Math.min(most, Math.max(least, Math.round(Number(value) || 0)));

export function retryAsked(event) {
  const error = event?.error && typeof event.error === 'object' ? event.error : {};
  const type = String(error.type ?? error.name ?? 'error');
  const status = Number(error.status ?? error.statusCode);
  return {
    attempt: whole(event?.attempt, 1, 100),
    proposed_delay_ms: whole(event?.decision?.delay, 0, 900_000),
    error: {
      type: ERROR_TYPE.test(type) ? type : 'error',
      ...(Number.isInteger(status) && status >= 0 && status <= 599 ? { status } : {}),
      message: [...String(error.message ?? '')].slice(0, 1000).join(''),
    },
  };
}

const retryAnswer = (answer) => typeof answer?.retry === 'boolean';

export function asker(path, { connect = createConnection, within = ASK_MS, accept = retryAnswer } = {}) {
  if (!path) return null;
  return (asked) => new Promise((resolve) => {
    const socket = connect(path);
    let said = '';
    let timer = null;
    const done = (answer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    timer = setTimeout(() => done(null), within);
    socket.setEncoding('utf8');
    socket.on('error', () => done(null));
    socket.on('connect', () => socket.write(`${JSON.stringify(asked)}\n`));
    socket.on('data', (chunk) => {
      said += chunk;
      const end = said.indexOf('\n');
      if (end < 0) return;
      try {
        const answer = JSON.parse(said.slice(0, end));
        done(accept(answer) ? answer : null);
      } catch {
        done(null);
      }
    });
  });
}

export function decided(decision, answer) {
  if (!answer) return decision;
  return answer.retry ? { ...decision, retry: true, delay: whole(answer.delay_ms, 0, 900_000) } : { retry: false };
}
