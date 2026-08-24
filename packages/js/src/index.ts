/**
 * Challenges API — JavaScript / TypeScript client.
 *
 * Works in a browser, in a Worker and in Node. Only the public key belongs in
 * a client; anything needing authority (disciplines, duels, collectibles) is a
 * server call and deliberately absent from this package.
 */

export type Aggregation = 'best' | 'sum' | 'count' | 'streak'

export type Rank = { rank: number; of: number; value: number } | null

export type EntryResult = {
  entry_id: string
  status: 'counted' | 'review'
  value: number
  aggregate: number
  aggregation: Aggregation
  qualified: boolean
  qualified_now: boolean
  qualifying_score: number | null
  rank: { region: Rank; global: Rank } | null
  streak_days: number | null
  settled_challenges: string[]
  badges_earned: { id: string; name: string }[]
  duplicate?: boolean
  /** 'pending' while a submitted trace is waiting to be re-simulated. */
  verification?: 'none' | 'pending' | 'verified' | 'failed'
  job?: string
}

export type EntryVerdict = {
  id: string
  discipline: string
  value: number
  status: 'counted' | 'review' | 'rejected'
  verification: 'none' | 'pending' | 'verified' | 'failed'
  verdict: 'verified' | 'failed' | null
  computed_value: number | null
  detail: string | null
}

export type Standing = { rank: number; player_id: string; handle: string; value: number; since: string }

export type Leaderboard = {
  discipline: string
  unit: string | null
  aggregation: Aggregation
  trust_tier: number
  region: string
  scope: 'all' | 'friends'
  season: string
  contenders: number
  title_min_players: number
  title_eligible: boolean
  /** Pass back as `cursor` for the next page. Null means this was the last. */
  cursor: string | null
  entries: Standing[]
}

export type Neighbourhood = {
  discipline: string
  region: string
  rank: number
  of: number
  rows: (Standing & { you: boolean })[]
}

export type DisciplineStatus = {
  discipline: string
  aggregation: Aggregation
  unit: string | null
  value: number | null
  qualifying_score: number | null
  qualified: boolean
  streak_days: number
  rank: { region: Rank; global: Rank }
}

export type Profile = {
  player: {
    id: string
    handle: string
    display_name: string | null
    avatar: string | null
    locale: string | null
    featured_title: string | null
    featured_badge: string | null
    status: 'active' | 'suspended' | 'banned'
    invites_left: number
  }
  season: { id: string; name: string; ends_at: string } | null
  region: { id: string; name: string; level: number } | null
  apps: { slug: string; name: string }[]
  qualifications: { app: string; discipline: string; value_at: number; achieved_at: string }[]
  badges: { id: string; name: string; description: string; earned_at: string }[]
  titles: { id: string; level: number; region: string; discipline: string; app: string; contenders: number }[]
  items_owned: number
}

export type Challenge = {
  id: string
  discipline: string
  target_value: number
  state: 'open' | 'accepted' | 'settled' | 'expired'
  ranked: boolean
  expires_at: string
  challenger: string
  opponent: string | null
  winner: string | null
}

export type PlatformEvent = { id: number; type: string; payload: unknown; created_at: string }

/** Everything this client throws. The API's plain-words message is `message`. */
export class ChallengesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'ChallengesError'
  }

  /** True when the player must sign in again — the token is gone or invalid. */
  get needsSignIn() {
    return this.status === 401
  }
}

export type TokenStore = {
  get(): string | null
  set(token: string): void
  clear(): void
}

/** localStorage when there is one, memory otherwise. Never throws. */
function defaultStore(key: string): TokenStore {
  let memory: string | null = null
  const ls = (() => {
    try {
      const store = globalThis.localStorage
      store?.getItem(key)
      return store
    } catch {
      return null
    }
  })()
  return {
    get: () => (ls ? ls.getItem(key) : memory),
    set: (token) => (ls ? ls.setItem(key, token) : void (memory = token)),
    clear: () => (ls ? ls.removeItem(key) : void (memory = null)),
  }
}

export type ClientOptions = {
  /** e.g. https://challenges-api.example.com — no trailing slash needed. */
  baseUrl: string
  /** The public key. A secret key in a client is a mistake, so this refuses one. */
  appKey: string
  /** Where the player token lives. Defaults to localStorage, else memory. */
  storage?: TokenStore
  /** Override for tests, Workers, or a custom retry layer. */
  fetch?: typeof fetch
}

