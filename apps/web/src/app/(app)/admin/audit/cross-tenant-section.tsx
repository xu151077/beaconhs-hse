'use client'

// PD-02 — cross-tenant audit access panel on /admin/audit.
//
// Three capability-gated areas in one compact panel:
//   1. Access requests — any member can apply for a grant (purpose required).
//   2. Approvals — visible to holders of admin.audit.approve (strictly
//      checked server-side too; the client check is cosmetic).
//   3. Query / export — visible when the account has an audit.read.* key and
//      an active grant; the server re-validates everything on every call.
//
// All copy flows through the generated message catalogue (GeneratedText /
// useGeneratedTranslations); server-provided error strings pass through
// useGeneratedValueTranslations, which translates known system copy and
// passes unknown values through untouched.

import { useCallback, useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Select,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@beaconhs/ui'
import {
  GeneratedText,
  useGeneratedValueTranslations,
  useGeneratedTranslations,
} from '@/i18n/generated'

type GrantDto = {
  id: string
  granteeUserId: string
  granteeTenantId: string | null
  scope: string
  purpose: string
  approvedByUserId: string | null
  extraApproval: boolean
  startsAt: string
  expiresAt: string
  revokedAt: string | null
  createdAt: string
}

type QueryRowDto = {
  id: string
  tenantId: string
  actorUserId: string | null
  actorIp: string | null
  entityType: string
  entityId: string | null
  action: string
  summary: string | null
  occurredAt: string
}

function grantState(g: GrantDto): 'pending' | 'active' | 'rejected' | 'revoked' | 'expired' {
  if (g.revokedAt) return g.approvedByUserId ? 'revoked' : 'rejected'
  if (!g.approvedByUserId) return 'pending'
  return new Date(g.expiresAt).getTime() > Date.now() &&
    new Date(g.startsAt).getTime() <= Date.now()
    ? 'active'
    : 'expired'
}

const STATE_VARIANT: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  revoked: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  expired: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
}

