/**
 * main.ts — entry point.
 * Spawns one RelaySession per (port, cdpPort) pair.
 *
 * Single session (default, backward compatible):
 *   node dist/main.js
 *   PORT=7001 CDP_PORT=9222 node dist/main.js
 *
 * Multiple sessions:
 *   PORTS=7001,7002 CDP_PORTS=9222,9223 node dist/main.js
 */
import { RelaySession } from './relay-session.js';

function parseList(env: string | undefined, fallback: string): number[] {
  return (env ?? fallback).split(',').map(s => Number(s.trim()));
}

// Support both singular (PORT/CDP_PORT) and plural (PORTS/CDP_PORTS) env vars
const ports    = parseList(process.env.PORTS    ?? process.env.PORT,    '7001');
const cdpPorts = parseList(process.env.CDP_PORTS ?? process.env.CDP_PORT, '9222');

if (ports.length !== cdpPorts.length) {
  console.error('[main] PORTS and CDP_PORTS must have the same number of entries.');
  console.error(`[main]   PORTS     = ${ports.join(', ')}`);
  console.error(`[main]   CDP_PORTS = ${cdpPorts.join(', ')}`);
  process.exit(1);
}

for (let i = 0; i < ports.length; i++) {
  new RelaySession(ports[i]!, cdpPorts[i]!).start();
}
