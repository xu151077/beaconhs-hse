'use client'

// Portrait photo uploader for the person page sidebar.
//
// The photo is the one rendered on the ID badge, so it shares the
// manage-or-self rule of the Files tab: managers and the person's own linked
// account may maintain it. The upload goes through the shared FileUploader
// (which inserts the `attachments` row); the server action stamps
// `people.photo_attachment_id`.

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, Loader2, Trash2 } from 'lucide-react'
import { Button, FileUploader } from '@beaconhs/ui'
import { useGeneratedTranslations, useGeneratedValueTranslations } from '@/i18n/generated'
import { finalizeUpload, requestMultipartPartUrl, requestUpload } from '@/lib/uploads'
import { toast } from '@/lib/toast'
import { setPersonPhoto } from '../_actions/files'

export function PersonPhotoUploader({
  personId,
  hasPhoto,
}: {
  personId: string
  hasPhoto: boolean
}) {
  const tGenerated = useGeneratedTranslations()
  const tGeneratedValue = useGeneratedValueTranslations()
  const router = useRouter()
  const [busy, startTransition] = useTransition()

  return (
    <div className="w-full space-y-2">
      <FileUploader
        requestUploadAction={requestUpload}
        finalizeUploadAction={finalizeUpload}
        requestMultipartPartAction={requestMultipartPartUrl}
        kind="image"
        accept=".png,.jpg,.jpeg,.heic,.webp"
        onUploaded={(f) => {
          startTransition(async () => {
            const res = await setPersonPhoto({ personId, attachmentId: f.attachmentId })
            if (res.ok) {
              toast.success(tGenerated('m_082e65157e6dff'))
              router.refresh()
            } else {
              toast.error(tGeneratedValue(res.error))
            }
          })
        }}
        label={tGenerated('m_082e65157e6dff')}
        hint={tGenerated('m_0c221b9f95faca')}
      />
      {hasPhoto ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-400 dark:hover:bg-rose-950/40"
          disabled={busy}
          onClick={() => {
            startTransition(async () => {
              const res = await setPersonPhoto({ personId, attachmentId: null })
              if (res.ok) {
                toast.success(tGenerated('m_082e65157e6dff'))
                router.refresh()
              } else {
                toast.error(tGeneratedValue(res.error))
              }
            })
          }}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {tGenerated('m_11773f3c3f7558')}
        </Button>
      ) : (
        <p className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
          <Camera size={11} />
        </p>
      )}
    </div>
  )
}
