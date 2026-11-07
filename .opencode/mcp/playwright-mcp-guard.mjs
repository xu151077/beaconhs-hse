/**
 * Crash guard for the Playwright MCP server process.
 *
 * WHY THIS EXISTS (Phase AM evidence, docs/phase-6u-b3-am-playwright-repair-report.md)
 * ---------------------------------------------------------------------------------
 * `@playwright/mcp` runs every tool call inside the Node process that serves the MCP
 * stdio connection. Playwright dispatches page events from a bare `Immediate` inside
 * `Connection.dispatch` with no try/catch around the listener call:
 *
 *   Connection.dispatch        playwright-core/lib/coreBundle.js
 *     -> Immediate.<anonymous>
 *       -> page.emit(event)
 *         -> listener body            <-- any throw here escapes the library
 *
 * A *synchronous* throw from any `page.on(...)` listener therefore becomes a Node
 * uncaught exception and terminates the MCP server with exit code 1. OpenCode
 * v2.0.30 does not restart a crashed local MCP server, so a single bad listener
 * removes every `playwright_*` tool for the rest of the session. That is exactly
 * how the Phase AK crash cost the Magic Link / upload / Collabora browser checks.
 *
 * Reproduced deterministically, and the stack is identical to the one OpenCode
 * recorded for the AK crash:
 *
 *   Error: <listener body>
 *       at _Page.<anonymous> (evalmachine.<anonymous>:4:11)
 *       at _Page._callHandler (playwright-core/lib/coreBundle.js:11544:33)
 *       at _Page.emit (playwright-core/lib/coreBundle.js:11539:18)
 *       at _BrowserContext._onRequestFailed (.../coreBundle.js:63703:16)
 *       at Connection.dispatch (.../coreBundle.js:65303:25)
 *       at Immediate.<anonymous> (.../coreBundle.js:65364:85)
 *       at process.processImmediate (node:internal/timers:574:21)
 *   Node.js v24.21.0
 *
 * WHAT THIS GUARD DOES — AND DOES NOT — DO
 * -----------------------------------------
 * It does NOT hide a test failure. The `tools/call` that was in flight when the
 * listener threw never receives a reply, so the client still sees a failed call
 * (a timeout against `timeout.execution` in opencode.jsonc). What the guard
 * removes is the *collateral damage*: the server process no longer dies, so the
 * browser, the MCP session, and every later tool call survive.
 *
 * Every caught exception is written to stderr with the marker below and its full
 * stack, so the condition stays visible in the OpenCode log instead of vanishing.
 *
 * Async listener rejections are deliberately NOT handled here. Playwright's own
 * context-level `onUnhandledRejection` hook already converts them into a normal
 * tool error (verified: the server survives), and adding a process-level handler
 * would suppress rejections the MCP server may still want to see.
 */

const MARKER = '[beaconhs:playwright-mcp-guard]'

function describe(error) {
  // The throwing listener usually lives in a `vm` context created by
  // `browser_run_code_unsafe`, so its Error comes from a different realm and
  // fails `instanceof Error`. Duck-type instead of trusting the prototype.
  if (error && typeof error === 'object') {
    const name = typeof error.name === 'string' ? error.name : 'Error'
    const message = typeof error.message === 'string' ? error.message : ''
    const stack = typeof error.stack === 'string' && error.stack ? error.stack : ''
    if (stack) return stack
    return `${name}: ${message}`
  }
  return `non-Error thrown: ${String(error)}`
}

process.on('uncaughtException', (error) => {
  process.stderr.write(
    [
      '',
      `${MARKER} recovered from an uncaught exception in the Playwright MCP server.`,
      `${MARKER} The in-flight MCP tool call will fail; the server and browser stay up.`,
      `${MARKER} Almost always an unguarded page.on(...) listener inside browser_run_code_unsafe.`,
      `${MARKER} Wrap listener bodies in try/catch. Stack follows:`,
      describe(error),
      '',
    ].join('\n'),
  )
})
