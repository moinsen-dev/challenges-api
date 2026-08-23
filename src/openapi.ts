import { app } from './index'

/**
 * The OpenAPI document.
 *
 * Written as a catalogue rather than generated from decorators, because the
 * interesting part of an API description is the sentence explaining what an
 * endpoint is for — and that has to be written by somebody either way.
 *
 * What keeps it honest is a test: every route Hono has registered must appear
 * here, and every entry here must exist in Hono. A specification that silently
 * drifts is worse than none, because people build against it.
 */

type Auth = 'public' | 'app' | 'secret' | 'player' | 'admin' | 'developer'

type Entry = [method: string, path: string, auth: Auth, tag: string, summary: string]

export const CATALOGUE: Entry[] = [
  ['GET', '/v1/status', 'public', 'Meta', 'Service identity and the capabilities this instance has'],
  ['GET', '/v1/openapi.json', 'public', 'Meta', 'This document, describing every endpoint of this instance'],
  ['GET', '/v1/health', 'public', 'Meta', 'Health, with the checks actually performed and the queue depths'],

  // -------------------------------------------------------------- identity
  ['POST', '/v1/auth/anonymous', 'app', 'Identity', 'Create an account in one call, no personal data required'],
  ['POST', '/v1/me/link-code', 'player', 'Identity', 'Mint a one-time code to carry this identity elsewhere'],
  ['POST', '/v1/auth/redeem', 'app', 'Identity', 'Redeem a link code on another device or app'],
  ['GET', '/v1/me', 'player', 'Identity', 'Own profile: qualifications, badges, titles, region'],
  ['GET', '/v1/me/export', 'player', 'Identity', 'Everything stored about this player, as JSON'],
  ['DELETE', '/v1/me', 'player', 'Identity', 'Delete the account, irreversibly and completely'],
  ['PATCH', '/v1/me/region', 'player', 'Identity', 'Choose a home district; locked for the season'],
  ['PATCH', '/v1/me/profile', 'player', 'Identity', 'Display name, avatar, locale, featured title or badge'],
  ['PATCH', '/v1/me/handle', 'player', 'Identity', 'Change the handle; locked for 30 days afterwards'],
  ['GET', '/v1/players', 'app', 'Identity', 'Find other players by the start of their handle'],
  ['GET', '/v1/players/:handle', 'app', 'Identity', 'Public profile: titles and badges only'],
  ['GET', '/v1/catalog', 'app', 'Identity', 'Disciplines, regions, season and collections of this app'],

  // -------------------------------------------------------------- recovery
  ['POST', '/v1/me/passkeys/challenge', 'player', 'Recovery', 'Start adding a passkey to this account'],
  ['POST', '/v1/me/passkeys', 'player', 'Recovery', 'Register a passkey for this account'],
  ['GET', '/v1/me/passkeys', 'player', 'Recovery', 'The passkeys that can sign in to this account'],
  ['DELETE', '/v1/me/passkeys/:id', 'player', 'Recovery', 'Remove one passkey from this account'],
  ['POST', '/v1/auth/passkey/challenge', 'app', 'Recovery', 'Start signing in with a passkey'],
  ['POST', '/v1/auth/passkey', 'app', 'Recovery', 'Sign in on a device that never held a token'],
  ['GET', '/v1/me/sessions', 'player', 'Recovery', 'Sessions currently able to act as this player'],
  ['POST', '/v1/me/sessions/revoke-others', 'player', 'Recovery', 'End every session but this one'],
  ['POST', '/v1/me/recovery-email', 'player', 'Recovery', 'Attach an optional rescue address'],
  ['DELETE', '/v1/me/recovery-email', 'player', 'Recovery', 'Remove the rescue address'],
  ['GET', '/v1/auth/recovery/confirm', 'public', 'Recovery', 'Confirm a rescue address from its email'],
  ['POST', '/v1/auth/recover', 'app', 'Recovery', 'Ask for a recovery link; the answer never says whether one was sent'],
  ['GET', '/v1/auth/recover/callback', 'app', 'Recovery', 'Recover an account and end every other session'],

  // ----------------------------------------------------------- competition
  ['POST', '/v1/entries', 'player', 'Competition', 'Submit one entry, with a trace where the discipline verifies'],
  ['GET', '/v1/entries/:id', 'player', 'Competition', 'What became of one entry, including a verdict'],
  ['GET', '/v1/disciplines/:discipline/me', 'player', 'Competition', 'Own value, rank, streak and exam status'],
  ['GET', '/v1/leaderboards/:discipline', 'app', 'Competition', 'A board, by region, friends or globally; cursor paged'],
  ['GET', '/v1/leaderboards/:discipline/around', 'player', 'Competition', 'The rows immediately around you'],
  ['GET', '/v1/daily/:discipline', 'app', 'Competition', 'The day seed, identical worldwide'],
  ['GET', '/v1/ratings/:discipline', 'app', 'Competition', 'Glicko-2 ratings for a head-to-head discipline'],
  ['POST', '/v1/challenges', 'player', 'Competition', 'Challenge somebody, or leave an open invitation'],
  ['POST', '/v1/challenges/:id/accept', 'player', 'Competition', 'Accept a challenge that was aimed at you'],
  ['GET', '/v1/challenges', 'player', 'Competition', 'Challenges you are part of, open and settled'],
  ['GET', '/v1/collections/:slug', 'player', 'Competition', 'A collection with your own holdings'],
  ['GET', '/v1/titles', 'app', 'Competition', 'The title archive'],
  ['GET', '/v1/titles/:id/card.svg', 'public', 'Competition', 'A title as a shareable image'],

  // ---------------------------------------------------------------- social
  ['POST', '/v1/me/follows/:handle', 'player', 'Social', 'Follow a rival, without asking their permission'],
  ['DELETE', '/v1/me/follows/:handle', 'player', 'Social', 'Stop following somebody'],
  ['GET', '/v1/me/follows', 'player', 'Social', 'The people whose scores you want to see next to yours'],
  ['POST', '/v1/me/blocks/:handle', 'player', 'Social', 'Block a person; cuts contact, never results'],
  ['DELETE', '/v1/me/blocks/:handle', 'player', 'Social', 'Lift a block and allow contact again'],
  ['GET', '/v1/me/blocks', 'player', 'Social', 'People you have cut contact with'],
  ['POST', '/v1/reports', 'player', 'Social', 'Report a person to the operator'],

  // ------------------------------------------------------------------ live
  ['GET', '/v1/events', 'player', 'Live', 'Own events, cursor based'],
  ['GET', '/v1/events/stream', 'player', 'Live', 'The same events as SSE, resumable via Last-Event-ID'],
  ['POST', '/v1/me/presence', 'player', 'Live', 'Say you are around; expires after 90 seconds'],
  ['GET', '/v1/presence', 'player', 'Live', 'How many are online, and which of them are your rivals'],
  ['POST', '/v1/queue', 'player', 'Live', 'Enter matchmaking and get a ticket to poll'],
  ['GET', '/v1/queue/:ticket', 'player', 'Live', 'Poll a ticket; carries a join ticket once matched'],
  ['DELETE', '/v1/queue/:ticket', 'player', 'Live', 'Leave the queue before anybody was matched'],

  // ------------------------------------------------------------- ceremony
  ['GET', '/v1/tournaments', 'app', 'Ceremony', 'Tournaments this app has run or is running'],
  ['GET', '/v1/tournaments/:slug', 'app', 'Ceremony', 'The whole bracket, drawable from this alone'],
  ['POST', '/v1/tournaments/:slug/join', 'player', 'Ceremony', 'Enter a tournament you have qualified for'],
  ['GET', '/v1/ghosts/:discipline', 'app', 'Ceremony', 'The runs at the top, with a link to each trace'],
  ['GET', '/v1/ghosts/trace/:entry', 'app', 'Ceremony', 'The bytes one verified run was made of'],

  // ---------------------------------------------------------------- access
  ['POST', '/v1/me/invites', 'player', 'Access', 'Spend one invite from your own allowance'],
  ['GET', '/v1/me/invites', 'player', 'Access', 'Invite allowance and who joined through you'],
  ['GET', '/v1/regions/resolve', 'app', 'Access', 'A position becomes a district; the position itself is not stored'],
  ['POST', '/v1/waitlist/:region', 'player', 'Access', 'Wait for a closed region; it opens itself at its threshold'],
  ['GET', '/v1/waitlist', 'app', 'Access', 'Closed regions, ordered by demand'],

  // ------------------------------------------------------------- developer
  ['POST', '/v1/disciplines', 'secret', 'Developer', 'Create a discipline, its aggregation and its exam'],
  ['POST', '/v1/disciplines/:slug/verifier', 'secret', 'Developer', 'Attach or detach a verifier module'],
  ['POST', '/v1/badges', 'secret', 'Developer', 'Create a badge scoped to this app'],
  ['POST', '/v1/collections', 'secret', 'Developer', 'Create a collection of things to find'],
  ['POST', '/v1/collections/:slug/items', 'secret', 'Developer', 'Define the items a collection is made of'],
  ['POST', '/v1/collections/:slug/grant', 'secret', 'Developer', 'Grant a collectible to a player'],
  ['POST', '/v1/matches', 'secret', 'Developer', 'Report a duel result; updates Glicko-2'],
  ['POST', '/v1/invites', 'secret', 'Developer', 'Mint invite codes for a closed app'],
  ['POST', '/v1/tournaments', 'secret', 'Developer', 'Create a tournament for one discipline'],
  ['POST', '/v1/tournaments/:slug/start', 'secret', 'Developer', 'Seed and start the bracket'],
  ['POST', '/v1/tournaments/:slug/matches/:id/result', 'secret', 'Developer', 'Decide one tournament match'],
  ['POST', '/v1/verifier/modules', 'secret', 'Developer', 'Upload a WebAssembly verifier module'],
  ['GET', '/v1/verifier/modules', 'secret', 'Developer', 'Verifier modules this app has uploaded'],
  ['GET', '/v1/verifier/usage', 'secret', 'Developer', 'Verified runs and CPU time, per day'],
  ['GET', '/v1/signing-secret', 'secret', 'Developer', 'The secret that verifies join tickets and signs webhooks'],
  ['POST', '/v1/tickets/verify', 'secret', 'Developer', 'Check a join ticket online instead of offline'],
  ['POST', '/v1/webhooks', 'secret', 'Developer', 'Register an endpoint to be told rather than asked'],
  ['GET', '/v1/webhooks', 'secret', 'Developer', 'Webhook endpoints, with delivery health'],
  ['DELETE', '/v1/webhooks/:id', 'secret', 'Developer', 'Switch a webhook endpoint off for good'],
  ['GET', '/v1/webhooks/:id/deliveries', 'secret', 'Developer', 'What was sent, what failed, and why'],

  // ------------------------------------------------------ developer console
  ['GET', '/v1/dev/auth/github', 'public', 'Console', 'Start signing in with GitHub'],
  ['GET', '/v1/dev/auth/github/callback', 'public', 'Console', 'Finish GitHub sign-in and set a session cookie'],
  ['POST', '/v1/dev/auth/email', 'public', 'Console', 'Send a magic link and a six-digit code'],
  ['GET', '/v1/dev/auth/email/callback', 'public', 'Console', 'Sign in from the emailed link'],
  ['POST', '/v1/dev/auth/email/verify', 'public', 'Console', 'Sign in with the emailed code'],
  ['POST', '/v1/dev/logout', 'developer', 'Console', 'End this console session'],
  ['GET', '/v1/dev/me', 'developer', 'Console', 'Developer account and app quota'],
  ['GET', '/v1/dev/sessions', 'developer', 'Console', 'Browser sessions signed in to this console'],
  ['POST', '/v1/dev/sessions/revoke-others', 'developer', 'Console', 'End every console session but this one'],
  ['POST', '/v1/dev/apps', 'developer', 'Console', 'Create an app and its first key pair'],
  ['GET', '/v1/dev/apps', 'developer', 'Console', 'The apps this developer account owns'],
  ['GET', '/v1/dev/apps/:slug/keys', 'developer', 'Console', 'Keys, with last use and revocation'],
  ['POST', '/v1/dev/apps/:slug/keys', 'developer', 'Console', 'Mint a key; rotation happens without a gap'],
  ['POST', '/v1/dev/keys/:id/revoke', 'developer', 'Console', 'Revoke a key, never the last of its kind'],
  ['GET', '/v1/dev/audit', 'developer', 'Console', 'What this developer did, in order'],

  // -------------------------------------------------------------- operator
  ['POST', '/v1/admin/apps', 'admin', 'Operator', 'Create an app and show its keys once'],
  ['PATCH', '/v1/admin/apps/:slug', 'admin', 'Operator', 'Access mode and invite allowance'],
  ['GET', '/v1/admin/apps', 'admin', 'Operator', 'Every app, with player and entry counts'],
  ['GET', '/v1/admin/apps/:slug', 'admin', 'Operator', 'Disciplines, activity and review cases'],
  ['POST', '/v1/admin/regions', 'admin', 'Operator', 'Add a region, open or closed with a threshold'],
  ['POST', '/v1/admin/regions/:id/unlock', 'admin', 'Operator', 'Open a region and notify its waitlist'],
  ['GET', '/v1/admin/regions/density', 'admin', 'Operator', 'Contenders per region, the number titles hang on'],
  ['POST', '/v1/admin/seasons', 'admin', 'Operator', 'Create a season for competition to happen in'],
  ['GET', '/v1/admin/seasons', 'admin', 'Operator', 'Seasons with entry and title counts'],
  ['GET', '/v1/admin/season', 'admin', 'Operator', 'The season currently open for entries'],
  ['POST', '/v1/admin/seasons/:id/close', 'admin', 'Operator', 'Award titles and open the next season'],
  ['POST', '/v1/admin/entries/:id/review', 'admin', 'Operator', 'Decide an entry that was held for review'],
  ['GET', '/v1/admin/reports', 'admin', 'Operator', 'Reports waiting for an operator decision'],
  ['POST', '/v1/admin/reports/:id/resolve', 'admin', 'Operator', 'Rename, suspend or ban'],
  ['POST', '/v1/admin/players/:handle/status', 'admin', 'Operator', 'Set a player status directly'],
  ['POST', '/v1/admin/badges', 'admin', 'Operator', 'Create a platform-wide badge'],
  ['GET', '/v1/admin/events', 'admin', 'Operator', 'Recent events across every app'],
  ['GET', '/v1/admin/invites', 'admin', 'Operator', 'Invite codes handed out across the platform'],
  ['POST', '/v1/admin/maintenance', 'admin', 'Operator', 'Retention sweep; meant for a daily cron'],
  ['POST', '/v1/admin/standings/rebuild', 'admin', 'Operator', 'Rebuild the standings projection from the ledger'],
  ['POST', '/v1/admin/webhooks/retry', 'admin', 'Operator', 'Retry deliveries that are due'],
  ['POST', '/v1/verifier/claim', 'admin', 'Verifier', 'Claim a batch of verification jobs to run'],
  ['GET', '/v1/verifier/blob/:kind/:key', 'admin', 'Verifier', 'Fetch a module or a trace to re-simulate'],
  ['POST', '/v1/verifier/jobs/:id/result', 'admin', 'Verifier', 'Report verified, failed or error'],
  ['GET', '/v1/verifier/jobs', 'admin', 'Verifier', 'Verification jobs and what became of them'],
]

