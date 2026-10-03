'use client'

// Photo section for one safety observation.
//
// Reuses the SHARED upload + gallery primitives and the journals photo actions
// (class-pinned), so an observation gets photos through the existing
// journal_entry_photos -> attachments -> storage chain. There is no
// observation-specific attachment table or uploader.

import { PhotoUploaderSection } from '@/components/photo-uploader-section'
import { PhotoGallery, type GalleryPhoto } from '@/components/photo-gallery'
import type { JournalPhoto } from '../../journals/_types'
import {
  attachObservationPhotos,
  removeObservationPhoto,
  reorderObservationPhotos,
  updateObservationPhoto,
} from '../_actions'

export function ObservationPhotos({
  observationId,
  photos,
  editable,
}: {
  observationId: string
  photos: JournalPhoto[]
  /** Draft-only: attachments are managed while the observation is editable. */
  editable: boolean
}) {
  const gallery: GalleryPhoto[] = photos.map((p) => ({
    id: p.id,
    attachmentId: p.attachmentId,
    url: p.url ?? '',
    filename: p.filename,
    caption: p.caption,
    annotations: p.annotations,
    width: p.width,
    height: p.height,
  }))

  return (
    <div className="space-y-3">
      {editable ? (
        <PhotoUploaderSection
          attachAction={async (attachmentIds) => {
            await attachObservationPhotos({ id: observationId, attachmentIds })
          }}
        />
      ) : null}
      {gallery.length > 0 ? (
        <PhotoGallery
          photos={gallery}
          editable={editable}
          onUpdate={async (photoId, edits) => {
            const result = await updateObservationPhoto(photoId, edits, observationId)
            return result.ok ? undefined : { ok: false, error: result.error }
          }}
          onRemove={async (photoId) => {
            const result = await removeObservationPhoto(photoId, observationId)
            return result.ok ? undefined : { ok: false, error: result.error }
          }}
          onReorder={async (photoIds) => {
            const result = await reorderObservationPhotos(observationId, photoIds)
            return result.ok ? undefined : { ok: false, error: result.error }
          }}
        />
      ) : null}
    </div>
  )
}
