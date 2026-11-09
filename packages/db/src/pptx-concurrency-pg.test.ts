/**
 * Real-PostgreSQL concurrency proof for the PPTX purge lock protocol.
 * NOT a mock: spawns an ephemeral postgres:16-alpine container, replicates
 * ONLY the locking statements used by purgeDeckAssetsTx + link writers
 * (SELECT … ORDER BY id FOR UPDATE, recount, delete) and asserts the P1
 * invariant: a referenced object never enters deleting state.
 * No business code is invoked, no production DB touched.
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres, { type Sql } from 'postgres'

const NAME = `beaconhs-pptx-conc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
let sql: Sql | null = null
let baseUrl = ''

function docker(...args: string[]) {
  return execSync(`docker ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function port(): number {
  return Number(docker('port', NAME, '5432').trim().split(':').pop())
}

beforeAll(async () => {
  execSync('docker --version', { stdio: 'ignore' })
  docker(
    'run -d --name',
    NAME,
    '-e',
    'POSTGRES_PASSWORD=testpw',
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_DB=beaconhs',
    '-p',
    '127.0.0.1:0:5432',
    'postgres:16-alpine',
  )
  baseUrl = `postgresql://postgres:testpw@127.0.0.1:${port()}/beaconhs`
  // Wait ready
  for (let i = 0; i < 40; i++) {
    try {
      const c = postgres(baseUrl, { max: 1, connect_timeout: 3 })
      await c`select 1`
      await c.end()
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  sql = postgres(baseUrl, { max: 10 })
  await sql.unsafe(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE attachments (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id),
      r2_key text NOT NULL UNIQUE,
      UNIQUE (tenant_id, id)
    );
    CREATE TABLE training_lessons (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
      source_attachment_id uuid, deleted_at timestamptz
    );
    CREATE TABLE training_content_items (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
      source_attachment_id uuid, deleted_at timestamptz
    );
    CREATE TABLE storage_object_deletion_outbox (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      attachment_id uuid NOT NULL UNIQUE,
      object_key text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'pending',
      attempts int NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_id uuid, claimed_at timestamptz, last_error text
    );
    -- Trigger mirroring prod: attachment delete enqueues outbox in same tx
    CREATE OR REPLACE FUNCTION enqueue_outbox() RETURNS trigger LANGUAGE plpgsql AS $rb$
    BEGIN
      INSERT INTO storage_object_deletion_outbox (id, tenant_id, attachment_id, object_key)
      VALUES (gen_random_uuid(), OLD.tenant_id, OLD.id, 't/' || OLD.tenant_id::text || '/' || OLD.r2_key)
      ON CONFLICT (attachment_id) DO NOTHING;
      RETURN NULL;
    END $rb$;
    CREATE TRIGGER attachments_delete_outbox AFTER DELETE ON attachments
    FOR EACH ROW EXECUTE FUNCTION enqueue_outbox();
  `)
}, 120_000)

afterAll(async () => {
  try {
    await sql?.end()
  } catch {}
  try {
    execSync(`docker rm -f ${NAME}`, { stdio: 'ignore' })
  } catch {}
})

async function fresh(): Promise<{ tenantId: string; attId: string }> {
  const s = sql!
  const t = randomUUID()
  const a = randomUUID()
  await s`insert into tenants (id) values (${t}::uuid)`
  await s`insert into attachments (id, tenant_id, r2_key) values (${a}::uuid, ${t}::uuid, ${'k-' + a.slice(0, 8)})`
  return { tenantId: t, attId: a }
}

async function outsideConn<P>(fn: (c: Sql) => Promise<P>): Promise<P> {
  const c = postgres(baseUrl, { max: 1 })
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function countRefs(c: Sql, tenantId: string, attId: string): Promise<number> {
  const [r1] =
    await c`select count(*)::int as n from training_lessons where tenant_id=${tenantId}::uuid and source_attachment_id=${attId}::uuid and deleted_at is null`
  const [r2] =
    await c`select count(*)::int as n from training_content_items where tenant_id=${tenantId}::uuid and source_attachment_id=${attId}::uuid and deleted_at is null`
  return r1.n + r2.n
}

/** Purge protocol replica: lock ordered → recount → delete if zero. Runs inside caller's tx. */
async function purge(tx: Sql, tenantId: string, attId: string) {
  await tx`select id from attachments where id = ${attId}::uuid and tenant_id = ${tenantId}::uuid order by id for update`
  const n = await countRefs(tx, tenantId, attId)
  if (n > 0) return 0
  await tx`delete from attachments where id = ${attId}::uuid and tenant_id = ${tenantId}::uuid`
  return 1
}

