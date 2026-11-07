import type { Job } from 'bullmq'
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import {
  db,
  isFormResponseParentLockedError,
  lockFormResponseForMutation,
  permitWindowEndedExpr,
  withSuperAdmin,
} from '@beaconhs/db'
import {
  auditLog,
  formResponseCheckins,
  formResponses,
  tenantUsers,
  users,
} from '@beaconhs/db/schema'
import { assertScheduledTick, type ScheduledTick } from '@beaconhs/jobs'
import { scanReportSchedules } from '../lib/report-scheduler'
import { scanCompliance } from '../lib/compliance-scanner'
import { scanEscalations } from '../lib/escalation-scanner'
import { scanDigests } from '../lib/digest-scanner'
import { scanScheduledFlows } from '../lib/scheduled-flow-runner'
import { runSyncConnection, scanSyncConnections } from '../lib/sync-scanner'
import { runSessionOverdueFlows } from '../lib/session-overdue-flows'
import { runDatabaseMaintenance } from '../lib/db-maintenance'
import { drainDomainEventOutbox } from '../lib/domain-event-outbox'
import { reconcileOfficeRenders } from '../lib/office-render-reconciler'
import { reconcileStorageWriteArms } from '../lib/storage-write-arm-reconciler'
import { scanJournalAnalysis } from '../lib/journal-analysis'
import { drainStorageObjectDeletionOutbox } from '../lib/storage-object-deletion-outbox'
import { reconcileExpiredAttachmentUploads } from '../lib/attachment-upload-reconciler'

