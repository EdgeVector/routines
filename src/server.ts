// routines web — the local dashboard. A single localhost HTTP server that
// serves one self-contained page (no external assets, no auth — 127.0.0.1
// only) plus a small JSON API. Every mutating endpoint calls the SAME action
// helpers the CLI uses (src/actions.ts), so a button in the browser and a
// `routines` command are the same code path.

import { loadEntry, RegistryError } from "./registry.ts";
import { collectStatus } from "./status.ts";
import { listRuns, readRun } from "./runs.ts";
import { routeRoutine, setStatus, startRunNow, ActionError } from "./actions.ts";
import { PAGE } from "./page.ts";
import { captureRoutinesException } from "./observability.ts";

export interface ServerOptions {
  /** Port to bind (0 = ephemeral, useful for tests). Default 4778. */
  port?: number;
  /** Bind address. Localhost only by default — the dashboard has no auth. */
  host?: string;
}

export interface ServerHandle {
  port: number;
  host: string;
  url: string;
  stop: () => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (path === "/" && method === "GET") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // GET /api/routines — the single-pane status snapshot.
  if (path === "/api/routines" && method === "GET") {
    return json(collectStatus());
  }

  // /api/routines/:id/...
  const m = path.match(/^\/api\/routines\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";

    // Resolve the routine (404 if unknown / unparseable).
    let entry;
    try {
      entry = loadEntry(id);
    } catch (err) {
      const msg = err instanceof RegistryError ? err.message : String(err);
      return json({ error: msg }, 404);
    }

    // GET .../runs — recent run summaries.
    if (sub === "runs" && method === "GET") {
      return json({ id, runs: listRuns(id) });
    }
    // GET .../runs/<stamp|latest> — one run's detail + log tail.
    const runM = sub.match(/^runs\/(.+)$/);
    if (runM && method === "GET") {
      const stamp = runM[1] === "latest" ? undefined : decodeURIComponent(runM[1]!);
      const detail = readRun(id, stamp);
      if (!detail) return json({ error: "no such run" }, 404);
      return json(detail);
    }

    // POST .../run — fire now (shared single-flight with the daemon).
    if (sub === "run" && method === "POST") {
      const res = startRunNow(entry);
      if (!res.started) return json({ started: false, reason: res.reason }, 409);
      return json({ started: true, id }, 202);
    }
    // POST .../pause | .../resume
    if (sub === "pause" && method === "POST") {
      const next = setStatus(entry, "paused");
      return json({ id, status: next.status });
    }
    if (sub === "resume" && method === "POST") {
      const next = setStatus(entry, "active");
      return json({ id, status: next.status });
    }
    // POST .../route — { harness?, model? }
    if (sub === "route" && method === "POST") {
      let payload: { harness?: string; model?: string };
      try {
        payload = (await req.json()) as { harness?: string; model?: string };
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      try {
        const next = routeRoutine(entry, payload);
        return json({ id, harness: next.harness, model: next.model });
      } catch (err) {
        if (err instanceof ActionError) return json({ error: err.message }, 400);
        throw err;
      }
    }
  }

  return json({ error: "not found" }, 404);
}

export function startServer(opts: ServerOptions = {}): ServerHandle {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4778;
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (req) =>
      handle(req).catch((err) => {
        captureRoutinesException(err, {
          tags: {
            service: "routines-web",
            method: req.method,
            route: new URL(req.url).pathname,
          },
        });
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }),
  });
  const actualPort = server.port ?? port;
  return {
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}/`,
    stop: () => server.stop(true),
  };
}
