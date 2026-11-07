/**
 * Phase BU — how long a PDF preview may spend loading before it is abandoned.
 *
 * pdf.js reads a PDF whose cross-reference table it cannot use in "recovery"
 * mode, where `XRef.indexObjects()` walks the entire file and `readToken()`
 * accumulates one JavaScript string per character of the longest run between
 * delimiters. That cost grows with the file, and the growth happens in the
 * pdf.js worker: a 256 MiB file of that shape took a Chromium renderer from
 * ~200 MB to 4.7 GB and killed the tab (measured, Phase BU). A complete PDF
 * never enters recovery mode — a 255 MiB document resolves and renders in well
 * under a second.
 *
 * So the ceiling only ever fires on input that is going wrong. It is set an
 * order of magnitude above the slowest real load measured (a 255 MiB document
 * on a local origin), because the destructive case reaches an out-of-memory
 * kill fastest on the smallest devices: the renderer that took 31 s to die here
 * would die in single-digit seconds on a 4 GB laptop.
 *
 * The upload path already refuses a PDF without a trailer (see
 * `uploadedFileTailError`), so this is the backstop for the remaining shapes:
 * a file whose trailer is intact but whose xref is damaged, anything already in
 * storage, and any future pdf.js regression.
 */
export const PDF_PREVIEW_LOAD_TIMEOUT_MS = 10_000

/**
 * Start the preview deadline. Returns the stopper to call once the document has
 * loaded, or when the viewer unmounts or swaps documents.
 */
export function startPdfLoadWatchdog(
  onTimeout: () => void,
  timeoutMs: number = PDF_PREVIEW_LOAD_TIMEOUT_MS,
): () => void {
  const timer = setTimeout(onTimeout, timeoutMs)
  return () => clearTimeout(timer)
}
