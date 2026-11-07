'use client'

import { useTranslations } from 'next-intl'
import { Button, Input, Label } from '@beaconhs/ui'
import { savePlatformOpenSource } from '@/lib/open-source-actions'
import type { OpenSourceSettings } from '@/lib/open-source-config'

export function PlatformOpenSourceForm({ settings }: { settings: OpenSourceSettings }) {
  const t = useTranslations('OpenSource')
  const common = useTranslations('Common')

  return (
    <form action={savePlatformOpenSource} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="open-source-url">{t('url')}</Label>
        <Input
          id="open-source-url"
          name="url"
          type="url"
          inputMode="url"
          defaultValue={settings.url}
          placeholder="https://github.com/example/app"
          autoComplete="off"
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('urlHelp')}</p>
      </div>

      <div className="flex justify-end">
        <Button type="submit">{common('save')}</Button>
      </div>
    </form>
  )
}
