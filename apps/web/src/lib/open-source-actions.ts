'use server'

import { revalidatePath } from 'next/cache'
import { PLATFORM_SETTINGS_ID } from '@beaconhs/db/schema'
import { requireRequestContext } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { savePlatformOpenSourceSettings } from '@/lib/open-source-config'

async function gatePlatform() {
  const ctx = await requireRequestContext()
  if (!ctx.isSuperAdmin) {
    throw new Error('Only platform super-admins can change the open-source link.')
  }
  return ctx
}

export async function savePlatformOpenSource(formData: FormData) {
  const ctx = await gatePlatform()
  const raw = formData.get('url')
  // A missing field or a file part means the submit is malformed — reject it
  // rather than silently clearing a deployment-wide link shown on every
  // dashboard. Only a deliberate (possibly empty) text field is accepted.
  if (raw === null || typeof raw !== 'string') {
    throw new Error('Missing repository URL field.')
  }
  const url = raw
  await savePlatformOpenSourceSettings({ url })
  await recordAudit(ctx, {
    entityType: 'platform_settings',
    entityId: PLATFORM_SETTINGS_ID,
    action: 'update',
    summary: 'Updated the open-source repository link',
    metadata: { sourceUrlSet: Boolean(url) },
  })
  revalidatePath('/platform/source')
  revalidatePath('/platform')
  revalidatePath('/dashboard')
}
