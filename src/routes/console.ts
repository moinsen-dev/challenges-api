import { Hono } from 'hono'
import { HonoApp } from '../lib'

export const console_ = new Hono<HonoApp>()

/**
 * The developer console, served by the API itself.
 *
 * It lives here rather than on the website for one reason that is not
 * negotiable: the session is an httpOnly cookie, and the API answers every
 * other request with `Access-Control-Allow-Origin: *`, which a browser refuses
 * to combine with credentials. A console on another host would therefore need
 * the CORS policy of the whole API loosened and the cookie widened to every
 * subdomain — a lot of blast radius for one page. On the same origin the
 * cookie simply works, and it keeps working on the workers.dev hostname, which
 * matters as long as the zone challenges browser traffic to moinsen.dev.
 *
 * The page talks to the same public endpoints a third party would use. There is
 * nothing here a developer could not do with curl.
 */

const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Console — Challenges API</title>
<style>
  :root {
    --bg:#0a0b0d; --panel:#13161a; --panel-2:#181c21; --line:#23282f;
    --text:#eaeef4; --text-2:#b8c2ce; --muted:#7f8b99;
    --gold:#e9b949; --accent:#5aa9ff; --good:#59cd90; --bad:#e2685c;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:radial-gradient(1100px 600px at 68% -8%, rgba(233,185,73,.055), transparent 62%), var(--bg);
    color:var(--text); font-family:var(--sans); font-size:16px; line-height:1.6;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:1040px; margin:0 auto; padding:38px 22px 90px; }
  h1 { font-size:1.65rem; margin:0 0 4px; font-weight:600; }
  h2 { font-size:1.12rem; margin:34px 0 12px; font-weight:600; }
  h3 { font-size:.95rem; margin:20px 0 8px; font-weight:600; color:var(--text-2); }
  p { margin:0 0 12px; }
  a { color:var(--accent); }
  .muted { color:var(--muted); }
  .small { font-size:.86rem; }
  .mono { font-family:var(--mono); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:13px; padding:18px 20px; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .between { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
  .btn {
    background:var(--panel-2); color:var(--text); border:1px solid var(--line);
    border-radius:9px; padding:8px 14px; font:inherit; font-size:.9rem; cursor:pointer;
  }
  .btn:hover { border-color:#333a44; }
  .btn.primary { background:var(--gold); border-color:var(--gold); color:#191408; font-weight:600; }
  .btn.danger { color:var(--bad); }
  .btn:disabled { opacity:.45; cursor:not-allowed; }
  input, select {
    background:#0c0e11; color:var(--text); border:1px solid var(--line);
    border-radius:9px; padding:9px 11px; font:inherit; font-size:.9rem; width:100%;
  }
  label { display:block; font-size:.8rem; color:var(--muted); margin-bottom:5px; }
  table { width:100%; border-collapse:collapse; font-size:.88rem; }
  th { text-align:left; font-weight:600; color:var(--muted); font-size:.76rem;
       text-transform:uppercase; letter-spacing:.05em; padding:0 12px 8px 0; }
  td { padding:9px 12px 9px 0; border-top:1px solid var(--line); vertical-align:top; }
  .scroll { overflow-x:auto; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.74rem;
          border:1px solid var(--line); background:var(--panel-2); color:var(--text-2); }
  .pill.secret { color:var(--gold); border-color:#3a3121; }
  .pill.dead { color:var(--muted); text-decoration:line-through; }
  .pill.ok { color:var(--good); border-color:#204030; }
  .note { border-left:2px solid var(--gold); padding:10px 0 10px 14px; margin:14px 0; }
  .bad { color:var(--bad); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:640px) { .grid2 { grid-template-columns:1fr; } }
  .keyout { background:#0c0e11; border:1px solid var(--gold); border-radius:9px;
            padding:12px 14px; font-family:var(--mono); font-size:.84rem; word-break:break-all; margin-top:10px; }
  .hidden { display:none; }
</style>
</head><body>
<div class="wrap">

  <div class="between">
    <div>
      <h1>Console</h1>
      <p class="muted small" id="whoami">Checking your session…</p>
    </div>
    <div class="row" id="sessionbar"></div>
  </div>

  <div id="err" class="card hidden" style="margin-top:18px; border-color:#4a2b28;"><p class="bad" id="errtext"></p></div>

  <!-- ---------------------------------------------------------- signed out -->
  <section id="signedout" class="hidden">
    <div class="card" style="margin-top:22px;">
      <h2 style="margin-top:0;">Sign in</h2>
      <p class="muted">
        A developer account owns apps and the keys those apps run on. Nothing
        here touches player data, and no key you have already been given is
        readable again — this page can mint and retire keys, not recover them.
      </p>
      <div class="row" style="margin-top:14px;">
        <a class="btn primary" id="ghlink" href="/v1/dev/auth/github?redirect=/dashboard">Sign in with GitHub</a>
      </div>
      <p class="muted small" id="ghnote" style="margin-top:14px;"></p>
    </div>
  </section>

  <!-- ----------------------------------------------------------- signed in -->
  <section id="signedin" class="hidden">

    <h2>Apps</h2>
    <div class="scroll card" style="padding:14px 20px;">
      <table>
        <thead><tr><th>App</th><th>Disciplines</th><th>Players</th><th>Live keys</th><th></th></tr></thead>
        <tbody id="apps"></tbody>
      </table>
      <p class="muted small hidden" id="noapps" style="margin:12px 0 4px;">No apps yet. The first one is below.</p>
    </div>

    <h3>Create an app</h3>
    <div class="card">
      <div class="grid2">
        <div><label for="newslug">Slug</label><input id="newslug" placeholder="neon-coil" autocomplete="off"></div>
        <div><label for="newname">Name</label><input id="newname" placeholder="Neon Coil" autocomplete="off"></div>
      </div>
      <div class="row" style="margin-top:12px;">
        <button class="btn primary" id="create">Create</button>
        <span class="muted small" id="quota"></span>
      </div>
      <div id="newkeys" class="hidden">
        <p class="small" style="margin:14px 0 0;">
          Both keys are shown once. The secret key is the only one that carries
          authority — it belongs on a server, never in a game client.
        </p>
        <div class="keyout" id="newkeysout"></div>
      </div>
    </div>

    <div id="keysection" class="hidden">
      <h2 id="keystitle">Keys</h2>
      <div class="scroll card" style="padding:14px 20px;">
        <table>
          <thead><tr><th>Key</th><th>Name</th><th>Created</th><th>Last used</th><th>State</th><th></th></tr></thead>
          <tbody id="keys"></tbody>
        </table>
      </div>

      <h3>Mint a key</h3>
      <div class="card">
        <div class="grid2">
          <div>
            <label for="kind">Kind</label>
            <select id="kind"><option value="public">public — safe in a client</option><option value="secret">secret — server only</option></select>
          </div>
          <div><label for="kname">Name</label><input id="kname" placeholder="what it is for" autocomplete="off"></div>
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="btn primary" id="mint">Mint</button>
          <span class="muted small">Both keys stay valid until you revoke the old one.</span>
        </div>
        <div id="mintout" class="keyout hidden"></div>
      </div>
    </div>

    <h2>What you did</h2>
    <div class="scroll card" style="padding:14px 20px;">
      <table>
        <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody id="audit"></tbody>
      </table>
    </div>

    <h2>Sessions</h2>
    <div class="scroll card" style="padding:14px 20px;">
      <table>
        <thead><tr><th>Session</th><th>Browser</th><th>Last seen</th><th>Expires</th></tr></thead>
        <tbody id="sessions"></tbody>
      </table>
      <div class="row" style="margin-top:12px;">
        <button class="btn danger" id="revokeothers">End every other session</button>
      </div>
    </div>
  </section>

  <p class="muted small" style="margin-top:44px;">
    <a href="/v1/openapi.json">OpenAPI</a> ·
    <a href="https://challenges-api.pages.dev/docs/">Documentation</a> ·
    every call this page makes is an endpoint you can call yourself.
  </p>
</div>

<script>
const $ = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))
const when = (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle:'short', timeStyle:'short' }) : '—')

let currentApp = null

function fail(message) { $('errtext').textContent = message; $('err').classList.remove('hidden') }
function clearFail() { $('err').classList.add('hidden') }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const parsed = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(parsed.error ?? parsed.reason ?? ('HTTP ' + res.status))
  return parsed
}

async function boot() {
  let me
  try {
    me = await api('GET', '/v1/dev/me')
  } catch {
    // Not signed in is the ordinary case here, not an error worth shouting about.
    $('signedout').classList.remove('hidden')
    $('whoami').textContent = 'Not signed in.'
    try {
      await api('GET', '/v1/dev/auth/github')
    } catch (error) {
      if (String(error.message).includes('not configured')) {
        const link = $('ghlink')
        link.classList.remove('primary')
        link.setAttribute('aria-disabled', 'true')
        link.removeAttribute('href')
        link.style.opacity = '.45'
        link.style.cursor = 'not-allowed'
        $('ghnote').textContent =
          'GitHub sign-in is not configured on this instance — GITHUB_CLIENT_ID and ' +
          'GITHUB_CLIENT_SECRET are unset, so the endpoint answers 501 rather than pretending.'
      }
    }
    return
  }

  $('signedin').classList.remove('hidden')
  $('whoami').innerHTML =
    'Signed in as <strong>' + esc(me.login) + '</strong> via ' + esc(me.provider) +
    (me.two_factor ? ' · <span class="pill ok">two-factor</span>' : ' · <span class="pill">no two-factor</span>')
  $('sessionbar').innerHTML = '<button class="btn" id="signout">Sign out</button>'
  $('signout').addEventListener('click', async () => {
    await api('POST', '/v1/dev/logout')
    location.reload()
  })
  $('quota').textContent = me.apps + ' of ' + me.app_quota + ' apps used'
  await Promise.all([loadApps(), loadAudit(), loadSessions()])
}

async function loadApps() {
  const { apps } = await api('GET', '/v1/dev/apps')
  $('noapps').classList.toggle('hidden', apps.length > 0)
  $('apps').innerHTML = apps.map((a) =>
    '<tr><td><strong>' + esc(a.name) + '</strong><br><span class="mono muted small">' + esc(a.slug) + '</span></td>' +
    '<td>' + a.disciplines + '</td><td>' + a.players + '</td><td>' + a.live_keys + '</td>' +
    '<td><button class="btn" data-app="' + esc(a.slug) + '">keys</button></td></tr>').join('')
  document.querySelectorAll('[data-app]').forEach((b) =>
    b.addEventListener('click', () => loadKeys(b.dataset.app)))
  if (apps.length && !currentApp) loadKeys(apps[0].slug)
}

async function loadKeys(slug) {
  clearFail()
  currentApp = slug
  const { keys } = await api('GET', '/v1/dev/apps/' + encodeURIComponent(slug) + '/keys')
  $('keysection').classList.remove('hidden')
  $('keystitle').textContent = 'Keys · ' + slug
  // The server refuses to revoke the last live key of a kind, because that is
  // not rotating a key, it is taking a game offline. The page knows the same
  // rule, so it does not offer a button that can only fail.
  const live = {}
  keys.filter((k) => !k.revoked_at).forEach((k) => { live[k.kind] = (live[k.kind] ?? 0) + 1 })
  $('keys').innerHTML = keys.map((k) => {
    const dead = Boolean(k.revoked_at)
    const last = !dead && live[k.kind] <= 1
    const state = dead
      ? '<span class="pill dead">revoked</span>' + (k.revoke_reason ? ' <span class="muted small">' + esc(k.revoke_reason) + '</span>' : '')
      : (k.expires_at ? '<span class="pill">until ' + when(k.expires_at) + '</span>' : '<span class="pill ok">live</span>')
    return '<tr><td><span class="pill ' + (k.kind === 'secret' ? 'secret' : '') + '">' + esc(k.kind) + '</span> ' +
      '<span class="mono small">' + esc(k.prefix) + '…</span></td>' +
      '<td>' + esc(k.name) + '</td><td class="muted small">' + when(k.created_at) + '</td>' +
      '<td class="muted small">' + when(k.last_used_at) + '</td><td>' + state + '</td>' +
      '<td>' + (dead ? ''
        : last
          ? '<button class="btn" disabled title="Mint a replacement ' + esc(k.kind) + ' key first — revoking the last one would take the app offline.">revoke</button>'
          : '<button class="btn danger" data-revoke="' + esc(k.id) + '">revoke</button>') + '</td></tr>'
  }).join('')
  document.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      const reason = prompt('Why is this key being retired? (optional)') ?? undefined
      try {
        await api('POST', '/v1/dev/keys/' + encodeURIComponent(b.dataset.revoke) + '/revoke', { reason })
        await loadKeys(currentApp); await loadAudit()
      } catch (error) { fail(error.message) }
    }))
}

