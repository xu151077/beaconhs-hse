# Phase 6U-B3-DM — CDP event contract

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Availability check (not assumed)

Every event the phase asked for exists in the Chromium shipped with Playwright 1.64.1. Verified against `node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/types/protocol.d.ts`:

| Event                                        | Present                             |
| -------------------------------------------- | ----------------------------------- |
| `Page.frameAttached`                         | yes                                 |
| `Page.frameNavigated`                        | yes                                 |
| `Page.frameDetached`                         | yes                                 |
| `Page.frameStoppedLoading`                   | yes                                 |
| `Page.frameStartedLoading`                   | yes (used — it bounds a navigation) |
| `Page.lifecycleEvent`                        | yes                                 |
| `Network.webSocketCreated`                   | yes                                 |
| `Network.webSocketWillSendHandshakeRequest`  | yes                                 |
| `Network.webSocketHandshakeResponseReceived` | yes                                 |
| `Network.webSocketFrameError`                | yes                                 |
| `Network.webSocketClosed`                    | yes                                 |

Nothing was emulated or inferred: an event that did not fire is reported as absent, not reconstructed.

## 2. How the events were collected

A temporary Playwright spec opened a CDP session on the page and enabled `Page`, `Network` and `Page.setLifecycleEventsEnabled` before navigation:

```ts
const cdp = await page.context().newCDPSession(page)
await cdp.send('Page.enable')
await cdp.send('Network.enable')
await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true })
cdp.on('Page.frameAttached' | 'Page.frameDetached' | 'Page.frameNavigated' |
       'Page.frameStartedLoading' | 'Page.frameStoppedLoading' |
       'Page.lifecycleEvent' | 'Network.webSocketCreated' | … , …)
```

Each event records: elapsed ms, source (`cdp` or `page`), event name, frame/session id, **pathname only**, and non-sensitive status fields.

Deliberately excluded: request/response headers, cookies, `Authorization`, query strings, WebSocket payloads (no `webSocketFrameSent`/`webSocketFrameReceived` was subscribed), DOM text.

## 3. Field contract

| Field              | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `t`                | ms since the recorder started                                          |
| `frameId`          | Chromium frame id (opaque 32-hex)                                      |
| `parentId`         | parent frame id, `null` for the main frame                             |
| `url`              | pathname only, e.g. `/documents/<id>`, `/browser/<hash>/cool.html`     |
| `name`             | lifecycle name (`DOMContentLoaded`, `load`, `firstPaint`, …)           |
| `status`           | WebSocket handshake HTTP status                                        |
| `errorMessage`     | WebSocket frame error text (no payload)                                |
| `openSocketsAtEnd` | WebSocket request ids created but not closed when the sample was taken |

## 4. What each event answers

| Question from the brief                            | Event(s) that answer it                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Is a child frame still navigating?                 | `Page.frameStartedLoading` without a matching `Page.frameStoppedLoading`            |
| Did the child frame fail to detach?                | absence of `Page.frameDetached` for its `frameId`                                   |
| Does frame detach line up with WebSocket lifetime? | ordering of `Page.frameDetached` vs `Network.webSocketClosed`                       |
| Is the main frame waiting on something else?       | `Page.lifecycleEvent { name: 'load' }` on the main frame id                         |
| Is the wait Playwright's or the browser's?         | presence/absence of the CDP `load` lifecycle event, compared with `page.on('load')` |

## 5. Status

Status: **PASS** — the contract was implemented and every listed event was captured at least once across the five attempts.
