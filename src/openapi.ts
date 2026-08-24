import { app } from './index'
import { CATALOGUE } from './catalogue'
import type { Entry } from './catalogue'

/**
 * The OpenAPI document, built from `catalogue.ts`.
 *
 * The catalogue lives apart so the website can render the same list; see the
 * note there. This module turns it into OpenAPI 3.1 and checks it against the
 * router.
 */

export { CATALOGUE }
export type { Auth, Entry } from './catalogue'

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
