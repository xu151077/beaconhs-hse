import 'server-only'

// The built-in BHQL widgets, materialized as REAL published insight_cards (one
// per tenant, idempotent upsert by name). This makes them first-class cards —
// visible in the Library, editable, publishable, pinnable — and a single source
// of truth: the Overview references the same card rows (via the systemKey→id map)
// rather than a separate hard-coded query.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { insightCards, type BhqlQuery } from '@beaconhs/db/schema'
import type { RequestContext } from '@beaconhs/tenant'
import { validateTrustedSystemBhql } from '@beaconhs/analytics/server'
import { BUILTIN_QUERIES, INSIGHT_WIDGET_MAP } from './_widgets'

type SystemCard = {
  id: string
  name: string
  query: BhqlQuery
  vizType: string
  vizSettings: Record<string, unknown>
  /** True only for the built-ins whose query reads the withheld tenant-wide
   *  `app_responses` source. See `queryUsesAppResponses`. */
  trustedSystemCard: boolean
}

/**
 * Does this BHQL query read the tenant-wide `app_responses` source?
 *
 * That source is withheld from `scopeAnalyticsEntities` and only re-added for a
 * "trusted system card", which `canReadAppResponses` then gates on
 * `forms.response.read.all`. So the question is not "is this a built-in" but
 * "does this query need the withheld source" — the two are different sets.
 *
 * `metricRefs` are deliberately not followed: resolving one needs the metric
 * card's own query, which is a DB read, and no built-in references a metric.
 * A card that reaches `app_responses` that way fails on the unknown entity
 * rather than reading tenant-wide rows, so the answer stays fail-closed.
 */
export function queryUsesAppResponses(query: BhqlQuery): boolean {
  return query.stages.some(
    (stage) =>
      stage.source === 'app_responses' ||
      (stage.joinedSources ?? []).some((j) => j.source === 'app_responses') ||
      (stage.spine?.dimensions ?? []).some((d) => d.source === 'app_responses') ||
      (stage.spine?.facts ?? []).some((f) => f.source === 'app_responses'),
  )
}

/**
 * Key-order-independent JSON, for comparing a query literal with a stored row.
 *
 * A system card's `query` is `jsonb`, and Postgres does not preserve key order —
 * it reorders object keys by length then bytewise, so the same query read back
 * from the database stringifies differently than the object literal that produced
 * it. Comparing `JSON.stringify(a) === JSON.stringify(b)` therefore fails for
 * structurally identical queries, which is why the trusted-card match below
 * needed a canonical form.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * Normalise a query for comparison: parse it, then canonicalise the key order.
 *
 * Both sides go through this so the match means "same query" rather than "same
 * JSON key order and optionality". Both transformations are needed:
 * `validateTrustedSystemBhql` materialises optionals the literal omits (a stage
 * gains `limit: null`), and Postgres `jsonb` — which is where a stored card's
 * query comes from — reorders object keys by length then bytewise. Comparing raw
 * `JSON.stringify` output therefore failed for every structurally identical
 * query, which is what left this function returning false for all seeded cards.
 *
 * A query that fails validation is NOT trusted. Trust re-admits a withheld
 * tenant-wide source, so an unparseable query must fail closed rather than throw
 * out of a render path.
 */
function normalizedQueryJson(query: BhqlQuery): string | null {
  try {
    return canonicalJson(validateTrustedSystemBhql(query))
  } catch {
    return null
  }
}

export function isTrustedSystemCard(card: {
  name: string
  query: BhqlQuery
  createdBy?: string | null
}): boolean {
  if (card.createdBy !== null) return false
  const stored = normalizedQueryJson(card.query)
  if (stored === null) return false
  const matched = Object.entries(BUILTIN_QUERIES).find(
    ([key, builtin]) =>
      INSIGHT_WIDGET_MAP.get(key)?.label === card.name &&
      normalizedQueryJson(builtin.query) === stored,
  )
  // Being a seeded built-in is NOT what makes a card trusted. Trust exists only
  // to re-admit `app_responses`, so a built-in that counts corrective actions or
  // inspection records must not inherit the gate — otherwise `runCardCached`
  // refuses it with "Not authorized to read app responses" for exactly the
  // site-scoped viewers who are entitled to those counts, and the foreman's
  // default dashboard renders three error tiles. `analytics-access.ts` states
  // the intended scope: "Tenant-wide covers exactly two built-in cards".
  return matched !== undefined && queryUsesAppResponses(matched[1].query)
}

