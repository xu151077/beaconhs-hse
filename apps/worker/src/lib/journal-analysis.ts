import { and, desc, eq, gte, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { analyseJournals } from '@beaconhs/ai'
import { db, withSuperAdmin, withTenant } from '@beaconhs/db'
import { journalAnalysisRuns, journalEntries, orgUnits, people, tenants } from '@beaconhs/db/schema'
import { enqueueAiJob, JOURNAL_ANALYSIS_PERIODS, type JournalAnalysisPeriod } from '@beaconhs/jobs'
import { resolveTenantAiConfig, tenantWantsAutomaticJournalAnalysis } from './tenant-ai-config'

const analysisAuthor = alias(people, 'analysis_author')

const STALE_AFTER_MS: Record<JournalAnalysisPeriod, number> = {
  7: 4 * 60 * 60 * 1000,
  30: 12 * 60 * 60 * 1000,
  90: 24 * 60 * 60 * 1000,
}

export async function scanJournalAnalysis(): Promise<{ enqueued: number; tenants: number }> {
  const tenantRows = await withSuperAdmin(db, (tx) =>
    tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active')),
  )
  let enqueued = 0
  for (const tenant of tenantRows) {
    if (!(await tenantWantsAutomaticJournalAnalysis(tenant.id))) continue
    if (!(await resolveTenantAiConfig(tenant.id))) continue
    for (const days of JOURNAL_ANALYSIS_PERIODS) {
      if (await enqueueIfStale(tenant.id, days)) enqueued += 1
    }
  }
  return { enqueued, tenants: tenantRows.length }
}

async function enqueueIfStale(tenantId: string, days: JournalAnalysisPeriod): Promise<boolean> {
  const now = Date.now()
  const latest = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        status: journalAnalysisRuns.status,
        createdAt: journalAnalysisRuns.createdAt,
        finishedAt: journalAnalysisRuns.finishedAt,
      })
      .from(journalAnalysisRuns)
      .where(and(eq(journalAnalysisRuns.days, days)))
      .orderBy(desc(journalAnalysisRuns.createdAt))
      .limit(1),
  )
  const row = latest[0]
  if (row && (row.status === 'pending' || row.status === 'running')) {
    // A run that never finalized (worker crash, or an exception before the
    // try/finalize guard in runJournalAnalysisJob) used to wedge this period
    // FOREVER: enqueueIfStale saw `running` on every future hourly tick. Once
    // it is older than the staleness window, retire it and let a fresh run in.
    const stale = row.status === 'running' && now - row.createdAt.getTime() >= STALE_AFTER_MS[days]
    if (!stale) return false
    await withTenant(db, tenantId, (tx) =>
      tx
        .update(journalAnalysisRuns)
        .set({
          status: 'failed',
          error: 'Run did not finish before its staleness deadline.',
          finishedAt: new Date(),
        })
        .where(and(eq(journalAnalysisRuns.days, days), eq(journalAnalysisRuns.status, 'running'))),
    )
  }
  if (row?.status === 'succeeded' && row.finishedAt) {
    if (now - row.finishedAt.getTime() < STALE_AFTER_MS[days]) return false
  }
  await enqueueAiJob({ kind: 'journal_analysis_run', tenantId, days })
  return true
}

export async function runJournalAnalysisJob(tenantId: string, days: JournalAnalysisPeriod) {
  const aiConfig = await resolveTenantAiConfig(tenantId)
  const runId = await withTenant(db, tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: journalAnalysisRuns.id, status: journalAnalysisRuns.status })
      .from(journalAnalysisRuns)
      .where(and(eq(journalAnalysisRuns.days, days), eq(journalAnalysisRuns.status, 'pending')))
      .orderBy(desc(journalAnalysisRuns.createdAt))
      .limit(1)
    if (existing) {
      await tx
        .update(journalAnalysisRuns)
        .set({ status: 'running', startedAt: new Date(), error: null })
        .where(eq(journalAnalysisRuns.id, existing.id))
      return existing.id
    }
    const [created] = await tx
      .insert(journalAnalysisRuns)
      .values({
        tenantId,
        days,
        status: 'running',
        startedAt: new Date(),
      })
      .returning({ id: journalAnalysisRuns.id })
    return created?.id ?? null
  })
  if (!runId) throw new Error('Could not open a journal analysis run')

  const fail = async (error: string) => {
    await withTenant(db, tenantId, (tx) =>
      tx
        .update(journalAnalysisRuns)
        .set({ status: 'failed', error, finishedAt: new Date() })
        .where(eq(journalAnalysisRuns.id, runId)),
    )
  }

  if (!aiConfig) {
    await fail('AI is not configured for this workspace.')
    return
  }

  // Everything below can throw (DB reads, the LLM call, the final write).
  // Without this guard an exception leaves the row `running` with no
  // `finishedAt` and no `error`; BullMQ retries create yet another `running`
  // row, and the period never produces an analysis again. Finalize as failed
  // AND rethrow so the retry/failure is visible to the worker's error handler.
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    const rows = await withTenant(db, tenantId, (tx) =>
      tx
        .select({
          date: journalEntries.entryDate,
          text: journalEntries.bodyText,
          site: orgUnits.name,
          first: analysisAuthor.firstName,
          last: analysisAuthor.lastName,
        })
        .from(journalEntries)
        .leftJoin(orgUnits, eq(orgUnits.id, journalEntries.siteOrgUnitId))
        .leftJoin(analysisAuthor, eq(analysisAuthor.id, journalEntries.personId))
        .where(and(isNull(journalEntries.deletedAt), gte(journalEntries.entryDate, since)))
        .orderBy(desc(journalEntries.entryDate))
        .limit(200),
    )

    const entries = rows
      .filter((r) => (r.text ?? '').trim().length > 0)
      .map((r) => ({
        date: r.date,
        site: r.site,
        author: r.first ? `${r.first} ${r.last ?? ''}`.trim() : null,
        text: (r.text ?? '').slice(0, 800),
      }))

    if (entries.length === 0) {
      await fail('No journal entries in this period to analyse.')
      return
    }

    const analysis = await analyseJournals(aiConfig, {
      scope: days <= 7 ? 'past week' : days <= 31 ? 'past 30 days' : 'period',
      entries,
    })
    if (!analysis) {
      await fail('Could not analyse the journals.')
      return
    }

    await withTenant(db, tenantId, (tx) =>
      tx
        .update(journalAnalysisRuns)
        .set({
          status: 'succeeded',
          entryCount: entries.length,
          result: analysis,
          error: null,
          finishedAt: new Date(),
        })
        .where(eq(journalAnalysisRuns.id, runId)),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Best-effort finalize; never let a failing status write mask the original
    // exception that the worker needs to see.
    try {
      await fail(`Journal analysis failed: ${message}`)
    } catch (finalizeError) {
      console.error('[journal-analysis] could not finalize failed run', finalizeError)
    }
    throw error
  }
}