const SECURITY: Record<Auth, unknown[]> = {
  public: [],
  app: [{ appKey: [] }],
  secret: [{ appSecret: [] }],
  player: [{ appKey: [], playerToken: [] }],
  admin: [{ adminKey: [] }],
  developer: [{ consoleSession: [] }],
}

const AUTH_NOTE: Record<Auth, string> = {
  public: 'No credential. Deliberately open so it can be embedded or linked.',
  app: 'The public app key. Belongs in a client.',
  secret: 'The secret app key. Belongs on a server, never in a client.',
  player: 'The public app key plus a player token.',
  admin: 'The operator key. Platform-wide authority.',
  developer: 'A console session cookie.',
}

/** Every route Hono knows about, in the same shape as the catalogue. */
/**
 * Routes that are not operations, and must not appear in the specification.
 *
 * Kept as an explicit list rather than a pattern: an exclusion nobody can see
 * is how a real endpoint eventually slips out of the document unnoticed. If a
 * route is here, somebody decided it is a page rather than an API call.
 */
const NOT_AN_OPERATION = new Set([
  'GET /dashboard', // the developer console: HTML for a person, not JSON for a program
])

export function registeredRoutes(): string[] {
  const seen = new Set<string>()
  for (const route of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
    if (route.method === 'ALL') continue
    const key = `${route.method} ${route.path}`
    if (NOT_AN_OPERATION.has(key)) continue
    seen.add(key)
  }
  return [...seen].sort()
}

