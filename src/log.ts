// One JSON object per line on stderr; journald keeps it.

type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + '\n');
}

export const log = {
  info: (msg: string, f?: Fields) => emit('info', msg, f),
  warn: (msg: string, f?: Fields) => emit('warn', msg, f),
  error: (msg: string, f?: Fields) => emit('error', msg, f),
};