async function loadAudit() {
  const { entries } = await api('GET', '/v1/dev/audit')
  $('audit').innerHTML = entries.slice(0, 40).map((e) =>
    '<tr><td class="muted small">' + when(e.created_at) + '</td>' +
    '<td><span class="pill">' + esc(e.action) + '</span></td>' +
    '<td class="muted small mono">' + esc(e.detail ? JSON.stringify(e.detail) : '') + '</td></tr>').join('')
}

async function loadSessions() {
  const { sessions } = await api('GET', '/v1/dev/sessions')
  $('sessions').innerHTML = sessions.map((s) =>
    '<tr><td class="mono small">' + esc(s.id) + '</td>' +
    '<td class="muted small">' + esc((s.user_agent || '—').slice(0, 60)) + '</td>' +
    '<td class="muted small">' + when(s.last_seen) + '</td>' +
    '<td class="muted small">' + when(s.expires_at) + '</td></tr>').join('')
}

$('create').addEventListener('click', async () => {
  clearFail()
  try {
    const made = await api('POST', '/v1/dev/apps', { slug: $('newslug').value.trim(), name: $('newname').value.trim() })
    $('newkeys').classList.remove('hidden')
    $('newkeysout').textContent = made.public_key + '\n' + made.secret_key
    $('newslug').value = ''; $('newname').value = ''
    await loadApps(); await loadAudit()
  } catch (error) { fail(error.message) }
})

$('mint').addEventListener('click', async () => {
  clearFail()
  try {
    const made = await api('POST', '/v1/dev/apps/' + encodeURIComponent(currentApp) + '/keys',
      { kind: $('kind').value, name: $('kname').value.trim() || undefined })
    $('mintout').classList.remove('hidden')
    $('mintout').textContent = made.key
    $('kname').value = ''
    await loadKeys(currentApp); await loadAudit()
  } catch (error) { fail(error.message) }
})

$('revokeothers').addEventListener('click', async () => {
  clearFail()
  try {
    const res = await api('POST', '/v1/dev/sessions/revoke-others')
    await loadSessions()
    fail('Ended ' + (res.revoked ?? 0) + ' other session(s).')
  } catch (error) { fail(error.message) }
})

boot().catch((error) => fail(error.message))
</script>
</body></html>`

console_.get('/dashboard', (c) => c.html(PAGE))
