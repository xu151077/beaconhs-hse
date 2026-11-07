/**
 * Guard rules for Builder deletions.
 *
 * Pure functions so the refusals are testable without a database or a request
 * context, and so the two Server Actions cannot drift apart from the rules the
 * product promises:
 *
 *   • an app with responses cannot be deleted — the responses are the
 *     operational record and leave deliberately, one at a time;
 *   • an app with automations cannot be deleted — a flow would keep firing
 *     against an app nobody can open;
 *   • a response that satisfies a scheduled compliance obligation is evidence
 *     and is never deleted from under the obligation.
 */
export type AppDeleteState = {
  hasResponses: boolean
  hasAutomations: boolean
}

export type ResponseDeleteState = {
  complianceObligationId: string | null
}

export function appDeleteRefusal(state: AppDeleteState): string | null {
  if (state.hasResponses) {
    return 'This app still has responses. Delete the responses you no longer need before deleting the app.'
  }
  if (state.hasAutomations) {
    return 'This app still has automations. Remove them before deleting the app.'
  }
  return null
}

export function responseDeleteRefusal(state: ResponseDeleteState): string | null {
  if (state.complianceObligationId) {
    return 'This response is compliance evidence for a scheduled obligation. It cannot be deleted.'
  }
  return null
}
