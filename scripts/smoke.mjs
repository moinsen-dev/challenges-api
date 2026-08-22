/**
 * Live smoke test: drives a RUNNING instance over real HTTP.
 *
 * The deep coverage lives in `npm run test:unit` (182 tests inside the Workers
 * runtime). This script answers a different question: is the thing that is
 * actually deployed reachable, wired and behaving?
 *
 *   BASE=http://127.0.0.1:8799 ADMIN_KEY=dev-admin-key node scripts/smoke.mjs
 *   BASE=https://challenges.moinsen.dev ADMIN_KEY=... node scripts/smoke.mjs
 */
const BASE = (process.env.BASE ?? 'http://127.0.0.1:8799').replace(/\/$/, '')
const ADMIN = process.env.ADMIN_KEY ?? 'dev-admin-key'

let failed = 0
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) failed++
}

async function call(method, path, { body, token, key, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (key) headers['X-App-Key'] = key
  if (admin) headers['X-Admin-Key'] = ADMIN
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

const stamp = Date.now().toString(36)
console.log(`\nLive smoke test against ${BASE}\n`)

const status = await call('GET', '/v1/status')
check(status.status === 200 && status.body.service === 'challenges-api', 'service answers', status.body)
check(Array.isArray(status.body.capabilities), 'capabilities advertised')

const app = (await call('POST', '/v1/admin/apps', { admin: true, body: { slug: `smoke-${stamp}`, name: 'Smoke Test' } })).body
check(app.public_key?.startsWith('chapi_pk_') && app.secret_key?.startsWith('chapi_sk_'), 'app created with two keys', app)

const disc = await call('POST', '/v1/disciplines', {
  key: app.secret_key,
  body: { slug: 'score', name: 'Score', trust_tier: 1, qualifying_score: 100, max_title_level: 2 },
})
check(disc.status === 201, 'discipline created', disc.body)
check((await call('POST', '/v1/disciplines', { key: app.public_key, body: { slug: 'x', name: 'X' } })).status === 403,
  'public key cannot create disciplines')

const player = (await call('POST', '/v1/auth/anonymous', { key: app.public_key, body: { handle: `smoke-${stamp}` } })).body
check(Boolean(player.token), 'anonymous account created', player)

const region = await call('PATCH', '/v1/me/region', { key: app.public_key, token: player.token, body: { region_id: 'hh-altona' } })
check(region.status === 200, 'home district chosen', region.body)

const weak = await call('POST', '/v1/entries', { key: app.public_key, token: player.token, body: { discipline: 'score', value: 40 } })
check(weak.status === 201 && weak.body.qualified === false, 'entry below the bar stays unqualified', weak.body)
check((await call('GET', '/v1/leaderboards/score?region=hh-altona', { key: app.public_key })).body.entries?.length === 0,
  'leaderboard hides unqualified players')

const passed = await call('POST', '/v1/entries', { key: app.public_key, token: player.token, body: { discipline: 'score', value: 500 } })
check(passed.body.qualified_now === true, 'exam passed', passed.body)
check(passed.body.rank?.region?.rank === 1, 'ranked first in the district', passed.body.rank)

const board = await call('GET', '/v1/leaderboards/score?region=hh-altona', { key: app.public_key })
check(board.body.entries?.length === 1 && board.body.entries?.[0]?.handle === player.handle, 'leaderboard shows the player', board.body)
check(board.body.title_eligible === false, 'no title without enough contenders', board.body)

const me = await call('GET', '/v1/me', { key: app.public_key, token: player.token })
check(me.status === 200 && me.body.qualifications?.length === 1, 'profile reflects the qualification', me.body.qualifications)

const exported = await call('GET', '/v1/me/export', { key: app.public_key, token: player.token })
check(exported.status === 200 && exported.body.entries?.length === 2, 'data export works', Object.keys(exported.body))

check((await call('GET', '/v1/me', { key: app.public_key })).status === 401, 'no profile without a token')
check((await call('POST', '/v1/entries', { token: player.token, body: { discipline: 'score', value: 1 } })).status === 401,
  'no entry without an app key')
check((await call('POST', '/v1/admin/apps', { body: { slug: 'x', name: 'x' } })).status === 401, 'no app without the admin key')

const deleted = await call('DELETE', '/v1/me', { key: app.public_key, token: player.token })
check(deleted.status === 200, 'account deleted again', deleted.body)
check((await call('GET', '/v1/me', { key: app.public_key, token: player.token })).status === 401, 'token is worthless afterwards')

console.log(`\n${failed === 0 ? 'LIVE SMOKE TEST PASSED' : `${failed} CHECK(S) FAILED`}\n`)
process.exit(failed === 0 ? 0 : 1)