export async function processScheduledTick(job: Job<ScheduledTick>): Promise<void> {
  assertScheduledTick(job.data)
  switch (job.data.kind) {
    case 'form_session_overdue_scan': {
      await scanFormSessionOverdue()
      return scanFormSessionWindowEnded()
    }
    case 'compliance_scan': {
      // Evaluate tenant crons against the tick's SCHEDULED minute (timestamp +
      // delay = the BullMQ repeat slot), so late processing or a retry never
      // silently skips a tenant whose scan matched the intended minute.
      const slotMs = job.timestamp + (job.opts.delay ?? 0)
      const r = await scanCompliance(Number.isFinite(slotMs) ? new Date(slotMs) : new Date())
      // Runs every minute now (per-tenant self-gating); only log when work happened.
      // `configErrors` (a tenant's persisted bad cron) is logged above by the
      // scanner but must NOT fail the tick: one broken config would otherwise
      // retry and fail the whole job every single minute forever. Only real
      // runtime/dispatch errors throw so BullMQ retries them.
      if (r.due > 0 || r.errors > 0 || r.configErrors > 0) {
        console.log(
          `[scheduled] compliance_scan: ${r.due}/${r.tenants} tenants due / ${r.obligations} obligations / ${r.reminders} reminders / ${r.maintenance} maintenance / ${r.errors} errors / ${r.configErrors} bad configs`,
        )
      }
      if (r.errors > 0) {
        throw new Error(`Compliance scan completed with ${r.errors} tenant or dispatch error(s)`)
      }
      return
    }
    case 'escalation_scan': {
      const r = await scanEscalations()
      console.log(
        `[scheduled] escalation_scan: ${r.escalated} escalated across ${r.tenants} tenants`,
      )
      return
    }
    case 'digest_scan': {
      const slotMs = job.timestamp + (job.opts.delay ?? 0)
      const r = await scanDigests(Number.isFinite(slotMs) ? new Date(slotMs) : new Date())
      console.log(`[scheduled] digest_scan: ${r.emails} digest emails across ${r.tenants} tenants`)
      return
    }
    case 'scheduled_flow_scan': {
      const slotMs = job.timestamp + (job.opts.delay ?? 0)
      const r = await scanScheduledFlows(Number.isFinite(slotMs) ? new Date(slotMs) : new Date())
      if (r.flows > 0 || r.errors > 0 || r.configErrors > 0)
        console.log(
          `[scheduled] scheduled_flow_scan: ${r.flows} flows fired / ${r.ran} actions / ${r.errors} errors / ${r.configErrors} bad configs`,
        )
      if (r.errors > 0) {
        throw new Error(`Scheduled flow scan completed with ${r.errors} flow error(s)`)
      }
      return
    }
    case 'report_schedule_scan':
      return scanReportSchedules()
    case 'sync_scan': {
      const r = await scanSyncConnections()
      console.log(`[scheduled] sync_scan: ${r.enqueued} enqueued / ${r.candidates} candidates`)
      return
    }
    case 'sync_run': {
      const r = await runSyncConnection(job.data.tenantId, job.data.connectionId, job.data.trigger)
      console.log(
        `[scheduled] sync_run ${job.data.connectionId.slice(0, 8)} → ${r.status} (run=${r.runId ?? 'none'})`,
      )
      return
    }
    case 'db_maintenance': {
      const result = await runDatabaseMaintenance(job.data.trigger ?? 'scheduled')
      if (!result.ok) {
        throw new Error('Database maintenance completed with one or more table failures')
      }
      return
    }
    case 'domain_event_outbox_scan': {
      const result = await drainDomainEventOutbox()
      if (result.claimed > 0) {
        console.log(
          `[scheduled] domain_event_outbox: ${result.published} published / ${result.retried} retrying`,
        )
      }
      return
    }
    case 'storage_object_deletion_scan': {
      const result = await drainStorageObjectDeletionOutbox()
      if (result.claimed > 0) {
        console.log(
          `[scheduled] storage_object_deletion: ${result.deleted} deleted / ${result.retried} retrying`,
        )
      }
      const uploads = await reconcileExpiredAttachmentUploads()
      if (uploads.examined > 0) {
        console.log(
          `[scheduled] expired_uploads: ${uploads.recovered} recovered / ${uploads.discarded} discarded / ${uploads.errors} errors`,
        )
      }
      if (uploads.errors > 0) {
        throw new Error(`Expired upload reconciliation had ${uploads.errors} error(s)`)
      }
      return
    }
    case 'storage_write_arms_reconcile': {
      const result = await reconcileStorageWriteArms()
      console.log(
        `[scheduled] storage_write_arms: ${result.reconciled + result.quarantined} reconciled / ${result.quarantined} quarantined / ${result.deferred} deferred / ${result.errors} errors`,
      )
      if (result.errors > 0) {
        throw new Error(`Storage write arm reconciliation had ${result.errors} error(s)`)
      }
      return
    }
    case 'journal_analysis_scan': {
      const result = await scanJournalAnalysis()
      if (result.enqueued > 0) {
        console.log(
          `[scheduled] journal_analysis_scan: ${result.enqueued} runs enqueued across ${result.tenants} tenants`,
        )
      }
      return
    }
    case 'office_render_reconcile': {
      const result = await reconcileOfficeRenders()
      if (result.candidates > 0) {
        console.log(
          `[scheduled] office_render_reconcile: ${result.enqueued} enqueued / ${result.errors} errors`,
        )
      }
      if (result.errors > 0) {
        throw new Error(`Office render reconciliation had ${result.errors} enqueue error(s)`)
      }
      return
    }
  }
}

// Generic monitored-session overdue scan. A monitored response is overdue once now passes
// nextCheckinDueAt + grace; we flip it to 'escalated', log a 'missed' check-in,
// and fire the generic escalation. See docs/monitored-sessions-design.md.
const SESSION_SCAN_BATCH = 100
const MAX_SESSIONS_PER_TICK = 500

