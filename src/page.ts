// The routines dashboard page — one self-contained HTML document (inline CSS +
// JS, no external assets). Always Gruvbox dark (owner preference). Served at
// GET / by the local web server. Kept as a string constant so `bun build
// src/server.ts` bundles it with no separate asset to ship.
//
// Implementation note: this is a plain (cooked) template literal. The client JS
// therefore avoids embedded backslash string-escapes and backticks (they would
// be processed at build time); registry ids are constrained to [A-Za-z0-9._-]
// so they are safe to interpolate straight into selectors without escaping.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>routines &middot; dashboard</title>
<style>
  /* Gruvbox dark (always — do not follow OS light/dark) */
  :root {
    --bg: #1d2021;
    --panel: #282828;
    --line: #3c3836;
    --fg: #ebdbb2;
    --muted: #928374;
    --accent: #83a598;
    --accent-fg: #1d2021;
    --ok: #b8bb26;
    --warn: #fabd2f;
    --bad: #fb4934;
    --chip: #3c3836;
    --chip-fg: #d5c4a1;
    --code-bg: #1d2021;
    --code-fg: #ebdbb2;
    --orange: #fe8019;
    --aqua: #8ec07c;
    --purple: #d3869b;
  }
  color-scheme: dark;
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    padding: 16px 22px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  header h1 { font-size: 18px; margin: 0; letter-spacing: .2px; }
  header .home { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  header .spacer { flex: 1; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  .badge.bad { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .badge.muted { background: var(--chip); color: var(--chip-fg); }
  .badge.noop { background: color-mix(in srgb, var(--aqua) 18%, transparent); color: var(--aqua); }
  .badge.useful { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  main { padding: 18px 22px 60px; max-width: 1280px; margin: 0 auto; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  table { border-collapse: collapse; width: 100%; min-width: 980px; }
  .rate { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .rate.high-noop { color: var(--warn); }
  .rate.balanced { color: var(--aqua); }
  .rate.useful { color: var(--ok); }
  .detail-line { margin-top: 3px; font-size: 11.5px; color: var(--muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.id { font-weight: 600; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .muted { color: var(--muted); }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 6px; background: var(--chip); color: var(--chip-fg); font-size: 12px; font-family: ui-monospace, monospace; }
  .actions { white-space: nowrap; }
  button {
    font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel); color: var(--fg);
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.link { border: none; background: none; color: var(--accent); padding: 2px 4px; }
  .detail { background: color-mix(in srgb, var(--bg) 60%, var(--panel)); }
  .detail-inner { padding: 4px 4px 10px; }
  .routes { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 4px 0 12px; }
  select, input[type=text] { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); color: var(--fg); }
  .runlist { display: flex; flex-direction: column; gap: 2px; }
  .runrow { display: flex; gap: 12px; align-items: center; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
  .runrow:hover { background: var(--chip); }
  pre.log {
    margin: 8px 0 0; padding: 12px 14px; border-radius: 9px; background: var(--code-bg); color: var(--code-fg);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;
    overflow-x: auto; max-height: 340px; white-space: pre-wrap; word-break: break-word;
  }
  .logtitle { margin: 10px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .toast {
    position: fixed; right: 18px; bottom: 18px; background: var(--panel); border: 1px solid var(--line);
    border-left: 4px solid var(--accent); padding: 10px 14px; border-radius: 9px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
    max-width: 380px; opacity: 0; transform: translateY(8px); transition: .2s; pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.err { border-left-color: var(--bad); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .flags { display: inline-flex; gap: 6px; }
  .group-nav {
    display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; padding: 0;
    list-style: none;
  }
  .group-nav a {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 11px; border-radius: 999px; text-decoration: none;
    border: 1px solid var(--line); background: var(--panel); color: var(--fg);
    font-size: 12.5px;
  }
  .group-nav a:hover { border-color: var(--accent); color: var(--accent); }
  .group-nav .count {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; color: var(--muted);
  }
  tr.group-header td {
    padding: 16px 14px 10px; border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg) 55%, var(--panel));
  }
  tr.group-header:first-child td { padding-top: 12px; }
  .group-title {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  }
  .group-title h2 {
    margin: 0; font-size: 14px; font-weight: 700; letter-spacing: .02em;
    color: var(--orange);
  }
  .group-title .count-pill {
    font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--orange) 16%, transparent);
    color: var(--orange); font-family: ui-monospace, monospace;
  }
  .group-blurb { margin: 3px 0 0; font-size: 12px; color: var(--muted); }
  tr.group-first td { border-top: none; }
</style>
</head>
<body>
<header>
  <h1>routines</h1>
  <span class="home mono" id="home"></span>
  <span id="sit"></span>
  <span class="spacer"></span>
  <span class="muted" id="updated"></span>
  <button id="refresh">Refresh</button>
</header>
<main>
  <ul class="group-nav" id="groupnav"></ul>
  <div class="wrap">
    <table>
      <thead><tr>
        <th>Routine</th><th>Status</th><th>Harness / Model</th><th>Schedule</th>
        <th>Next fire</th><th>Last run</th><th>Outcome</th><th>Noop rate</th><th>Actions</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div id="errors"></div>
</main>
<div class="toast" id="toast"></div>
<script>
"use strict";
var expanded = {};   // id -> true when its detail row is open
var runsCache = {};  // id -> array of run summaries
var DASH = "—", DOT = "·", ELLIPSIS = "…", ARROW = "→";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function rel(iso) {
  if (!iso) return DASH;
  var t = new Date(iso).getTime();
  if (isNaN(t)) return esc(iso);
  var d = Math.round((Date.now() - t) / 1000);
  var fut = d < 0; d = Math.abs(d);
  var s;
  if (d < 60) s = d + "s";
  else if (d < 3600) s = Math.round(d / 60) + "m";
  else if (d < 86400) s = Math.round(d / 3600) + "h";
  else s = Math.round(d / 86400) + "d";
  return fut ? "in " + s : s + " ago";
}
function toast(msg, isErr) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  setTimeout(function () { el.className = "toast" + (isErr ? " err" : ""); }, 3200);
}
function api(method, path, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || j.reason || (r.status + " " + r.statusText));
      return j;
    });
  });
}

function exitBadge(code) {
  if (code === null || code === undefined) return '<span class="badge muted">' + DASH + '</span>';
  if (code === 0) return '<span class="badge ok">exit 0</span>';
  return '<span class="badge bad">exit ' + esc(code) + "</span>";
}
function statusBadge(r) {
  if (r.status === "paused") return '<span class="badge warn">paused</span>';
  return '<span class="badge ok">active</span>';
}
function flags(r) {
  var out = [];
  if (r.running) out.push('<span class="badge muted">running</span>');
  if (r.fenced) out.push('<span class="badge bad" title="Situation fence">fenced: ' + esc(r.fenced) + "</span>");
  return out.length ? '<span class="flags">' + out.join(" ") + "</span>" : "";
}

function groupHeaderHtml(r, count) {
  return (
    '<tr class="group-header" id="g-' + esc(r.groupId) + '">' +
    '<td colspan="9">' +
    '<div class="group-title">' +
    "<h2>" + esc(r.groupLabel) + "</h2>" +
    '<span class="count-pill">' + count + "</span>" +
    "</div>" +
    (r.groupBlurb ? '<p class="group-blurb">' + esc(r.groupBlurb) + "</p>" : "") +
    "</td></tr>"
  );
}

function outcomeBadge(kind, detail) {
  if (!kind || kind === "unknown") {
    return '<span class="badge muted" title="' + esc(detail || "no classified outcome yet") + '">unknown</span>';
  }
  if (kind === "ok") {
    return '<span class="badge useful" title="' + esc(detail || "useful work") + '">useful</span>';
  }
  if (kind === "noop") {
    return '<span class="badge noop" title="' + esc(detail || "ran, nothing to do") + '">noop</span>';
  }
  if (kind === "error") {
    return '<span class="badge bad" title="' + esc(detail || "failed") + '">error</span>';
  }
  return '<span class="badge muted">' + esc(kind) + "</span>";
}

function noopRateHtml(r) {
  var clean = (r.outcomeOk || 0) + (r.outcomeNoop || 0);
  var total = clean + (r.outcomeError || 0) + (r.outcomeUnknown || 0);
  if (r.noopRate == null || clean === 0) {
    // Do NOT use \" inside this file's PAGE template literal — cooked template
    // processing eats the backslash and the browser sees broken JS.
    return '<span class="muted rate" title="Need at least one ok/noop run">' + DASH +
      (total ? ' <span class="muted">(' + total + " run" + (total === 1 ? "" : "s") + ")</span>" : "") +
      "</span>";
  }
  var pct = Math.round(r.noopRate * 100);
  var cls = "rate";
  if (pct >= 70) cls += " high-noop";
  else if (pct <= 30) cls += " useful";
  else cls += " balanced";
  var title = "Last " + (r.outcomeWindow || 10) + " runs: " +
    (r.outcomeOk || 0) + " useful, " + (r.outcomeNoop || 0) + " noop, " +
    (r.outcomeError || 0) + " error, " + (r.outcomeUnknown || 0) + " unknown. " +
    "Noop rate = noop/(ok+noop). High noop suggests lengthening the cadence.";
  return '<span class="' + cls + '" title="' + esc(title) + '">' + pct + "% noop</span>" +
    '<div class="muted rate">' + (r.outcomeNoop || 0) + "n / " + (r.outcomeOk || 0) + "u" +
    ((r.outcomeError || 0) ? " / " + r.outcomeError + "e" : "") + "</div>";
}

function rowHtml(r) {
  var eid = esc(r.id);
  var runBtn = '<button class="primary" data-act="run" data-id="' + eid + '"' + (r.running ? " disabled" : "") + '>Run now</button>';
  var pauseBtn = r.status === "paused"
    ? '<button data-act="resume" data-id="' + eid + '">Resume</button>'
    : '<button data-act="pause" data-id="' + eid + '">Pause</button>';
  var routeBtn = '<button data-act="route" data-id="' + eid + '">Re-route</button>';
  var runsBtn = '<button class="link" data-act="runs" data-id="' + eid + '">' + (expanded[r.id] ? "hide runs" : "runs") + "</button>";
  return (
    "<tr>" +
    '<td class="id">' + eid + " " + runsBtn + "</td>" +
    "<td>" + statusBadge(r) + "</td>" +
    '<td><span class="chip">' + esc(r.harness) + '</span> <span class="mono">' + esc(r.model) + "</span>" +
      (r.effort ? ' <span class="muted mono">(' + esc(r.effort) + ")</span>" : "") + "</td>" +
    '<td class="mono">' + esc(r.rrule) + "</td>" +
    '<td class="mono">' + (r.nextFire ? esc(rel(r.nextFire)) : '<span class="muted">' + DASH + "</span>") + "</td>" +
    "<td>" + (r.lastRun ? esc(rel(r.lastRun)) + " " : "") + exitBadge(r.lastExit) + " " + flags(r) + "</td>" +
    "<td>" + outcomeBadge(r.lastOutcome, r.lastOutcomeDetail) +
      (r.lastOutcomeDetail ? '<div class="detail-line" title="' + esc(r.lastOutcomeDetail) + '">' + esc(r.lastOutcomeDetail) + "</div>" : "") +
      "</td>" +
    "<td>" + noopRateHtml(r) + "</td>" +
    '<td class="actions">' + runBtn + " " + pauseBtn + " " + routeBtn + "</td>" +
    "</tr>"
  );
}

function detailHtml(r) {
  var eid = esc(r.id);
  var harnessOpts = ["claude", "codex", "grok"].map(function (h) {
    return '<option value="' + h + '"' + (h === r.harness ? " selected" : "") + ">" + h + "</option>";
  }).join("");
  var route =
    '<div class="routes">' +
    '<span class="muted">re-route:</span>' +
    '<select data-role="harness" data-id="' + eid + '">' + harnessOpts + "</select>" +
    '<input type="text" data-role="model" data-id="' + eid + '" value="' + esc(r.model) + '" size="26" />' +
    '<button class="primary" data-act="saveroute" data-id="' + eid + '">Save</button>' +
    "</div>";
  var runsHtml = '<div class="runlist" data-runs="' + eid + '">' + runsListHtml(r.id) + "</div>";
  return (
    '<tr class="detail"><td colspan="9"><div class="detail-inner">' +
    route + runsHtml +
    '<div data-logfor="' + eid + '"></div>' +
    "</div></td></tr>"
  );
}
function runsListHtml(id) {
  var runs = runsCache[id];
  if (!runs) return '<span class="muted">loading runs' + ELLIPSIS + "</span>";
  if (!runs.length) return '<span class="muted">no runs recorded yet</span>';
  return runs.map(function (run) {
    var meta = (run.finishedAt ? esc(rel(run.finishedAt)) : "") +
      (run.durationMs != null ? " " + DOT + " " + (run.durationMs / 1000).toFixed(1) + "s" : "") +
      (run.timedOut ? " " + DOT + " timed out" : "") +
      (run.outcomeDetail ? " " + DOT + " " + esc(run.outcomeDetail) : "");
    return (
      '<div class="runrow" data-act="showrun" data-id="' + esc(id) + '" data-stamp="' + esc(run.stamp) + '">' +
      exitBadge(run.exitCode) +
      outcomeBadge(run.outcome, run.outcomeDetail) +
      '<span class="mono">' + esc(run.stamp) + "</span>" +
      '<span class="muted">' + meta + "</span>" +
      "</div>"
    );
  }).join("");
}

function groupCounts(rows) {
  var counts = {};
  var order = [];
  rows.forEach(function (r) {
    var id = r.groupId || "other";
    if (!counts[id]) {
      counts[id] = { id: id, label: r.groupLabel || id, blurb: r.groupBlurb || "", n: 0 };
      order.push(id);
    }
    counts[id].n++;
  });
  return order.map(function (id) { return counts[id]; });
}

function render(snap) {
  document.getElementById("home").textContent = snap.home;
  var sit = document.getElementById("sit");
  sit.innerHTML = snap.situationsOk
    ? '<span class="badge ok">situations ok</span>'
    : '<span class="badge bad" title="' + esc(snap.situationsError || "") + '">situations degraded</span>';
  document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();

  var nav = document.getElementById("groupnav");
  var groups = groupCounts(snap.rows);
  nav.innerHTML = groups.map(function (g) {
    return '<li><a href="#g-' + esc(g.id) + '">' + esc(g.label) +
      ' <span class="count">' + g.n + "</span></a></li>";
  }).join("");

  var tbody = document.getElementById("rows");
  if (!snap.rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No routines registered. Add one under $ROUTINES_HOME/registry/&lt;id&gt;.toml</td></tr>';
  } else {
    var html = "";
    var prevGroup = null;
    var i = 0;
    while (i < snap.rows.length) {
      var r = snap.rows[i];
      var gid = r.groupId || "other";
      if (gid !== prevGroup) {
        var n = 0;
        for (var j = i; j < snap.rows.length && (snap.rows[j].groupId || "other") === gid; j++) n++;
        html += groupHeaderHtml(r, n);
        prevGroup = gid;
      }
      html += rowHtml(r);
      if (expanded[r.id]) html += detailHtml(r);
      i++;
    }
    tbody.innerHTML = html;
  }
  var errs = document.getElementById("errors");
  errs.innerHTML = (snap.errors && snap.errors.length)
    ? '<p class="badge bad" style="display:block;margin-top:14px">' + snap.errors.map(esc).join("<br>") + "</p>"
    : "";
}

var lastSnap = null;
function load() {
  return api("GET", "/api/routines").then(function (snap) { lastSnap = snap; render(snap); })
    .catch(function (e) { toast("load failed: " + e.message, true); });
}
function loadRuns(id) {
  return api("GET", "/api/routines/" + encodeURIComponent(id) + "/runs").then(function (j) {
    runsCache[id] = j.runs || [];
    var el = document.querySelector('[data-runs="' + id + '"]');
    if (el) el.innerHTML = runsListHtml(id);
  });
}
function showRun(id, stamp) {
  api("GET", "/api/routines/" + encodeURIComponent(id) + "/runs/" + encodeURIComponent(stamp)).then(function (d) {
    var host = document.querySelector('[data-logfor="' + id + '"]');
    if (!host) return;
    var out = (d.stdoutTail || "").trim() || "(no stdout captured)";
    var err = (d.stderrTail || "").trim();
    var html = '<div class="muted mono" style="margin-top:8px">' + esc(d.dir) + "</div>" +
      '<div class="logtitle">stdout</div><pre class="log">' + esc(out) + "</pre>";
    if (err) html += '<div class="logtitle">stderr</div><pre class="log">' + esc(err) + "</pre>";
    host.innerHTML = html;
  }).catch(function (e) { toast(e.message, true); });
}

function pollAfterRun(id) {
  var n = 0;
  var iv = setInterval(function () {
    n++;
    load().then(function () {
      var row = lastSnap && lastSnap.rows.find(function (r) { return r.id === id; });
      if (expanded[id]) loadRuns(id);
      if ((row && !row.running) || n > 40) clearInterval(iv);
    });
  }, 1500);
}

document.addEventListener("click", function (ev) {
  var t = ev.target.closest("[data-act]");
  if (!t) return;
  var act = t.getAttribute("data-act");
  var id = t.getAttribute("data-id");
  if (act === "run") {
    t.disabled = true;
    api("POST", "/api/routines/" + encodeURIComponent(id) + "/run").then(function () {
      toast("run started: " + id); pollAfterRun(id);
    }).catch(function (e) { toast(e.message, true); load(); });
  } else if (act === "pause" || act === "resume") {
    api("POST", "/api/routines/" + encodeURIComponent(id) + "/" + act).then(function () {
      toast(id + ": " + act + "d"); load();
    }).catch(function (e) { toast(e.message, true); });
  } else if (act === "route") {
    expanded[id] = true; render(lastSnap); loadRuns(id);
  } else if (act === "runs") {
    expanded[id] = !expanded[id]; render(lastSnap);
    if (expanded[id]) loadRuns(id);
  } else if (act === "saveroute") {
    var h = document.querySelector('select[data-role="harness"][data-id="' + id + '"]');
    var mdl = document.querySelector('input[data-role="model"][data-id="' + id + '"]');
    api("POST", "/api/routines/" + encodeURIComponent(id) + "/route", { harness: h.value, model: mdl.value })
      .then(function (j) { toast(id + " " + ARROW + " " + j.harness + "/" + j.model); load(); })
      .catch(function (e) { toast(e.message, true); });
  } else if (act === "showrun") {
    showRun(id, t.getAttribute("data-stamp"));
  }
});
document.getElementById("refresh").addEventListener("click", load);

load();
setInterval(function () {
  // Light auto-refresh; skip while a detail row is open to avoid clobbering it.
  if (!Object.keys(expanded).some(function (k) { return expanded[k]; })) load();
}, 4000);
</script>
</body>
</html>`;
