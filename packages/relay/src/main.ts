/**
 * main.ts — entry point.
 * Spawns one RelaySession per (port, cdpPort, targetUrl) triple.
 *
 * Single session (default, backward compatible):
 *   node dist/main.js
 *   PORT=7001 CDP_PORT=9222 node dist/main.js
 *
 * Multiple sessions on separate Chrome instances:
 *   PORTS=7001,7002 CDP_PORTS=9222,9223 node dist/main.js
 *
 * Multiple sessions sharing one Chrome (multi-tab):
 *   PORTS=7001,7002 CDP_PORTS=9222,9222 TARGET_URLS="perplexity.ai/search/foo,perplexity.ai/search/bar" node dist/main.js
 */
import { RelaySession } from './relay-session.js';

function parseList(env: string | undefined, fallback: string): string[] {
  return (env ?? fallback).split(',').map(s => s.trim());
}

const portStrs    = parseList(process.env.PORTS    ?? process.env.PORT,    '7001');
const cdpPortStrs = parseList(process.env.CDP_PORTS ?? process.env.CDP_PORT, '9222');
const targetUrls  = process.env.TARGET_URLS ? parseList(process.env.TARGET_URLS, '') : [];

const ports    = portStrs.map(Number);
const cdpPorts = cdpPortStrs.map(Number);

if (ports.length !== cdpPorts.length) {
  console.error('[main] PORTS and CDP_PORTS must have the same number of entries.');
  console.error(`[main]   PORTS     = ${ports.join(', ')}`);
  console.error(`[main]   CDP_PORTS = ${cdpPorts.join(', ')}`);
  process.exit(1);
}

if (targetUrls.length > 0 && targetUrls.length !== ports.length) {
  console.error('[main] TARGET_URLS must have the same number of entries as PORTS.');
  console.error(`[main]   PORTS       = ${ports.join(', ')}`);
  console.error(`[main]   TARGET_URLS = ${targetUrls.join(', ')}`);
  process.exit(1);
}

for (let i = 0; i < ports.length; i++) {
  new RelaySession(ports[i]!, cdpPorts[i]!, targetUrls[i]).start();
}
