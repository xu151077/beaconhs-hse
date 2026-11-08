import { getGeneratedTranslations } from '@/i18n/generated.server'
import { redirect } from 'next/navigation'
import { Button, Card, CardContent, Input, Label, Textarea } from '@beaconhs/ui'
import { requireRequestContext } from '@/lib/auth'
import { canCreateJournal, journalMutationScope } from '../../journals/_mutation-policy'
import { PageContainer } from '@/components/page-layout'
import { RemoteSelectField } from '@/components/remote-search-select'
import { createObservationDraft } from '../_actions'
import { isObservationDefinition, type ObservationDefinition } from '@beaconhs/db/schema'
import { dateIsoInTimeZone } from '@/lib/datetime'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_1d4341033ef81d') }
}

/** Radio values mirror the two `journal_definition` values exactly. */
const DEFINITIONS: { value: ObservationDefinition; titleKey: string; hintKey: string }[] = [
  {
    value: 'positive_observation',
    titleKey: 'm_06edf08d4b9c63',
    hintKey: 'm_0042ddf7905d2c',
  },
  {
    value: 'negative_observation',
    titleKey: 'm_011854ded66c8f',
    hintKey: 'm_1af5db97849ae7',
  },
]

async function submit(formData: FormData) {
  'use server'
  const ctx = await requireRequestContext()
  if (!canCreateJournal(ctx)) redirect('/observations')
  const result = await createObservationDraft({
    observedAt: String(formData.get('observedAt') ?? ''),
    definition: String(formData.get('definition') ?? '') as ObservationDefinition,
    siteOrgUnitId: String(formData.get('siteOrgUnitId') ?? '').trim() || null,
    supervisorPersonId: String(formData.get('supervisorPersonId') ?? '').trim() || null,
    title: String(formData.get('title') ?? ''),
  })
  if (result.ok) redirect(`/observations/${result.id}`)
  redirect('/observations/new')
}

export default async function NewObservationPage() {
  const tGenerated = await getGeneratedTranslations()
  const ctx = await requireRequestContext()
  // Pre-fill "observed on" with the field user's LOCAL calendar day — night
  // shift on UTC+8 must not get tomorrow's (UTC) date as data entry.
  // A caller with no create right has no business on the compose form at all.
  if (!canCreateJournal(ctx)) redirect('/observations')
  // The form edits in place on the detail page via `journals.update.own`; this
  // mirrors that check so the affordance is never offered without the gate.
  const editable = journalMutationScope(ctx, 'edit') !== 'none'

  return (
    <PageContainer>
      <form action={submit} className="mx-auto max-w-2xl space-y-6">
        <Card>
          <CardContent className="space-y-4 pt-6">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {tGenerated('m_104b55e72be068')}
              </legend>
              {DEFINITIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                >
                  <input
                    type="radio"
                    name="definition"
                    value={option.value}
                    defaultChecked={option.value === 'negative_observation'}
                    required
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                      {tGenerated(option.titleKey as never)}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {tGenerated(option.hintKey as never)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1.5">
              <Label htmlFor="observedAt">{tGenerated('m_126fbfcdbb3a34')}</Label>
              <Input
                id="observedAt"
                name="observedAt"
                type="date"
                required
                defaultValue={dateIsoInTimeZone(new Date(), ctx.timezone)}
              />
            </div>

            {/* Reuses the journals site picker (`admin.org` reads the same
                org_units tree) and the journals supervisor picker. No
                observation-specific picker is registered. */}
            <div className="space-y-1.5">
              <Label>{tGenerated('m_055f11420b2da4')}</Label>
              <RemoteSelectField
                lookup="journal-locations"
                name="siteOrgUnitId"
                placeholder={tGenerated('m_1ad901c0a1f003')}
                searchPlaceholder={tGenerated('m_016e087c3c8544')}
                sheetTitle={tGenerated('m_1ad901c0a1f003')}
                ariaLabel={tGenerated('m_188f14a9d8c62f')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="title">{tGenerated('m_0decefd558c355')}</Label>
              <Input id="title" name="title" placeholder={tGenerated('m_01cf7b315e3339')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">{tGenerated('m_104b55e72be068')}</Label>
              <Textarea
                id="description"
                name="description"
                rows={4}
                placeholder={tGenerated('m_1dc8734021031d')}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{tGenerated('m_0ccb8e5b917b17')}</Label>
              <RemoteSelectField
                lookup="journal-supervisors"
                name="supervisorPersonId"
                placeholder={tGenerated('m_10d1d0d92a9aaa')}
                searchPlaceholder={tGenerated('m_0b842b664b4f3b')}
                sheetTitle={tGenerated('m_0dc18a25314cf3')}
                ariaLabel={tGenerated('m_16d72d9e63f13d')}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!editable}>
            {tGenerated('m_0358b78d543881')}
          </Button>
          <Button type="button" variant="outline" asChild={false}>
            <a href="/observations">{tGenerated('m_112e2e8ecda428')}</a>
          </Button>
        </div>
      </form>
    </PageContainer>
  )
}
