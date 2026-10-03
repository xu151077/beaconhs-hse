'use client'

import {
  GeneratedText,
  useGeneratedTranslations,
  GeneratedValue,
  useGeneratedValueTranslations,
} from '@/i18n/generated'

// Create / edit a company in a right-side flyout. Opened via the URL
// (?drawer=new | ?drawer=<id>) so it survives refresh and is link-shareable.
// The save server action is passed in from the RSC page.
//
// A company is a named tenant catalog row with exactly two editable facts: its
// name and whether it is a contractor or a subcontractor. The type is a
// reclassification, not a separate entity, so it is a plain two-option select
// rather than a second form.

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button, Input, Label, Select, UrlDrawer } from '@beaconhs/ui'

export type CompanyEditing = {
  id: string
  name: string
  type: 'contractor' | 'subcontractor'
}

type SaveAction = (input: {
  id?: string
  name: string
  type: string
}) => Promise<{ ok: true } | { ok: false; error: string }>

export function CompanyDrawer({
  mode,
  editing,
  closeHref,
  saveAction,
}: {
  mode: 'new' | 'edit' | null
  editing: CompanyEditing | null
  closeHref: string
  saveAction: SaveAction
}) {
  const tGeneratedValue = useGeneratedValueTranslations()
  const tGenerated = useGeneratedTranslations()
  const router = useRouter()
  function close() {
    router.push(closeHref)
    router.refresh()
  }
  return (
    <UrlDrawer
      open={mode !== null}
      closeHref={closeHref}
      title={tGeneratedValue(
        mode === 'edit' ? tGenerated('m_16f56d73b81258') : tGenerated('m_11ce66702c4782'),
      )}
      description={tGeneratedValue(
        mode === 'edit' ? tGenerated('m_1b2cd7837467c3') : tGenerated('m_136e6016ac5ff2'),
      )}
      size="md"
    >
      <CompanyForm
        key={editing?.id ?? 'new'}
        editing={editing}
        saveAction={saveAction}
        onDone={close}
      />
    </UrlDrawer>
  )
}

function CompanyForm({
  editing,
  saveAction,
  onDone,
}: {
  editing: CompanyEditing | null
  saveAction: SaveAction
  onDone: () => void
}) {
  const tGeneratedValue = useGeneratedValueTranslations()
  const tGenerated = useGeneratedTranslations()
  const [name, setName] = useState(editing?.name ?? '')
  const [type, setType] = useState<'contractor' | 'subcontractor'>(editing?.type ?? 'contractor')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit() {
    setError(tGeneratedValue(null))
    const trimmed = name.trim()
    if (!trimmed) {
      setError(tGenerated('m_1c66cb30434189'))
      return
    }
    startTransition(async () => {
      const res = await saveAction({ id: editing?.id, name: trimmed, type })
      if (res.ok) onDone()
      else setError(tGeneratedValue(res.error))
    })
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <Label htmlFor="company-name">
          <GeneratedText id="m_1a9978900838e6" />
        </Label>
        <Input
          id="company-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={tGenerated('m_173e6f05f57ff8')}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="company-type">
          <GeneratedText id="m_074ba2f160c506" />
        </Label>
        <Select
          id="company-type"
          value={type}
          onChange={(e) => {
            const next = e.currentTarget.value
            if (next === 'contractor' || next === 'subcontractor') setType(next)
          }}
        >
          <option value="contractor">
            <GeneratedText id="m_03765a68a90b51" />
          </option>
          <option value="subcontractor">
            <GeneratedText id="m_052246f4a904a3" />
          </option>
        </Select>
      </div>

      <GeneratedValue
        value={
          error ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
              <GeneratedValue value={error} />
            </p>
          ) : null
        }
      />

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          <GeneratedText id="m_112e2e8ecda428" />
        </Button>
        <Button type="submit" disabled={pending}>
          <GeneratedValue
            value={pending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
          />
          <GeneratedValue
            value={
              editing ? (
                <GeneratedText id="m_1ab9025ed1067c" />
              ) : (
                <GeneratedText id="m_1f87190c432719" />
              )
            }
          />
        </Button>
      </div>
    </form>
  )
}