export function createClient(options: ClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '')
  if (options.appKey.startsWith('chapi_sk_'))
    throw new Error('a secret key must never be used in a client — pass the public key')
  const store = options.storage ?? defaultStore('challenges.token')
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = store.get()
    const res = await doFetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': options.appKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { error: text }
    }
    if (!res.ok) {
      const message = (parsed as { error?: string })?.error ?? res.statusText
      // A revoked or deleted account should not leave a client in a loop.
      if (res.status === 401 && token) store.clear()
      throw new ChallengesError(message, res.status, parsed)
    }
    return parsed as T
  }

  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v))
    const s = search.toString()
    return s ? `?${s}` : ''
  }

  const client = {
    /** The token in use, if any. Useful for moving it somewhere else. */
    get token() {
      return store.get()
    },

    /** Sign in anonymously, or keep the token already stored. */
    async signIn(opts: { handle?: string; inviteCode?: string; force?: boolean } = {}) {
      if (store.get() && !opts.force) return client.me()
      const created = await call<{ player_id: string; handle: string; token: string }>(
        'POST',
        '/v1/auth/anonymous',
        { handle: opts.handle, invite_code: opts.inviteCode },
      )
      store.set(created.token)
      return client.me()
    },

    /** Adopt a token minted elsewhere — another device, another app. */
    useToken(token: string) {
      store.set(token)
    },
    signOut() {
      store.clear()
    },

    me: () => call<Profile>('GET', '/v1/me'),
    catalog: () =>
      call<{
        app: { slug: string; name: string }
        season: { id: string; name: string; ends_at: string } | null
        disciplines: {
          slug: string
          name: string
          category: string
          unit: string | null
          aggregation: Aggregation
          trust_tier: number
          qualifying_score: number | null
        }[]
        regions: { id: string; parent_id: string | null; level: number; name: string }[]
        collections: { slug: string; name: string }[]
      }>('GET', '/v1/catalog'),

    /**
     * Which district a position is in.
     *
     * The position is sent once and kept by nobody: the service does not store
     * it, and this client does not either. What comes back is a district id you
     * can hand to `chooseRegion`, plus — when that district is not open yet —
     * how many people are still waiting for it to open.
     *
     * Needs no signed-in player, so a game may ask before anybody has an
     * account.
     */
    resolveRegion: (lat: number, lon: number) =>
      call<{
        region: { id: string; name: string; level: number }
        chain: { id: string; name: string; level: number; active: number }[]
        open: boolean
        waiting?: number
        threshold?: number
        missing?: number
        competes_in?: string | null
      }>('GET', `/v1/regions/resolve?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`),

    chooseRegion: (regionId: string) =>
      call<{ region: { id: string; name: string }; locked_until: string }>('PATCH', '/v1/me/region', {
        region_id: regionId,
      }),

    submit: (
      discipline: string,
      value: number,
      opts: {
        occurredAt?: string | Date
        meta?: unknown
        idemKey?: string
        /**
         * The input trace that produced this value. Required once a discipline
         * can prove its runs: the score is re-simulated from it, and only
         * agreement counts.
         */
        trace?: Uint8Array | string
      } = {},
    ) =>
      call<EntryResult>('POST', '/v1/entries', {
        discipline,
        value,
        occurred_at:
          opts.occurredAt instanceof Date ? opts.occurredAt.toISOString() : opts.occurredAt,
        meta: opts.meta,
        idem_key: opts.idemKey,
        trace:
          opts.trace instanceof Uint8Array
            ? btoa(String.fromCharCode(...opts.trace))
            : opts.trace,
      }),

    /** What became of one entry — the other half of a held submission. */
    entry: (entryId: string) => call<EntryVerdict>('GET', `/v1/entries/${encodeURIComponent(entryId)}`),

    /** Wait for a verdict on a held run, or give up saying so. */
    async awaitVerdict(entryId: string, opts: { pollMs?: number; timeoutMs?: number } = {}) {
      const until = Date.now() + (opts.timeoutMs ?? 30_000)
      while (Date.now() < until) {
        const entry = await client.entry(entryId)
        if (entry.verification !== 'pending') return entry
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1000))
      }
      return { ...(await client.entry(entryId)), verification: 'pending' as const }
    },

    status: (discipline: string) =>
      call<DisciplineStatus>('GET', `/v1/disciplines/${encodeURIComponent(discipline)}/me`),

    leaderboard: (
      discipline: string,
      opts: { region?: string; scope?: 'friends'; limit?: number; cursor?: string | null } = {},
    ) =>
      call<Leaderboard>(
        'GET',
        `/v1/leaderboards/${encodeURIComponent(discipline)}` +
          query({
            region: opts.region,
            scope: opts.scope,
            limit: opts.limit,
            cursor: opts.cursor ?? undefined,
          }),
      ),

    /**
     * The rows immediately around you — what a game actually shows. Costs the
     * same whether you are 4th or 40,000th.
     */
    around: (discipline: string, opts: { region?: string; span?: number } = {}) =>
      call<Neighbourhood>(
        'GET',
        `/v1/leaderboards/${encodeURIComponent(discipline)}/around` +
          query({ region: opts.region, span: opts.span }),
      ),

    /** Walk a whole board page by page, without holding it all in memory. */
    async *allStandings(
      discipline: string,
      opts: { region?: string; pageSize?: number } = {},
    ): AsyncGenerator<Standing> {
      let cursor: string | null = null
      do {
        const page: Leaderboard = await client.leaderboard(discipline, {
          region: opts.region,
          limit: opts.pageSize ?? 50,
          cursor,
        })
        for (const row of page.entries) yield row
        cursor = page.cursor
      } while (cursor)
    },

    daily: (discipline: string, date?: string) =>
      call<{ discipline: string; date: string; seed: number; seed_hex: string }>(
        'GET',
        `/v1/daily/${encodeURIComponent(discipline)}` + query({ date }),
      ),

    ratings: (discipline: string) =>
      call<{ discipline: string; ratings: { handle: string; rating: number; rd: number; matches: number }[] }>(
        'GET',
        `/v1/ratings/${encodeURIComponent(discipline)}`,
      ),

    challenge: (discipline: string, opts: { opponent?: string; expiresInHours?: number } = {}) =>
      call<{ id: string; discipline: string; target_value: number; ranked: boolean; expires_at: string }>(
        'POST',
        '/v1/challenges',
        { discipline, opponent_handle: opts.opponent, expires_in_hours: opts.expiresInHours },
      ),
    challenges: () => call<{ challenges: Challenge[] }>('GET', '/v1/challenges'),
    accept: (challengeId: string) =>
      call<{ id: string; state: string }>('POST', `/v1/challenges/${challengeId}/accept`),

    players: (prefix: string) =>
      call<{ players: { id: string; handle: string; display_name: string | null }[] }>(
        'GET',
        `/v1/players${query({ q: prefix })}`,
      ),
    player: (handle: string) =>
      call<{ id: string; handle: string; display_name: string | null; badges: unknown[]; titles: unknown[] }>(
        'GET',
        `/v1/players/${encodeURIComponent(handle)}`,
      ),

    profile: {
      update: (patch: {
        display_name?: string | null
        avatar?: string | null
        locale?: string | null
        featured_title?: string | null
        featured_badge?: string | null
      }) => call<Profile['player']>('PATCH', '/v1/me/profile', patch),
      changeHandle: (handle: string) =>
        call<{ handle: string; next_change_after_days: number }>('PATCH', '/v1/me/handle', { handle }),
    },

    rivals: {
      list: () => call<{ follows: { handle: string; display_name: string | null }[] }>('GET', '/v1/me/follows'),
      add: (handle: string) => call<{ following: string }>('POST', `/v1/me/follows/${encodeURIComponent(handle)}`),
      remove: (handle: string) =>
        call<{ unfollowed: string }>('DELETE', `/v1/me/follows/${encodeURIComponent(handle)}`),
    },

    blocks: {
      list: () => call<{ blocks: { handle: string }[] }>('GET', '/v1/me/blocks'),
      add: (handle: string) => call<{ blocked: string }>('POST', `/v1/me/blocks/${encodeURIComponent(handle)}`),
      remove: (handle: string) =>
        call<{ unblocked: string }>('DELETE', `/v1/me/blocks/${encodeURIComponent(handle)}`),
    },

    report: (handle: string, reason: 'handle' | 'cheating' | 'harassment' | 'other', detail?: string) =>
      call<{ id: string; state: string }>('POST', '/v1/reports', { handle, reason, detail }),

    collection: (slug: string) =>
      call<{
        slug: string
        name: string
        total: number
        owned: number
        complete: boolean
        items: { slug: string; name: string; rarity: string; owned: number }[]
      }>('GET', `/v1/collections/${encodeURIComponent(slug)}`),

    waitlist: {
      join: (regionId: string) =>
        call<{ region: string; waiting: number; threshold: number; missing: number; opened: boolean }>(
          'POST',
          `/v1/waitlist/${encodeURIComponent(regionId)}`,
        ),
      regions: () =>
        call<{ regions: { id: string; name: string; level: number; waiting: number; missing: number }[] }>(
          'GET',
          '/v1/waitlist',
        ),
    },

    invites: {
      mine: () =>
        call<{ invites_left: number; outstanding: number; joined_through_you: number }>('GET', '/v1/me/invites'),
      create: () => call<{ code: string; invites_left: number }>('POST', '/v1/me/invites'),
    },

    /** Move this identity to another device or another app of the platform. */
    linkCode: () => call<{ code: string; expires_at: string }>('POST', '/v1/me/link-code'),
    async redeemLinkCode(code: string) {
      const claimed = await call<{ id: string; handle: string; token: string }>('POST', '/v1/auth/redeem', {
        code,
      })
      store.set(claimed.token)
      return client.me()
    },

    events: (since = 0) =>
      call<{ events: PlatformEvent[]; cursor: number }>('GET', `/v1/events${query({ since })}`),

    /**
     * Live events over SSE, with polling as the fallback.
     *
     * The signature is the same either way: hand it a callback, get a stop
     * function. `EventSource` cannot send headers, so the stream is read with
     * `fetch` — which also means a dropped connection resumes from the last id
     * rather than starting over.
     */
    watchLive(
      onEvent: (event: PlatformEvent) => void,
      opts: { since?: number; onError?: (error: unknown) => void } = {},
    ) {
      let cursor = opts.since ?? 0
      let stopped = false
      const controller = new AbortController()

      const run = async () => {
        while (!stopped) {
          try {
            const token = store.get()
            const res = await doFetch(`${base}/v1/events/stream`, {
              headers: {
                'X-App-Key': options.appKey,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(cursor ? { 'Last-Event-ID': String(cursor) } : {}),
              },
              signal: controller.signal,
            })
            if (!res.ok || !res.body) throw new ChallengesError('stream refused', res.status, null)

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (!stopped) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })

              let split
              while ((split = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, split)
                buffer = buffer.slice(split + 2)
                // Comment frames are keep-alives; ignore them.
                if (frame.startsWith(':')) continue
                const data = frame.match(/^data: (.*)$/m)?.[1]
                if (!data) continue
                try {
                  const event = JSON.parse(data)
                  if (typeof event.id === 'number') {
                    cursor = event.id
                    onEvent(event as PlatformEvent)
                  }
                } catch {
                  // A frame we cannot read is not worth ending the stream over.
                }
              }
            }
          } catch (error) {
            if (stopped) return
            opts.onError?.(error)
          }
          // The server closes on purpose after a while; reconnect from where
          // we left off rather than replaying everything.
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      void run()

      return () => {
        stopped = true
        controller.abort()
      }
    },

    /**
     * Poll the event stream and hand each event to `onEvent`. Returns a stop
     * function. Use `watchLive` unless you need to control the interval.
     */
    watchEvents(onEvent: (event: PlatformEvent) => void, opts: { intervalMs?: number; since?: number } = {}) {
      let cursor = opts.since ?? 0
      let stopped = false
      const tick = async () => {
        if (stopped) return
        try {
          const page = await client.events(cursor)
          cursor = page.cursor
          for (const event of page.events) onEvent(event)
        } catch {
          // A poll that fails is not worth crashing a game over.
        }
        if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? 15000)
      }
      let timer = setTimeout(tick, 0)
      return () => {
        stopped = true
        clearTimeout(timer)
      }
    },

    presence: {
      /** Tell the platform you are around. Call it every 30–60 seconds. */
      here: (status: 'online' | 'playing' | 'away' = 'online', detail?: string) =>
        call<{ status: string; expires_in_seconds: number }>('POST', '/v1/me/presence', { status, detail }),
      /** A count of everyone, and names only for your own rivals. */
      list: () =>
        call<{ online: number; rivals: { handle: string; status: string; detail: string | null }[] }>(
          'GET',
          '/v1/presence',
        ),
    },

    queue: {
      join: (discipline: string, opts: { partyId?: string } = {}) =>
        call<{ ticket: string; state: 'waiting' | 'matched'; pairing: string | null }>('POST', '/v1/queue', {
          discipline,
          party_id: opts.partyId,
        }),
      check: (ticket: string) =>
        call<{
          ticket: string
          state: 'waiting' | 'matched' | 'cancelled' | 'expired'
          pairing?: string
          opponents?: { id: string; handle: string }[]
          /** Hand this to the match server; it verifies without calling us. */
          join_ticket?: string
          expires_at?: string
        }>('GET', `/v1/queue/${encodeURIComponent(ticket)}`),
      leave: (ticket: string) =>
        call<{ ticket: string; state: string }>('DELETE', `/v1/queue/${encodeURIComponent(ticket)}`),

      /** Join and wait until matched, cancelled or timed out. */
      async waitForMatch(discipline: string, opts: { pollMs?: number; timeoutMs?: number } = {}) {
        const joined = await client.queue.join(discipline)
        const until = Date.now() + (opts.timeoutMs ?? 120_000)
        while (Date.now() < until) {
          const state = await client.queue.check(joined.ticket)
          if (state.state !== 'waiting') return state
          await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1500))
        }
        await client.queue.leave(joined.ticket).catch(() => {})
        return { ticket: joined.ticket, state: 'expired' as const }
      },
    },

    tournaments: {
      list: () =>
        call<{
          tournaments: {
            slug: string
            name: string
            state: 'open' | 'running' | 'finished' | 'cancelled'
            discipline: string
            region: string | null
            entrants: number
            champion: string | null
          }[]
        }>('GET', '/v1/tournaments'),
      /** The whole bracket, drawable from this alone. */
      bracket: (slug: string) =>
        call<{
          slug: string
          name: string
          state: string
          region: string | null
          champion: string | null
          entrants: { handle: string; seed: number | null; state: 'in' | 'out' }[]
          bracket: {
            id: string
            round: number
            slot: number
            state: 'pending' | 'ready' | 'done' | 'bye'
            player_a: string | null
            player_b: string | null
            winner: string | null
          }[]
        }>('GET', `/v1/tournaments/${encodeURIComponent(slug)}`),
      join: (slug: string) =>
        call<{ tournament: string; entrants: number }>(
          'POST',
          `/v1/tournaments/${encodeURIComponent(slug)}/join`,
        ),
    },

    /**
     * The runs at the top of a board, with the trace each was made of — so a
     * player can race the district champion while they sleep. Only verified
     * runs have ghosts.
     */
    ghosts: (discipline: string, opts: { region?: string; limit?: number } = {}) =>
      call<{
        discipline: string
        region: string
        ghosts: {
          rank: number
          handle: string
          value: number
          entry_id: string
          recorded_at: string
          trace: string
        }[]
      }>(
        'GET',
        `/v1/ghosts/${encodeURIComponent(discipline)}` +
          query({ region: opts.region, limit: opts.limit }),
      ),

    /** The bytes of one ghost, ready to replay. */
    async ghostTrace(entryId: string): Promise<Uint8Array> {
      const res = await doFetch(`${base}/v1/ghosts/trace/${encodeURIComponent(entryId)}`, {
        headers: { 'X-App-Key': options.appKey },
      })
      if (!res.ok) throw new ChallengesError('no ghost for that entry', res.status, null)
      return new Uint8Array(await res.arrayBuffer())
    },

    titles: (opts: { region?: string; season?: string } = {}) =>
      call<{
        titles: {
          id: string
          handle: string
          discipline: string
          region: string
          level: number
          value_at: number
          contenders: number
          awarded_at: string
        }[]
      }>('GET', '/v1/titles' + query({ region: opts.region, season: opts.season })),

    /** A shareable image for one title. Public, no key needed to embed it. */
    titleCard: (titleId: string) => `${base}/v1/titles/${encodeURIComponent(titleId)}/card.svg`,

    /** Everything stored about this player, as JSON. */
    exportData: () => call<Record<string, unknown>>('GET', '/v1/me/export'),
    /** Irreversible. There is no trash bin. */
    async deleteAccount() {
      await call<{ deleted: boolean }>('DELETE', '/v1/me')
      store.clear()
    },
  }

  return client
}

export type ChallengesClient = ReturnType<typeof createClient>