async function scanFormSessionOverdue(): Promise<void> {
  let processed = 0
  let cursor: { nextCheckinDueAt: Date; id: string } | null = null
  while (processed < MAX_SESSIONS_PER_TICK) {
    const page = await withSuperAdmin(db, async (tx) => {
      const now = new Date()
      // Compare against the DB clock (now()) — avoids worker/DB clock skew and
      // keyset-page the bounded candidates so locked parent assessments cannot
      // starve later sessions. Each candidate is serialized by the shared
      // parent-first response lock before its conditional claim.
      const overdue = await tx
        .select({
          id: formResponses.id,
          tenantId: formResponses.tenantId,
          nextCheckinDueAt: formResponses.nextCheckinDueAt,
        })
        .from(formResponses)
        .where(
          and(
            eq(formResponses.monitorStatus, 'active'),
            sql`${formResponses.nextCheckinDueAt} + ((coalesce(${formResponses.gracePeriodMinutes}, 0))::text || ' minutes')::interval <= now()`,
            cursor
              ? or(
                  gt(formResponses.nextCheckinDueAt, cursor.nextCheckinDueAt),
                  and(
                    eq(formResponses.nextCheckinDueAt, cursor.nextCheckinDueAt),
                    gt(formResponses.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(formResponses.nextCheckinDueAt), asc(formResponses.id))
        .limit(Math.min(SESSION_SCAN_BATCH, MAX_SESSIONS_PER_TICK - processed))
      for (const s of overdue) {
        let mutable: typeof formResponses.$inferSelect | null
        try {
          mutable = await lockFormResponseForMutation(tx, s.tenantId, s.id)
        } catch (error) {
          if (isFormResponseParentLockedError(error)) continue
          throw error
        }
        if (!mutable) continue
        const [claimed] = await tx
          .update(formResponses)
          .set({ monitorStatus: 'escalated', escalatedAt: now })
          .where(
            and(
              eq(formResponses.id, s.id),
              eq(formResponses.tenantId, s.tenantId),
              eq(formResponses.monitorStatus, 'active'),
              sql`${formResponses.nextCheckinDueAt} + ((coalesce(${formResponses.gracePeriodMinutes}, 0))::text || ' minutes')::interval <= now()`,
            ),
          )
          .returning({ id: formResponses.id })
        if (!claimed) continue
        await tx.insert(formResponseCheckins).values({
          tenantId: s.tenantId,
          responseId: s.id,
          kind: 'missed',
          recordedAt: now,
        })
        let submitterEmail: string | null = null
        if (mutable.submittedBy) {
          const [u] = await tx
            .select({ email: users.email })
            .from(tenantUsers)
            .innerJoin(users, eq(users.id, tenantUsers.userId))
            .where(
              and(eq(tenantUsers.id, mutable.submittedBy), eq(tenantUsers.tenantId, s.tenantId)),
            )
            .limit(1)
          submitterEmail = u?.email ?? null
        }
        // Alerting is the monitored app's own session_overdue Flow — a Builder
        // app is per-tenant + dynamic, so the worker does not invent a second
        // fallback audience.
        await runSessionOverdueFlows({
          tx,
          tenantId: s.tenantId,
          responseId: s.id,
          templateId: mutable.templateId,
          data: (mutable.data ?? {}) as Record<string, unknown>,
          submitterEmail,
        })
      }
      const last = overdue.at(-1)
      if (last && !last.nextCheckinDueAt) {
        throw new Error('Overdue monitored response is missing its next check-in timestamp')
      }
      return {
        batchSize: overdue.length,
        nextCursor: last ? { nextCheckinDueAt: last.nextCheckinDueAt!, id: last.id } : null,
      }
    })
    processed += page.batchSize
    cursor = page.nextCursor
    if (page.batchSize < SESSION_SCAN_BATCH || !cursor) break
  }
}

// Generic monitored-session validity-window expiry — the sibling of the overdue
// scan above, on the same tick.
//
// The overdue scan answers "did the holder go quiet mid-session?" (a missed
// check-in). This one answers the different question "did the session's own
// approved window close?". Until now nothing read `expectedEndAt` to change
// state: it was written by `start_monitored_session` and exposed as a report
// column, so a session whose window had passed while nobody touched it stayed
// `active` forever. For a work permit that is a live safety hole — the record
// that gates the job would read as valid indefinitely.
//
// Both live in one tick rather than a new queue because they are the same
// concern (monitored-session liveness) over the same table, with the same lock
// + conditional-claim pattern. No permit-specific queue, cron or scheduler.
//
// Same rule for every monitored session, not just work permits: a session with a
// window that has closed is not live. A session with NO window
// (`expectedEndAt IS NULL`) is untouched, which is the default and the vast
// majority of monitored sessions.
const WINDOW_SCAN_BATCH = 100
const MAX_WINDOWS_PER_TICK = 500

async function scanFormSessionWindowEnded(): Promise<void> {
  let processed = 0
  let cursor: { expectedEndAt: Date; id: string } | null = null
  while (processed < MAX_WINDOWS_PER_TICK) {
    const page = await withSuperAdmin(db, async (tx) => {
      // Same deliberate clock choice as the overdue scan: compare against the
      // DB clock (`now()`) so worker/DB skew cannot close a window early.
      const ended = await tx
        .select({
          id: formResponses.id,
          tenantId: formResponses.tenantId,
          expectedEndAt: formResponses.expectedEndAt,
        })
        .from(formResponses)
        .where(
          and(
            // Same terminal-claim set `closeSession()` uses, so an escalated
            // session is still closed when its window ends rather than stranded.
            inArray(formResponses.monitorStatus, ['active', 'missed', 'escalated']),
            permitWindowEndedExpr(sql`now()`),
            cursor
              ? or(
                  gt(formResponses.expectedEndAt, cursor.expectedEndAt),
                  and(
                    eq(formResponses.expectedEndAt, cursor.expectedEndAt),
                    gt(formResponses.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(formResponses.expectedEndAt), asc(formResponses.id))
        .limit(Math.min(WINDOW_SCAN_BATCH, MAX_WINDOWS_PER_TICK - processed))
      // Every candidate matched `expectedEndAt IS NOT NULL`; assert it before use
      // so the audit metadata and the keyset cursor below are both total.
      for (const s of ended) {
        if (!s.expectedEndAt) {
          throw new Error('Window-ended monitored response is missing its expected end timestamp')
        }
      }
      let closed = 0
      for (const s of ended) {
        let mutable: typeof formResponses.$inferSelect | null
        try {
          mutable = await lockFormResponseForMutation(tx, s.tenantId, s.id)
        } catch (error) {
          if (isFormResponseParentLockedError(error)) continue
          throw error
        }
        if (!mutable) continue
        // Conditional claim on monitorStatus keeps the whole pass idempotent: a
        // re-run (retry, overlapping tick) matches nothing and rewrites nothing.
        const [claimed] = await tx
          .update(formResponses)
          .set({ monitorStatus: 'completed', closedAt: new Date() })
          .where(
            and(
              eq(formResponses.id, s.id),
              eq(formResponses.tenantId, s.tenantId),
              inArray(formResponses.monitorStatus, ['active', 'missed', 'escalated']),
              sql`${formResponses.expectedEndAt} is not null and ${formResponses.expectedEndAt} <= now()`,
            ),
          )
          .returning({ id: formResponses.id })
        if (!claimed) continue
        closed += 1
        await tx.insert(auditLog).values({
          tenantId: s.tenantId,
          entityType: 'form_response',
          entityId: s.id,
          action: 'update',
          summary: 'Monitored session validity window ended — session closed',
          metadata: {
            trigger: 'monitored_session_window_end',
            monitorStatusFrom: mutable.monitorStatus,
            monitorStatusTo: 'completed',
            expectedEndAt: s.expectedEndAt!.toISOString(),
          },
        })
      }
      const last = ended.at(-1)
      return {
        batchSize: ended.length,
        closed,
        nextCursor: last ? { expectedEndAt: last.expectedEndAt!, id: last.id } : null,
      }
    })
    processed += page.batchSize
    cursor = page.nextCursor
    if (page.closed > 0) {
      console.log(`[scheduled] monitored-session window end: closed ${page.closed} session(s)`)
    }
    if (page.batchSize < WINDOW_SCAN_BATCH || !cursor) break
  }
}

// Cert expiry, document review, and corrective-action overdue are NOT scanned
// here — the compliance obligation engine is the single detector for recurring
// due/overdue/expiry conditions (see compliance-scanner.ts). Monitored-session
// overdue stays: it's a distinct real-time check-in concern, not a duplicate.
