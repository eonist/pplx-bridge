/**
 * main.ts — entry point.
 *
 * Single session (default, backward compatible):
 *   node dist/main.js
 *   PORT=7001 CDP_PORT=9222 node dist/main.js
 *
 * Multi-tab (single Chrome, multiple perplexity.ai tabs):
 *   PORTS=7001,7002 CDP_PORT=9222 node dist/main.js
 *   → waits until enough perplexity.ai tabs are open, then assigns one per relay port
 *
 * Multi-process fallback (separate Chrome per session, legacy):
 *   PORTS=7001,7002 CDP_PORTS=9222,9223 node dist/main.js
 */
import { RelaySession } from './relay-session.js';
import { listTargets } from './cdp.js';

const POLL_INTERVAL_MS = 2000;

function parseList(env: string | undefined, fallback: string): number[] {
  return (env ?? fallback).split(',').map(s => Number(s.trim()));
}

const ports = parseList(process.env.PORTS ?? process.env.PORT, '7001');

// Multi-tab mode: single CDP_PORT, wait until enough pplx tabs are open
if (process.env.CDP_PORTS === undefined && ports.length > 1) {
  const cdpPort = Number(process.env.CDP_PORT ?? '9222');

  (async () => {
    console.log(`[main] Multi-tab mode — waiting for ${ports.length} perplexity.ai tabs on CDP port ${cdpPort}...`);

    // Poll until Chrome is reachable and has enough pplx tabs
    let pplxTargets: Awaited<ReturnType<typeof listTargets>> = [];
    let lastCount = -1;
    while (pplxTargets.length < ports.length) {
      try {
        const all = await listTargets(cdpPort);
        pplxTargets = all.filter(t => t.url.includes('perplexity.ai'));
        if (pplxTargets.length !== lastCount) {
          console.log(`[main]   Found ${pplxTargets.length}/${ports.length} perplexity.ai tab(s) — ${pplxTargets.length < ports.length ? `open ${ports.length - pplxTargets.length} more in Chrome...` : 'ready!'}`);
          lastCount = pplxTargets.length;
        }
      } catch {
        if (lastCount !== -2) {
          console.log(`[main]   Chrome not reachable on port ${cdpPort} — start Chrome with --remote-debugging-port=${cdpPort}...`);
          lastCount = -2;
        }
      }
      if (pplxTargets.length < ports.length) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    console.log(`[main] Starting ${ports.length} sessions on CDP port ${cdpPort}`);
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