export function CrossTenantAuditSection({
  canApprove,
  canQuery,
}: {
  canApprove: boolean
  canQuery: boolean
}) {
  const tGenerated = useGeneratedTranslations()
  const tGeneratedValue = useGeneratedValueTranslations()
  const [grants, setGrants] = useState<GrantDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [purpose, setPurpose] = useState('')
  const [scope, setScope] = useState('tenant')
  const [extra, setExtra] = useState(false)
  const [days, setDays] = useState(7)
  const [submitting, setSubmitting] = useState(false)

  // Query state
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [actions, setActions] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<QueryRowDto[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [querying, setQuerying] = useState(false)

  const loadGrants = useCallback(async () => {
    const res = await fetch('/admin/audit/grants', { cache: 'no-store' })
    if (res.ok) {
      const body = (await res.json()) as { grants: GrantDto[] }
      setGrants(body.grants)
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void loadGrants()
  }, [loadGrants])

  async function post(path: string, body: unknown): Promise<boolean> {
    setError(null)
    setNotice(null)
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return true
    const body2 = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    const message = body2?.error?.message
    setError(
      message ? tGeneratedValue(message) : tGenerated('m_1b4a494078d454', { value0: res.status }),
    )
    return false
  }

  async function submitRequest() {
    if (purpose.trim().length === 0) {
      setError(tGenerated('m_115975422be744'))
      return
    }
    setSubmitting(true)
    const start = new Date()
    const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000)
    const ok = await post('/admin/audit/grants', {
      scope,
      purpose: purpose.trim(),
      startsAt: start.toISOString(),
      expiresAt: end.toISOString(),
      extraApproval: extra,
    })
    setSubmitting(false)
    if (ok) {
      setPurpose('')
      setExtra(false)
      setNotice(tGenerated('m_1c02246d367b7f'))
      void loadGrants()
    }
  }

  async function decide(g: GrantDto, action: 'approve' | 'reject' | 'revoke', withExtra?: boolean) {
    const ok = await post(`/admin/audit/grants/${g.id}`, { action, extraApproval: withExtra })
    if (ok) {
      setNotice(
        action === 'approve'
          ? tGenerated('m_1a50730dc30e27')
          : action === 'reject'
            ? tGenerated('m_121612cd4be536')
            : tGenerated('m_08478616cba4e8'),
      )
      void loadGrants()
    }
  }

  async function runQuery(nextPage: number) {
    setQuerying(true)
    setError(null)
    const sp = new URLSearchParams({ page: String(nextPage), pageSize: '25' })
    if (from) sp.set('from', new Date(from).toISOString())
    if (to) sp.set('to', new Date(to).toISOString())
    if (actions.trim()) sp.set('actions', actions.trim())
    const res = await fetch(`/admin/audit/query?${sp.toString()}`, { cache: 'no-store' })
    setQuerying(false)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      const message = body?.error?.message
      setError(
        message ? tGeneratedValue(message) : tGenerated('m_0832403f6f2fd1', { value0: res.status }),
      )
      return
    }
    const body = (await res.json()) as { rows: QueryRowDto[]; hasMore: boolean }
    setRows(body.rows)
    setHasMore(body.hasMore)
    setPage(nextPage)
  }

  function exportCsv() {
    const sp = new URLSearchParams()
    if (from) sp.set('from', new Date(from).toISOString())
    if (to) sp.set('to', new Date(to).toISOString())
    if (actions.trim()) sp.set('actions', actions.trim())
    window.location.href = `/admin/audit/export?${sp.toString()}`
  }

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h2 className="text-base font-semibold">
          <GeneratedText id="m_1ff76410a49887" />
        </h2>
        <p className="text-muted-foreground text-sm">
          <GeneratedText id="m_10696b091bbff1" />
        </p>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            <GeneratedText id="m_19dfb6a8d39939" />
          </h3>
          <textarea
            className="bg-background w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            placeholder={tGenerated('m_152691acbd9fad')}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Select
              className="bg-background rounded-md border px-2 py-1"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="tenant">This tenant</option>
              <option value="platform">All tenants (platform)</option>
            </Select>
            <label className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                className="w-20"
              />
              <GeneratedText id="m_169a4282447292" />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} />
              <GeneratedText id="m_0bf9431e78bc67" />
            </label>
            <Button size="sm" disabled={submitting} onClick={() => void submitRequest()}>
              <GeneratedText id="m_0ee232aca6f054" />
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            <GeneratedText id="m_12276426d4ba20" />{' '}
            <Badge variant="secondary">{grants.length}</Badge>
          </h3>
          {!loaded ? null : grants.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <GeneratedText id="m_0703a7c538a367" />
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <GeneratedText id="m_18f842f77b3c8b" />
                  </TableHead>
                  <TableHead>
                    <GeneratedText id="m_1f10a46fc1db73" />
                  </TableHead>
                  <TableHead>
                    <GeneratedText id="m_1297776898e12e" />
                  </TableHead>
                  <TableHead>
                    <GeneratedText id="m_0253b774dff267" />
                  </TableHead>
                  {canApprove && (
                    <TableHead>
                      <GeneratedText id="m_0a7f1858f2ec46" />
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => {
                  const state = grantState(g)
                  return (
                    <TableRow key={g.id}>
                      <TableCell>
                        <span className={`rounded px-1.5 py-0.5 text-xs ${STATE_VARIANT[state]}`}>
                          {state}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{g.scope}</TableCell>
                      <TableCell className="text-xs">
                        {g.extraApproval ? tGeneratedValue('yes') : tGeneratedValue('no')}
                      </TableCell>
                      <TableCell className="text-xs">
                        {new Date(g.startsAt).toLocaleDateString()} →{' '}
                        {new Date(g.expiresAt).toLocaleDateString()}
                      </TableCell>
                      {canApprove && (
                        <TableCell>
                          {state === 'pending' && (
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void decide(g, 'approve', false)}
                              >
                                <GeneratedText id="m_05194a49d7f46e" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void decide(g, 'approve', true)}
                              >
                                <GeneratedText id="m_0030283ec4855b" />
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void decide(g, 'reject')}
                              >
                                <GeneratedText id="m_0f51548c04b27f" />
                              </Button>
                            </div>
                          )}
                          {state === 'active' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void decide(g, 'revoke')}
                            >
                              <GeneratedText id="m_18718dd379a57d" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {canQuery && (
        <div className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">
            <GeneratedText id="m_17dcfca3d9a6f5" />
          </h3>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1 text-xs">
              <GeneratedText id="m_154c9d7a784dda" />
              <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <GeneratedText id="m_0ea10a854847b2" />
              <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <GeneratedText id="m_0a7f1858f2ec46" />
              <Input
                className="w-40"
                placeholder={tGenerated('m_0f76fda729ef34')}
                value={actions}
                onChange={(e) => setActions(e.target.value)}
              />
            </label>
            <Button size="sm" disabled={querying} onClick={() => void runQuery(1)}>
              <GeneratedText id="m_1417e84947b481" />
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv}>
              <GeneratedText id="m_14c6440eca1edc" />
            </Button>
          </div>
          {rows.length > 0 && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <GeneratedText id="m_1241d8588e6fc5" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_1fd4a056042e4d" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_0bad495a7046e9" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_1c23275efe6385" />
                    </TableHead>
                    <TableHead>
                      <GeneratedText id="m_031c356c80b70f" />
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(r.occurredAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.tenantId.slice(0, 8)}…</TableCell>
                      <TableCell className="text-xs">{r.action}</TableCell>
                      <TableCell className="text-xs">{r.entityType}</TableCell>
                      <TableCell className="max-w-72 truncate text-xs">{r.summary}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1 || querying}
                  onClick={() => void runQuery(page - 1)}
                >
                  <GeneratedText id="m_0b628e024bdff1" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasMore || querying}
                  onClick={() => void runQuery(page + 1)}
                >
                  <GeneratedText id="m_08b5fa148b2af7" />
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
