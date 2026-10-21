import { createConnection, createServer } from 'node:net';

const NEWLINE = 10;

function lineReader(most, done) {
  const chunks = [];
  let size = 0;
  return (chunk) => {
    const end = chunk.indexOf(NEWLINE);
    const part = end < 0 ? chunk : chunk.subarray(0, end);
    size += part.length;
    if (size > most) {
      done(null, 'the line passes its bound');
      return;
    }
    chunks.push(part);
    if (end < 0) return;
    try {
      done(JSON.parse(Buffer.concat(chunks).toString('utf8')), '');
    } catch {
      done(null, 'the line is not JSON');
    }
  };
}

export function boundedAsk(path, { connect = createConnection, within, requestMost, answerMost }) {
  if (!path) return null;
  return (asked) => new Promise((resolve) => {
    const line = `${JSON.stringify(asked)}\n`;
    if (Buffer.byteLength(line, 'utf8') > requestMost) {
      resolve(null);
      return;
    }
    const socket = connect(path);
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), within);
    socket.on('error', () => done(null));
    socket.on('end', () => done(null));
    socket.on('connect', () => socket.write(line));
    socket.on('data', lineReader(answerMost, done));
  });
}

export function serveBounded(path, handle, { requestMost, answerMost, within, refused = (_why) => {}, listen = createServer }) {
  const server = listen((socket) => {
    let answered = false;
    const answer = (said) => {
      if (answered) return;
      const line = `${JSON.stringify(said)}\n`;
      answered = true;
      socket.end(Buffer.byteLength(line, 'utf8') > answerMost ? `${JSON.stringify({ error: 'the answer passes its bound' })}\n` : line);
    };
    const refuse = (why) => {
      if (answered) return;
      refused(why);
      answer({ error: why });
    };
    const timer = within ? setTimeout(() => refuse('the question did not end its line in time'), within) : null;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer);
      if (answered) return;
      answered = true;
      refused('the asker went away before its answer');
    });
    socket.on('data', lineReader(requestMost, (asked, why) => {
      clearTimeout(timer);
      socket.pause();
      if (why) {
        refuse(why);
        return;
      }
      Promise.resolve().then(() => handle(asked)).then(answer).catch((error) => refuse(String(error?.message ?? error)));
    }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve(server));
  });
}