/** Ensure the BHQL built-ins exist as published Cards for this tenant. Returns
 *  systemKey → Card so the Overview layout can be remapped onto the real ids. */
export async function ensureSystemCards(ctx: RequestContext): Promise<Map<string, SystemCard>> {
  const defs = Object.entries(BUILTIN_QUERIES).map(([key, b]) => ({
    key,
    name: INSIGHT_WIDGET_MAP.get(key)?.label ?? key,
    description: INSIGHT_WIDGET_MAP.get(key)?.description ?? null,
    query: validateTrustedSystemBhql(b.query),
    vizType: b.vizType,
    vizSettings: b.vizSettings ?? {},
  }))
  const names = defs.map((d) => d.name)

  const select = {
    id: insightCards.id,
    name: insightCards.name,
    query: insightCards.query,
    vizType: insightCards.vizType,
    vizSettings: insightCards.vizSettings,
  }

  // Select + de-dupe + insert in ONE transaction, guarded by a per-tenant
  // advisory lock: ensureSystemCards runs on both /insights and /insights/library,
  // and a fresh server can fire several first-loads at once — without the lock the
  // select-then-insert races and double-seeds. The lock releases at commit.
  const byName = await ctx.db(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':insight-system'))`,
    )

    const existing = await tx
      .select(select)
      .from(insightCards)
      .where(
        and(
          eq(insightCards.tenantId, ctx.tenantId),
          isNull(insightCards.createdBy), // system cards only
          isNull(insightCards.deletedAt),
          inArray(insightCards.name, names),
        ),
      )
      .orderBy(asc(insightCards.createdAt))

    // Keep the oldest card per name; soft-delete any duplicates (self-heals rows
    // a previous unlocked seed may have double-inserted).
    const keep = new Map<string, (typeof existing)[number]>()
    const dupeIds: string[] = []
    for (const c of existing) {
      if (keep.has(c.name)) dupeIds.push(c.id)
      else keep.set(c.name, c)
    }
    if (dupeIds.length > 0) {
      await tx
        .update(insightCards)
        .set({ deletedAt: new Date() })
        .where(inArray(insightCards.id, dupeIds))
    }

    const missing = defs.filter((d) => !keep.has(d.name))
    if (missing.length > 0) {
      const inserted = await tx
        .insert(insightCards)
        .values(
          missing.map((d) => ({
            tenantId: ctx.tenantId,
            createdBy: null,
            name: d.name,
            description: d.description,
            query: d.query,
            vizType: d.vizType,
            vizSettings: d.vizSettings,
            status: 'published' as const,
            publishedAt: new Date(),
          })),
        )
        .returning(select)
      for (const c of inserted) keep.set(c.name, c)
    }

    // Refresh existing system cards whose definition drifted from BUILTIN_QUERIES
    // (e.g. a built-in query was rewritten to drop a view dependency). System
    // cards are the canonical, managed copy, so the stored row is brought back in
    // line with the code definition.
    for (const d of defs) {
      const c = keep.get(d.name)
      if (!c) continue
      const drifted =
        JSON.stringify(c.query) !== JSON.stringify(d.query) ||
        c.vizType !== d.vizType ||
        JSON.stringify(c.vizSettings ?? {}) !== JSON.stringify(d.vizSettings ?? {})
      if (drifted) {
        await tx
          .update(insightCards)
          .set({ query: d.query, vizType: d.vizType, vizSettings: d.vizSettings })
          .where(eq(insightCards.id, c.id))
        keep.set(d.name, { ...c, query: d.query, vizType: d.vizType, vizSettings: d.vizSettings })
      }
    }
    return keep
  })

  const map = new Map<string, SystemCard>()
  for (const d of defs) {
    const c = byName.get(d.name)
    if (c) {
      map.set(d.key, {
        id: c.id,
        name: c.name,
        query: c.query,
        vizType: c.vizType,
        vizSettings: (c.vizSettings ?? {}) as Record<string, unknown>,
        // Only the built-ins that actually read the withheld `app_responses`
        // source are trusted. Stamping every system card `true` made the
        // `canReadAppResponses` gate fire on cards that never touch it — a
        // site-scoped foreman is entitled to the CA and inspection counts, but
        // was refused with "Not authorized to read app responses", so three
        // tiles of their default dashboard rendered as errors.
        trustedSystemCard: queryUsesAppResponses(c.query),
      })
    }
  }
  return map
}
