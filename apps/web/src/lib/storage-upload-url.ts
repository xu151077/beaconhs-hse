// The browser-facing upload URL.
//
// WHY THIS EXISTS
// ---------------
// The upload used to be a presigned object-store PUT: the browser wrote
// straight to the object store, which required the object store to be publicly
// reachable. The internal-only object-storage architecture forbids that, so the
// browser now posts the file to the APPLICATION, which authorizes it and then
// writes to the object store over the internal endpoint.
//
// The reference carries only the upload id. The upload token — a short-lived
// write capability for the staging key — travels in the `x-upload-token`
// header instead of the URL: full URLs routinely end up in web/proxy/access
// logs, and a token in a query string would hand log readers the write
// capability for the reservation's lifetime. The token is verified against
// the reservation's hash before anything is written, and the caller cannot
// name a different object key, content type or size: those all come from the
// reservation row, not from the request.

const UPLOAD_TOKEN_HEADER = 'x-upload-token'

/** The browser-facing URL that accepts an upload body (token via header). */
export function storageUploadUrl(args: { uploadId: string; partNumber?: number }): string {
  const params = new URLSearchParams({ uploadId: args.uploadId })
  if (typeof args.partNumber === 'number') {
    params.set('partNumber', String(args.partNumber))
  }
  return `/api/storage/upload?${params.toString()}`
}
