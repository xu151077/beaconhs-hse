// Testing utilities for privacy probe operations.
//
// This module exports a version of `writeAndRemovePrivacyProbe` that accepts a
// custom S3 client, allowing tests to mock the client without touching the
// module-level `internalClient`.

import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

export interface PrivacyProbeClient {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<void>
}

/**
 * Write and immediately delete the bucket-privacy probe object, using a custom client.
 *
 * This is a test helper that mirrors the production `writeAndRemovePrivacyProbe`
 * but accepts a custom client instead of using the module-level `internalClient`.
 * It's used to test the retry logic without needing to mock the module-level client.
 */
export async function writeAndRemovePrivacyProbeWithClient(
  key: string,
  client: PrivacyProbeClient,
): Promise<void> {
  let putError: Error | undefined
  let deleteError: Error | undefined

  // PUT is NOT retried: if the user's write fails, we want to surface that
  // error. The probe is a synthetic byte, so a PUT failure is a problem.
  try {
    console.log(`[writeAndRemovePrivacyProbeWithClient] PUT for key: ${key}`)
    const putCommand = new PutObjectCommand({
      Bucket: 'test-bucket',
      Key: key,
      Body: new Uint8Array([1]),
      ContentType: 'application/octet-stream',
    })
    console.log(
      `[writeAndRemovePrivacyProbeWithClient] PUT command input:`,
      (putCommand as any).input,
    )
    await client.send(putCommand)
  } catch (error) {
    putError = error instanceof Error ? error : new Error(String(error))
    // Continue to DELETE even if PUT failed — we want to clean up if possible.
  }

  // DELETE is retried: S3 delete is idempotent and can fail transiently.
  const maxRetries = 3
  let lastDeleteError: Error | undefined

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `[writeAndRemovePrivacyProbeWithClient] DELETE attempt ${attempt} for key: ${key}`,
      )
      const deleteCommand = new DeleteObjectCommand({ Bucket: 'test-bucket', Key: key })
      console.log(
        `[writeAndRemovePrivacyProbeWithClient] DELETE command input:`,
        (deleteCommand as any).input,
      )
      await client.send(deleteCommand)
      // Success: no error to return
      console.log(`[writeAndRemovePrivacyProbeWithClient] DELETE succeeded on attempt ${attempt}`)
      return
    } catch (error) {
      lastDeleteError = error instanceof Error ? error : new Error(String(error))
      console.log(
        `[writeAndRemovePrivacyProbeWithClient] DELETE failed on attempt ${attempt}: ${lastDeleteError.message}`,
      )

      // If this was the last attempt, we're done trying.
      if (attempt === maxRetries) {
        deleteError = lastDeleteError
        console.log(
          `[writeAndRemovePrivacyProbeWithClient] All retries failed, setting deleteError`,
        )
        break
      }

      // Exponential backoff: 100ms, 200ms, 400ms.
      const backoffMs = attempt * 100
      console.log(`[writeAndRemovePrivacyProbeWithClient] Retrying after ${backoffMs}ms...`)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  console.log(
    `[writeAndRemovePrivacyProbeWithClient] After retry loop: putError=${!!putError}, deleteError=${!!deleteError}`,
  )

  // If we get here, DELETE failed after all retries. The probe object remains
  // in the bucket. Log the error for investigation.
  if (deleteError) {
    console.error(
      '[writeAndRemovePrivacyProbeWithClient] DELETE failed after',
      maxRetries,
      'attempts for key:',
      key,
      'error:',
      deleteError.message,
    )
  }

  // If PUT failed and DELETE also failed, the caller will see the PUT error
  // (it propagates). If only DELETE failed, we throw an error that indicates
  // the probe could not be cleaned up.
  if (putError) {
    throw putError
  }

  throw new Error(`Failed to delete privacy probe ${key} after ${maxRetries} attempts`)
}
