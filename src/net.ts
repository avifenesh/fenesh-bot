// Global HTTP settings for every fetch in the process.
// Reasoning calls can run for many minutes before the first byte, and some research hosts take
// several seconds to accept a connection, so the defaults (5 min headers/body, 10 s connect) are too low.

import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({
  connect: { timeout: 30_000 },
  headersTimeout: 25 * 60_000,
  bodyTimeout: 25 * 60_000,
  keepAliveTimeout: 30_000,
}));
