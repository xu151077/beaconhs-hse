'use client'

// Client components for the first-run setup flow.
//
// Each form posts to a server action with `useActionState`, so the server
// owns the decision and the client only renders the outcome. The forms carry
// no authorization logic: the server re-checks the database state on every
// call, so a stale page cannot create a second administrator.
//
// The copy goes through the generated i18n layer, like every other user-facing
// string in this product.

import { useGeneratedTranslations, useGeneratedValueTranslations } from '@/i18n/generated'
import { GeneratedText, GeneratedValue } from '@/i18n/generated'

import { useActionState, useState, useTransition } from 'react'
import { Alert, AlertDescription, Button, Input, Label, Select } from '@beaconhs/ui'
import { DEFAULT_TENANT_REGION, TENANT_REGIONS } from '@/lib/tenant-regions'
import { createFirstRunAdmin, createFirstRunTenant, type FirstRunActionResult } from './actions'

export function FirstRunAdminForm() {
  const tGenerated = useGeneratedTranslations()
  const tGeneratedValue = useGeneratedValueTranslations()
  const [state, formAction, pending] = useActionState<FirstRunActionResult | null, FormData>(
    createFirstRunAdmin,
    null,
  )
  const [confirm, setConfirm] = useState('')
  const [password, setPassword] = useState('')

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="first-run-email">
          <GeneratedText id="m_10afac05d802b6" />
        </Label>
        <Input
          id="first-run-email"
          name="email"
          type="email"
          autoComplete="username"
          maxLength={254}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-name">
          <GeneratedText id="m_1c1de2054d510a" />
        </Label>
        <Input id="first-run-name" name="name" autoComplete="name" maxLength={120} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-password">
          <GeneratedText id="m_06ac3cf2f51393" />
        </Label>
        <Input
          id="first-run-password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          <GeneratedText id="m_09de6fe0e6c95a" />
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-password-confirm">
          <GeneratedText id="m_0892c59396820e" />
        </Label>
        <Input
          id="first-run-password-confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {confirm && confirm !== password ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            <GeneratedText id="m_1a693e3b299b7c" />
          </p>
        ) : null}
      </div>

      <GeneratedValue
        value={
          state?.details?.length ? (
            <Alert variant="destructive">
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {state.details.map((detail, index) => (
                    <li key={index}>{tGeneratedValue(detail)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : state?.error ? (
            <Alert variant="destructive">
              <AlertDescription>{tGeneratedValue(state.error)}</AlertDescription>
            </Alert>
          ) : state?.message ? (
            <Alert variant="success">
              <AlertDescription>{tGeneratedValue(state.message)}</AlertDescription>
            </Alert>
          ) : null
        }
      />

      <Button type="submit" disabled={pending || (confirm.length > 0 && confirm !== password)}>
        <GeneratedValue
          value={pending ? tGenerated('m_1fc4c34a7c247b') : tGenerated('m_1cbf6304a980c5')}
        />
      </Button>
    </form>
  )
}

export function FirstRunTenantForm() {
  const tGenerated = useGeneratedTranslations()
  const tGeneratedValue = useGeneratedValueTranslations()
  const [state, formAction, pending] = useActionState<FirstRunActionResult | null, FormData>(
    createFirstRunTenant,
    null,
  )

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="first-run-tenant-name">
          <GeneratedText id="m_07b037c927a20b" />
        </Label>
        <Input id="first-run-tenant-name" name="name" maxLength={200} required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-tenant-slug">
          <GeneratedText id="m_0bb81032384217" />
        </Label>
        <Input id="first-run-tenant-slug" name="slug" maxLength={80} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="first-run-tenant-region">
          <GeneratedText id="m_163dee679eb575" />
        </Label>
        <Select id="first-run-tenant-region" name="region" defaultValue={DEFAULT_TENANT_REGION}>
          {TENANT_REGIONS.map((region) => (
            <option key={region.value} value={region.value}>
              {tGeneratedValue(region.label)}
            </option>
          ))}
        </Select>
      </div>

      <GeneratedValue
        value={
          state?.error ? (
            <Alert variant="destructive">
              <AlertDescription>{tGeneratedValue(state.error)}</AlertDescription>
            </Alert>
          ) : state?.message ? (
            <Alert variant="success">
              <AlertDescription>{tGeneratedValue(state.message)}</AlertDescription>
            </Alert>
          ) : null
        }
      />

      <Button type="submit" disabled={pending}>
        <GeneratedValue
          value={pending ? tGenerated('m_1fc4c34a7c247b') : tGenerated('m_1783c82fdd61cf')}
        />
      </Button>
    </form>
  )
}
