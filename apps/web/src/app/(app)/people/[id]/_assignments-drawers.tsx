'use client'

// Drawers for managing a person's org-unit assignments.
//
// Opens via `?drawer=assignment-new` / `?drawer=assignment-edit-<id>` so the URL
// is shareable and survives a refresh, matching the file-upload drawer already
// on this page.
//
// Authorisation is enforced server-side by the actions (which require
// `admin.org.manage`); the buttons here are only hidden so a caller without it
// is not offered a control that will be refused. Hiding is not the control.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button, Input, Label, Select, UrlDrawer } from '@beaconhs/ui'
import { useGeneratedValueTranslations } from '@/i18n/generated'
import { toast } from '@/lib/toast'
import { createAssignment, endAssignment, updateAssignment } from '../_actions/assignments'

export type OrgUnitOption = { value: string; label: string; level: string }

export type AssignmentRow = {
  id: string
  orgUnitId: string
  orgUnitName: string
  orgUnitLevel: string
  validFrom: string
  validTo: string | null
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function PersonAssignmentDrawers({
  personId,
  orgUnits,
  assignments,
  openDrawer,
  closeHref,
  canManage,
}: {
  personId: string
  orgUnits: OrgUnitOption[]
  assignments: AssignmentRow[]
  openDrawer: string | null
  closeHref: string
  canManage: boolean
}) {
  const editing =
    openDrawer?.startsWith('assignment-edit-') === true
      ? (assignments.find((a) => a.id === openDrawer.slice('assignment-edit-'.length)) ?? null)
      : null

  return (
    <>
      <AssignmentFormDrawer
        key="new"
        open={openDrawer === 'assignment-new'}
        closeHref={closeHref}
        personId={personId}
        orgUnits={orgUnits}
        assignments={assignments}
        mode="create"
        assignment={null}
      />
      <AssignmentFormDrawer
        key={editing?.id ?? 'edit-none'}
        open={editing !== null}
        closeHref={closeHref}
        personId={personId}
        orgUnits={orgUnits}
        assignments={assignments}
        mode="edit"
        assignment={editing}
      />
      {canManage ? <EndAssignmentButton assignments={assignments} closeHref={closeHref} /> : null}
    </>
  )
}

function AssignmentFormDrawer({
  open,
  closeHref,
  personId,
  orgUnits,
  assignments,
  mode,
  assignment,
}: {
  open: boolean
  closeHref: string
  personId: string
  orgUnits: OrgUnitOption[]
  assignments: AssignmentRow[]
  mode: 'create' | 'edit'
  assignment: AssignmentRow | null
}) {
  const router = useRouter()
  const t = useGeneratedValueTranslations()
  const [pending, startTransition] = useTransition()
  const [orgUnitId, setOrgUnitId] = useState(assignment?.orgUnitId ?? '')
  const [validFrom, setValidFrom] = useState(assignment?.validFrom ?? today())
  const [validTo, setValidTo] = useState(assignment?.validTo ?? '')

  function submit() {
    startTransition(async () => {
      const result =
        mode === 'create'
          ? await createAssignment({ personId, orgUnitId, validFrom, validTo: validTo || null })
          : await updateAssignment(assignment!.id, { validFrom, validTo: validTo || null })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(mode === 'create' ? t('Assignment added') : t('Assignment updated'))
      router.push(closeHref)
      router.refresh()
    })
  }

  // A person may hold several assignments at once, so a duplicate is only a
  // warning, never a block. The server keeps both rows.
  const duplicate =
    mode === 'create' && assignments.some((a) => a.orgUnitId === orgUnitId && orgUnitId !== '')

  return (
    <UrlDrawer
      open={open}
      closeHref={closeHref}
      title={mode === 'create' ? t('Add location assignment') : t('Edit assignment dates')}
      description={
        mode === 'create'
          ? t(
              'Record that this person works at a project or site. A person can hold more than one assignment at a time.',
            )
          : t(
              'Change when this assignment starts and ends. Leave the end date empty for an open-ended assignment.',
            )
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => router.push(closeHref)} disabled={pending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {mode === 'create' ? t('Add assignment') : t('Save changes')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {mode === 'create' ? (
          <div className="space-y-1.5">
            <Label htmlFor="assignment-org-unit">{t('Project or site')}</Label>
            <Select
              id="assignment-org-unit"
              value={orgUnitId}
              onChange={(e) => setOrgUnitId(e.currentTarget.value)}
            >
              <option value="">{t('Choose a location…')}</option>
              {orgUnits.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.level === 'project' ? `${o.label} (${t('Project')})` : o.label}
                </option>
              ))}
            </Select>
            {duplicate ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('This person already has an assignment to that location. Both will be kept.')}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {t('Location:')} <span className="font-medium">{assignment?.orgUnitName}</span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="assignment-valid-from">{t('Start date')}</Label>
            <Input
              id="assignment-valid-from"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.currentTarget.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="assignment-valid-to">{t('End date (optional)')}</Label>
            <Input
              id="assignment-valid-to"
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.currentTarget.value)}
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(
            'An assignment is active from its start date up to and including its end date. Leave the end date empty while the assignment is ongoing.',
          )}
        </p>
      </div>
    </UrlDrawer>
  )
}

function EndAssignmentButton({
  assignments,
  closeHref,
}: {
  assignments: AssignmentRow[]
  closeHref: string
}) {
  const router = useRouter()
  const t = useGeneratedValueTranslations()
  const [pending, startTransition] = useTransition()

  const open = assignments.find((a) => a.validTo === null)
  if (!open) return null

  function end() {
    startTransition(async () => {
      const result = await endAssignment(open!.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(t('Assignment ended'))
      router.push(closeHref)
      router.refresh()
    })
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={end}
      data-walkthrough="end-assignment"
    >
      {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      {t('End current assignment')}
    </Button>
  )
}