async function outboxCount(c: Sql, attId: string): Promise<number> {
  const [r] =
    await c`select count(*)::int as n from storage_object_deletion_outbox where attachment_id = ${attId}::uuid`
  return r.n
}

describe('PPTX purge lock protocol (real PG concurrency)', () => {
  it('A: two tx delete different refs to shared object — last wins, one outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    await s`insert into training_content_items (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    const [l1] =
      await s`select id from training_lessons where source_attachment_id=${attId}::uuid limit 1`
    const [c1] =
      await s`select id from training_content_items where source_attachment_id=${attId}::uuid limit 1`
    // True concurrent: two independent connections, each hides its own ref then purges.
    // FOR UPDATE on the attachment serializes them; only the last sees 0 refs.
    const p1 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${l1.id}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    const p2 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_content_items set deleted_at=now(), source_attachment_id=null where id=${c1.id}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    await Promise.all([p1, p2])
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeUndefined()
    expect(await outboxCount(s, attId)).toBe(1)
  }, 30000)

  it('B: delete-last vs insert-new — new ref wins, no outbox for live object', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    const [l] =
      await s`select id from training_lessons where source_attachment_id=${attId}::uuid limit 1`
    // Position insert to commit first (new ref exists), then delete-last must see it
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`insert into training_content_items (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
      })
    })
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${l.id}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeDefined()
    expect(await outboxCount(s, attId)).toBe(0)
  })

  it('C: delete vs replace — replace moves item to att, then deleting the other ref must not delete the still-referenced att', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const lessonId = randomUUID()
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${lessonId}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    const otherAtt = randomUUID()
    await s`insert into attachments (id, tenant_id, r2_key) values (${otherAtt}::uuid, ${tenantId}::uuid, ${'k-' + otherAtt.slice(0, 8)})`
    const itemId = randomUUID()
    await s`insert into training_content_items (id, tenant_id, source_attachment_id) values (${itemId}::uuid, ${tenantId}::uuid, ${otherAtt}::uuid)`
    // Replacer moves item: otherAtt -> att (att now 2 refs, otherAtt 0).
    // Also locks the new target row FOR UPDATE per link-writer protocol.
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`select id from attachments where id=${attId}::uuid and tenant_id=${tenantId}::uuid for update`
        await tx`update training_content_items set source_attachment_id=${attId}::uuid where id=${itemId}::uuid`
      })
    })
    // After replace att still has TWO live refs (lesson+item). Deleting the lesson ref
    // must leave 1 live ref, so purge must NOT delete att.
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${lessonId}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeDefined()
    expect(await outboxCount(s, attId)).toBe(0)
    // Sanity: item still points at att.
    expect(await countRefs(sql!, tenantId, attId)).toBe(1)
  }, 30000)

  it('D: three concurrent deletes converge to one outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const id = randomUUID()
      ids.push(id)
      await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${id}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    }
    await Promise.all(
      ids.map((lid) =>
        outsideConn(async (c) => {
          await c.begin(async (tx) => {
            await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${lid}::uuid`
            await purge(tx, tenantId, attId)
          })
        }),
      ),
    )
    expect(await outboxCount(s, attId)).toBe(1)
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeUndefined()
  })

  it('E: rollback leaves no outbox, retry succeeds', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    const [l] =
      await s`select id from training_lessons where source_attachment_id=${attId}::uuid limit 1`
    await expect(
      outsideConn(async (c) => {
        await c.begin(async (tx) => {
          await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${l.id}::uuid`
          await purge(tx, tenantId, attId)
          throw new Error('boom')
        })
      }),
    ).rejects.toThrowError(/boom/)
    expect(await outboxCount(s, attId)).toBe(0)
    // retry succeeds
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${l.id}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    expect(await outboxCount(s, attId)).toBe(1)
  })

  it('F: worker repeat after success is idempotent (missing object ok)', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${randomUUID()}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    const [l] =
      await s`select id from training_lessons where source_attachment_id=${attId}::uuid limit 1`
    await outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${l.id}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    // Simulate worker: delete object (already gone) then CAS-delete outbox row; repeat is safe
    const [row] =
      await s`select id from storage_object_deletion_outbox where attachment_id=${attId}::uuid limit 1`
    expect(row).toBeDefined()
    await s`delete from storage_object_deletion_outbox where id=${row.id}::uuid and status='pending'`
    await s`delete from storage_object_deletion_outbox where id=${row.id}::uuid and status='pending'`
    expect(await outboxCount(s, attId)).toBe(0)
  })

  /** importLessonPptx replica: lock tenant-scoped FOR UPDATE, then link. */
  async function importLesson(tx: Sql, tenantId: string, lessonId: string, attId: string) {
    const [row] =
      await tx`select id from attachments where id=${attId}::uuid and tenant_id=${tenantId}::uuid order by id for update limit 1`
    if (!row) throw new Error('PowerPoint attachment not found.')
    await tx`update training_lessons set source_attachment_id=${attId}::uuid where id=${lessonId}::uuid`
  }

  it('G1: delete-last acquires lock first — import blocked after delete, no live-ref+outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const xId = randomUUID()
    const yId = randomUUID()
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${xId}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${yId}::uuid, ${tenantId}::uuid, null)`
    // T1 starts slightly first so it wins the FOR UPDATE; T2 starts 150ms later and blocks.
    const p1 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${xId}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    await new Promise((r) => setTimeout(r, 150))
    const p2 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await importLesson(tx, tenantId, yId, attId)
      })
    }).then(
      () => 'imported',
      () => 'rejected',
    )
    await p1
    const importResult = await p2
    // After delete wins, the attachment row is gone; import must be rejected, not create live-ref+outbox.
    expect(importResult).toBe('rejected')
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeUndefined()
    expect(await outboxCount(s, attId)).toBe(1)
    expect(await countRefs(sql!, tenantId, attId)).toBe(0)
  }, 30000)

  it('G2: import acquires lock first — delete recount sees new Y ref, no outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const xId = randomUUID()
    const yId = randomUUID()
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${xId}::uuid, ${tenantId}::uuid, ${attId}::uuid)`
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${yId}::uuid, ${tenantId}::uuid, null)`
    // T2 (import) starts slightly first and wins the lock; T1 (delete-last+purge) blocks.
    const p2 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await importLesson(tx, tenantId, yId, attId)
      })
    })
    await new Promise((r) => setTimeout(r, 150))
    const p1 = outsideConn(async (c) => {
      await c.begin(async (tx) => {
        await tx`update training_lessons set deleted_at=now(), source_attachment_id=null where id=${xId}::uuid`
        await purge(tx, tenantId, attId)
      })
    })
    await Promise.all([p2, p1])
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeDefined()
    expect(await outboxCount(s, attId)).toBe(0)
    expect(await countRefs(sql!, tenantId, attId)).toBe(1)
  }, 30000)

  it('H: importLessonPptx cross-tenant is rejected, no link, no outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const otherTenant = randomUUID()
    await s`insert into tenants (id) values (${otherTenant}::uuid)`
    const yId = randomUUID()
    // Y lives in otherTenant but for the replica we query with tenantId=otherTenant against att of tenantId.
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${yId}::uuid, ${otherTenant}::uuid, null)`
    await expect(
      outsideConn(async (c) => {
        await c.begin(async (tx) => {
          await importLesson(tx, otherTenant, yId, attId)
        })
      }),
    ).rejects.toThrowError(/not found/)
    const [y] = await s`select source_attachment_id from training_lessons where id=${yId}::uuid`
    expect(y.source_attachment_id).toBeNull()
    expect(await outboxCount(s, attId)).toBe(0)
  })

  it('I: importLessonPptx rollback leaves no link and no outbox', async () => {
    const { tenantId, attId } = await fresh()
    const s = sql!
    const yId = randomUUID()
    await s`insert into training_lessons (id, tenant_id, source_attachment_id) values (${yId}::uuid, ${tenantId}::uuid, null)`
    await expect(
      outsideConn(async (c) => {
        await c.begin(async (tx) => {
          await importLesson(tx, tenantId, yId, attId)
          throw new Error('boom-import')
        })
      }),
    ).rejects.toThrowError(/boom-import/)
    const [y] = await s`select source_attachment_id from training_lessons where id=${yId}::uuid`
    expect(y.source_attachment_id).toBeNull()
    const [att] = await s`select id from attachments where id=${attId}::uuid`
    expect(att).toBeDefined()
    expect(await outboxCount(s, attId)).toBe(0)
  })
})
