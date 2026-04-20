/**
 * main.ts — entry point.
 *
 * Single session (default, backward compatible):
 *   node dist/main.js
 *   PORT=7001 CDP_PORT=9222 node dist/main.js
 *
 * Multi-tab (single Chrome, multiple perplexity.ai tabs):
 *   PORTS=7001,7002 CDP_PORT=9222 node dist/main.js
 *   → fetches all perplexity.ai tabs from CDP_PORT, assigns one per relay port
 *
 * Multi-process fallback (separate Chrome per session, legacy):
 *   PORTS=7001,7002 CDP_PORTS=9222,9223 node dist/main.js
 */
import { RelaySession } from './relay-session.js';
import { listTargets } from './cdp.js';

function parseList(env: string | undefined, fallback: string): number[] {
  return (env ?? fallback).split(',').map(s => Number(s.trim()));
}

const ports = parseList(process.env.PORTS ?? process.env.PORT, '7001');

// Multi-tab mode: single CDP_PORT, enumerate tabs
if (process.env.CDP_PORTS === undefined && ports.length > 1) {
  const cdpPort = Number(process.env.CDP_PORT ?? '9222');

  (async () => {
    let targets;
    try {
      targets = await listTargets(cdpPort);
    } catch (err) {
      console.error('[main] Failed to reach Chrome:', (err as Error).message);
      process.exit(1);
    }

    const pplxTargets = targets.filter(t => t.url.includes('perplexity.ai'));

    if (pplxTargets.length < ports.length) {
      console.error(`[main] Not enough perplexity.ai tabs open.`);
      console.error(`[main]   Requested sessions : ${ports.length}`);
      console.error(`[main]   Open pplx tabs found: ${pplxTargets.length}`);
      console.error(`[main]   Open ${ports.length} perplexity.ai tabs in Chrome (port ${cdpPort}) and retry.`);
      process.exit(1);
    }

    console.log(`[main] Multi-tab mode — ${ports.length} sessions on CDP port ${cdpPort}`);
    for (let i = 0; i < ports.length; i++) {
      const target = pplxTargets[i]!;
      console.log(`[main]   :${ports[i]} → target ${target.id} (${target.url})`);
      new RelaySession(ports[i]!, cdpPort, target.id).start();
    }
  })();

} else {
  // Single-session or legacy multi-process mode
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
}
