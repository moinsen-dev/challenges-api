/**
 * Minimal client for the Challenges API. Games, habit trackers and collector
 * apps all use the same code — the difference lives in the discipline.
 *
 *   const api = await connect({ base, appKey: 'pk_...' })
 *   await api.submit('score-attack', 12500)   // a game
 *   await api.submit('kilometres', 7.2)       // a running app
 *   const board = await api.leaderboard('score-attack', { region: api.regionId })
 *
 * Only the public key (pk_...) belongs in a client.
 */
export async function connect({ base, appKey, storageKey = 'challenges.token' }) {
  const store = globalThis.localStorage
  let token = store?.getItem(storageKey) ?? null

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': appKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok)
      throw Object.assign(new Error(json.error ?? res.statusText), { status: res.status, body: json })
    return json
  }

  const remember = (t) => {
    token = t
    store?.setItem(storageKey, t)
  }

  if (!token) remember((await call('POST', '/v1/auth/anonymous', {})).token)
  let me = await call('GET', '/v1/me')

  return {
    get me() {
      return me
    },
    get regionId() {
      return me.region?.id ?? null
    },
    refresh: async () => (me = await call('GET', '/v1/me')),

    catalog: () => call('GET', '/v1/catalog'),
    chooseRegion: (regionId) => call('PATCH', '/v1/me/region', { region_id: regionId }),

    submit: (discipline, value, opts = {}) =>
      call('POST', '/v1/entries', { discipline, value, ...opts }),
    status: (discipline) => call('GET', `/v1/disciplines/${discipline}/me`),
    leaderboard: (discipline, { region, limit = 25 } = {}) =>
      call('GET', `/v1/leaderboards/${discipline}?limit=${limit}${region ? `&region=${region}` : ''}`),
    daily: (discipline) => call('GET', `/v1/daily/${discipline}`),

    challenge: (discipline, opponentHandle) =>
      call('POST', '/v1/challenges', { discipline, opponent_handle: opponentHandle }),
    challenges: () => call('GET', '/v1/challenges'),
    accept: (challengeId) => call('POST', `/v1/challenges/${challengeId}/accept`),

    collection: (slug) => call('GET', `/v1/collections/${slug}`),
    ratings: (discipline) => call('GET', `/v1/ratings/${discipline}`),
    events: (since = 0) => call('GET', `/v1/events?since=${since}`),

    /** Carry the identity to another device or another app. */
    linkCode: () => call('POST', '/v1/me/link-code'),
    redeem: async (code) => {
      const claimed = await call('POST', '/v1/auth/redeem', { code })
      remember(claimed.token)
      me = await call('GET', '/v1/me')
      return me
    },
  }
}