const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z_]+)/g, '{$1}')

export function buildDocument(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const [method, path, auth, tag, summary] of CATALOGUE) {
    const openApiPath = toOpenApiPath(path)
    const parameters = [...path.matchAll(/:([A-Za-z_]+)/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))

    paths[openApiPath] ??= {}
    paths[openApiPath][method.toLowerCase()] = {
      tags: [tag],
      summary,
      description: AUTH_NOTE[auth],
      operationId: `${method.toLowerCase()}${openApiPath.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ''))}`,
      security: SECURITY[auth],
      ...(parameters.length ? { parameters } : {}),
      responses: {
        '200': { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        '401': { $ref: '#/components/responses/Unauthorised' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Challenges API',
      version: '1.0.0',
      summary: 'A shared competition layer for many small apps.',
      description: [
        'Identity, leaderboards, qualifications, challenges, badges, collections,',
        'ratings and geographic titles — from district to world.',
        '',
        'Five rules explain most answers:',
        '',
        '1. The ledger is the truth; everything else is derived.',
        '2. A qualification is the entrance — no exam passed, no place on a board.',
        '3. A title never reaches higher than its discipline trust tier.',
        '4. Two keys per app: `chapi_pk_` may live in a client, `chapi_sk_` never.',
        '5. A block cuts contact, never results.',
      ].join('\n'),
      license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
      contact: { name: 'Challenges API', url: 'https://challenges.moinsen.dev' },
    },
    servers: [{ url: origin, description: 'This instance' }],
    tags: [
      { name: 'Meta', description: 'What this instance is and can do' },
      { name: 'Identity', description: 'Accounts that need no personal data' },
      { name: 'Recovery', description: 'Passkeys, sessions and an optional rescue address' },
      { name: 'Competition', description: 'Entries, boards, challenges and titles' },
      { name: 'Social', description: 'Rivals, blocks and reports' },
      { name: 'Live', description: 'Events, presence and matchmaking' },
      { name: 'Ceremony', description: 'Tournaments, ghosts and title cards' },
      { name: 'Access', description: 'Invites and waitlists' },
      { name: 'Developer', description: 'Server-side calls; secret key only' },
      { name: 'Console', description: 'The developer console' },
      { name: 'Operator', description: 'Platform operations' },
      { name: 'Verifier', description: 'The replay verification queue' },
    ],
    components: {
      securitySchemes: {
        appKey: { type: 'apiKey', in: 'header', name: 'X-App-Key', description: 'Public key (chapi_pk_…)' },
        appSecret: { type: 'apiKey', in: 'header', name: 'X-App-Key', description: 'Secret key (chapi_sk_…)' },
        playerToken: { type: 'http', scheme: 'bearer', description: 'A player token, valid across every app' },
        adminKey: { type: 'apiKey', in: 'header', name: 'X-Admin-Key' },
        consoleSession: { type: 'apiKey', in: 'cookie', name: 'chapi_dev' },
      },
      responses: {
        Unauthorised: {
          description: 'Missing or refused credential',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        NotFound: {
          description: 'No such thing, or not yours to see',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string', description: 'Plain words, not a code to look up' } },
        },
        Standing: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            player_id: { type: 'string' },
            handle: { type: 'string' },
            value: { type: 'number' },
          },
        },
        Leaderboard: {
          type: 'object',
          properties: {
            discipline: { type: 'string' },
            aggregation: { type: 'string', enum: ['best', 'sum', 'count', 'streak'] },
            trust_tier: { type: 'integer', minimum: 0, maximum: 3 },
            verification: { type: 'string', enum: ['replay', 'none'] },
            region: { type: 'string' },
            contenders: { type: 'integer' },
            title_eligible: { type: 'boolean' },
            cursor: { type: ['string', 'null'] },
            entries: { type: 'array', items: { $ref: '#/components/schemas/Standing' } },
          },
        },
        EntryResult: {
          type: 'object',
          properties: {
            entry_id: { type: 'string' },
            status: { type: 'string', enum: ['counted', 'review', 'rejected'] },
            aggregate: { type: 'number' },
            qualified: { type: 'boolean' },
            qualified_now: { type: 'boolean' },
            verification: { type: 'string', enum: ['none', 'pending', 'verified', 'failed'] },
            streak_days: { type: ['integer', 'null'] },
            settled_challenges: { type: 'array', items: { type: 'string' } },
            badges_earned: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
    paths,
  }
}
