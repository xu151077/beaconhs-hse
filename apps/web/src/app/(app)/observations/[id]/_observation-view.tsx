'use client'

// Read + action view for one safety observation.
//
// The record is a journal entry, so the whole view is driven by the journals
// `JournalEntryDetail` shape. Every mutation goes to a server action that
// re-checks `journalScopeWhere()` and the journals mutation policy — this
// component only decides which buttons to RENDER, never whether they may work.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ThumbsUp } from 'lucide-react'
import { Badge, Button, Card, CardContent, Input, Label, Textarea } from '@beaconhs/ui'
import { GeneratedText, GeneratedValue, useGeneratedTranslations } from '@/i18n/generated'
import { statusMeta, textToHtml } from '../../journals/_format'
import type { JournalEntryDetail, JournalStatus } from '../../journals/_types'
import type { LinkedAction } from '../_data'
import { ObservationPhotos } from './_observation-photos'
import {
  archiveObservation,
  discardObservation,
  raiseObservationAction,
  submitObservation,
  updateObservationDraft,
} from '../_actions'

export function ObservationView({
  entry,
  actions,
  canEdit,
  canSubmit,
}: {
  entry: JournalEntryDetail
  actions: LinkedAction[]
  /** From `journalMutationFlags` — a render affordance, re-checked server-side. */
  canEdit: boolean
  canSubmit: boolean
}) {
  const tGenerated = useGeneratedTranslations()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(entry.title ?? '')
  const [bodyText, setBodyText] = useState(entry.bodyText)
  const [actionTitle, setActionTitle] = useState('')
  const [actionDueOn, setActionDueOn] = useState('')

  const isNegative = entry.definition === 'negative_observation'
  // Journals gates editing on the mutation policy plus the entry lock — NOT on
  // draft status (`_editor-pane.tsx`: `const editable = !entry.locked`). A
  // submitted entry therefore stays editable for a caller with journals.assign,
  // which is why a photo can still be attached after submission. Align exactly,
  // or observations would silently drop a capability journals has.
  const editable = canEdit && !entry.locked
  // Submit is different: it is a one-way DRAFT → submitted transition, so it is
  // the status (not the policy) that gates the button.
  const submittable = entry.status === 'draft' && canSubmit

  function save() {
    startTransition(async () => {
      // `bodyHtml` is what the journals editor stores; a plain-text observation
      // body is converted with the shared helper, so the same sanitiser and the
      // same `body_text` mirror run as for a journal.
      await updateObservationDraft({
        id: entry.id,
        patch: { title, bodyHtml: textToHtml(bodyText) },
      })
      setEditing(false)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
              <GeneratedValue value={entry.reference} />
            </span>
            <Badge className={statusMeta(entry.status).className} variant="secondary">
              {statusMeta(entry.status).label}
            </Badge>
            <Badge variant={isNegative ? 'warning' : 'success'}>
              {isNegative ? (
                <>
                  <AlertTriangle size={12} className="mr-1" />
                  <GeneratedText id="m_003f57e352b85d" />
                </>
              ) : (
                <>
                  <ThumbsUp size={12} className="mr-1" />
                  <GeneratedText id="m_11ff05b3ce5e8c" />
                </>
              )}
            </Badge>
          </div>

          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            <GeneratedValue value={entry.title ?? entry.reference} />
          </h1>

          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-slate-500 dark:text-slate-400">
                <GeneratedText id="m_126fbfcdbb3a34" />
              </dt>
              <dd className="text-slate-900 dark:text-slate-100">
                <GeneratedValue value={entry.entryDate} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500 dark:text-slate-400">
                <GeneratedText id="m_055f11420b2da4" />
              </dt>
              <dd className="text-slate-900 dark:text-slate-100">
                <GeneratedValue value={entry.siteName ?? ''} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500 dark:text-slate-400">
                <GeneratedText id="m_102255d7ce7611" />
              </dt>
              <dd className="text-slate-900 dark:text-slate-100">
                <GeneratedValue value={entry.authorName ?? ''} />
              </dd>
            </div>
          </dl>

          {entry.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((tag: string) => (
                <Link
                  key={tag}
                  href={`/observations?tag=${encodeURIComponent(tag)}`}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  {tag}
                </Link>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {editing ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="obs-title">
                  <GeneratedText id="m_0decefd558c355" />
                </Label>
                <Input id="obs-title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="obs-body">
                  <GeneratedText id="m_1dc8734021031d" />
                </Label>
                <Textarea
                  id="obs-body"
                  rows={6}
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={save} disabled={pending}>
                  <GeneratedText id="m_19e6bff894c3c7" />
                </Button>
                <Button variant="outline" onClick={() => setEditing(false)} disabled={pending}>
                  <GeneratedText id="m_112e2e8ecda428" />
                </Button>
              </div>
            </>
          ) : (
            <>
              {entry.bodyText ? (
                <p className="text-sm whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                  {entry.bodyText}
                </p>
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  <GeneratedText id="m_176fb2e4b6a114" />
                </p>
              )}
              {editable ? (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <GeneratedText id="m_0ae7cf2fe47647" />
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200">
            <GeneratedText id="m_0a07835d0e7c93" />
          </h2>
          <ObservationPhotos observationId={entry.id} photos={entry.photos} editable={editable} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-200">
            <GeneratedText id="m_0a0b2d1cbc1963" />
          </h2>
          {actions.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              <GeneratedText id="m_10744b40b4ecc4" />
            </p>
          ) : (
            <ul className="space-y-1">
              {actions.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    href={`/corrective-actions/${a.id}` as never}
                    className="font-mono text-xs text-teal-700 hover:underline dark:text-teal-300"
                  >
                    <GeneratedValue value={a.reference} />
                  </Link>
                  <span className="text-slate-800 dark:text-slate-200">
                    <GeneratedValue value={a.title} />
                  </span>
                  <Badge
                    variant="secondary"
                    className={statusMeta(a.status as JournalStatus).className}
                  >
                    <GeneratedValue value={a.status.replace('_', ' ')} />
                  </Badge>
                  {a.dueOn ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      <GeneratedValue value={` · ${a.dueOn}`} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {isNegative ? (
            canEdit ? (
              <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                <Label htmlFor="ca-title">
                  <GeneratedText id="m_1f458f26489fbc" />
                </Label>
                <div className="flex flex-wrap items-end gap-2">
                  <Input
                    id="ca-title"
                    className="min-w-48 flex-1"
                    value={actionTitle}
                    onChange={(e) => setActionTitle(e.target.value)}
                    placeholder={tGenerated('m_01dff4c6712678')}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="ca-due" className="text-xs">
                      <GeneratedText id="m_18244bb4488b03" />
                    </Label>
                    <Input
                      id="ca-due"
                      type="date"
                      value={actionDueOn}
                      onChange={(e) => setActionDueOn(e.target.value)}
                    />
                  </div>
                  <Button
                    disabled={pending || !actionTitle.trim()}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await raiseObservationAction({
                          id: entry.id,
                          title: actionTitle,
                          dueOn: actionDueOn || null,
                        })
                        if (result.ok) {
                          setActionTitle('')
                          setActionDueOn('')
                        }
                        router.refresh()
                      })
                    }
                  >
                    <GeneratedText id="m_017309f0f9f564" />
                  </Button>
                </div>
              </div>
            ) : null
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <GeneratedText id="m_1e955930b63842" />
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {submittable ? (
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await submitObservation(entry.id)
                router.refresh()
              })
            }
          >
            <GeneratedText id="m_042d15948e40e8" />
          </Button>
        ) : null}
        {entry.status === 'submitted' && canEdit ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await archiveObservation(entry.id)
                router.refresh()
              })
            }
          >
            <GeneratedText id="m_019c0a64030688" />
          </Button>
        ) : null}
        {entry.status === 'draft' && canEdit ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await discardObservation(entry.id)
                router.push('/observations')
              })
            }
          >
            <GeneratedText id="m_11773f3c3f7558" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
