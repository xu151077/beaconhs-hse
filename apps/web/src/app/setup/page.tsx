// The first-run setup page.
//
// WHY THIS PAGE EXISTS
// --------------------
// A greenfield BeaconHS platform cannot complete its own onboarding through
// the product shell. `getRequestContext()` deliberately returns null for a
// super-admin while no active tenant exists, because the app shell requires a
// tenant-bound RequestContext even for platform administration. The only page
// that could create the first workspace is itself gated behind that context,
// so every authenticated route redirects to `/auth/continue` and the
// documented way forward is a command on the host.
//
// This page is that command's web equivalent, and it deliberately reuses the
// SAME business layer rather than reimplementing it:
//
//   * the administrator comes from `@beaconhs/auth`'s bootstrapFirstAdmin —
//     the two rows Better Auth's own sign-up route writes, hashed with
//     Better Auth's own scrypt hasher, refusing an existing super-admin and a
//     taken address;
//   * the workspace comes from `@beaconhs/db`'s provisionFirstTenant —
//     refusing when any workspace exists, creating the built-in roles, the
//     reference catalogue and the day-one audit row in one transaction;
//   * the platform email provider comes from the shared email-config layer,
//     which seals the credential with `sealSecret` and never returns the
//     plaintext.
//
// WHAT IT DOES NOT DO
// ------------------
// It creates no role, grants no permission and relaxes no RLS policy. The only
// privilege it can hand out is the platform's EXISTING `isSuperAdmin` flag,
// and only to the first account on a platform that has none.
//
// The surface is open only while the platform is uninitialized, and that state
// is derived from the database on every request: the absence of a super-admin
// IS the open state. There is no flag to flip and no public way to reopen the
// surface once the first administrator exists.
//
// The page is public by necessity — nobody can sign in yet — so every mutating
// action re-checks the database state, rate limits the attempt, and audits the
// outcome without ever recording a password or a credential.

import { EMAIL_PROVIDER_SPECS } from '@beaconhs/emails'
import { Card, CardContent } from '@beaconhs/ui'
import { GeneratedText } from '@/i18n/generated'
import { getGeneratedTranslations } from '@/i18n/generated.server'
import { getPlatformEmailSettings } from '@/lib/email-config'
import { getCurrentUserId, getSignedInSuperAdminId } from '@/lib/auth'
import { readFirstRunState } from '@/lib/first-run-setup'
import {
  EmailSettingsForm,
  type EmailProviderSpecLite,
} from '@/components/email-settings/settings-form'
import { EmailTestButton } from '@/components/email-settings/test-button'
import { saveFirstRunPlatformEmail, sendFirstRunTestEmail } from './actions'
import { FirstRunAdminForm, FirstRunTenantForm } from './setup-form'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const tGenerated = await getGeneratedTranslations()
  return { title: tGenerated('m_162b17f0929545') }
}

export default async function SetupPage() {
  const tGenerated = await getGeneratedTranslations()
  const superAdminId = await getSignedInSuperAdminId()
  const signedInId = await getCurrentUserId()
  const state = await readFirstRunState({
    signedIn: signedInId !== null,
    isSuperAdmin: superAdminId !== null,
  })

  const specs: EmailProviderSpecLite[] = EMAIL_PROVIDER_SPECS.map((p) => ({
    value: p.value,
    label: p.label,
    hasSecret: p.hasSecret,
    secretLabel: p.secretLabel,
    keyHint: p.keyHint,
    secretRequired: p.secretRequired,
    fields: p.fields,
    docsHint: p.docsHint,
  }))

  const platform = await getPlatformEmailSettings()

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10">
      <div className="space-y-1 text-center">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          <GeneratedText id="m_162b17f0929545" />
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          <GeneratedText id="m_1fe3ddf0f65cac" />
        </p>
      </div>

      {state.stage === 'create_admin' ? (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                <GeneratedText id="m_0f8ec1a052694c" />
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                <GeneratedText id="m_062b380048e244" />
              </p>
            </div>
            <FirstRunAdminForm />
          </CardContent>
        </Card>
      ) : null}

      {state.stage === 'sign_in' ? (
        <Card>
          <CardContent className="space-y-4 pt-6 text-center">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GeneratedText id="m_169c38f57a9323" />
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <GeneratedText id="m_0920666f5ae57c" />
            </p>
            <a
              href="/login"
              className="inline-flex items-center justify-center rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white"
            >
              <GeneratedText id="m_0337af701e3135" />
            </a>
          </CardContent>
        </Card>
      ) : null}

      {state.stage === 'create_tenant' ? (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-6 pt-6">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <GeneratedText id="m_00392995ee7539" />
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <GeneratedText id="m_08323866550316" />
                </p>
              </div>
              <EmailSettingsForm
                scope="platform"
                action={saveFirstRunPlatformEmail}
                specs={specs}
                initial={{ ...platform, mode: platform.mode }}
              />
              <div className="space-y-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                <EmailTestButton
                  scope="platform"
                  // The action is passed BY REFERENCE. An inline arrow here is a
                  // plain function created in a Server Component, and React
                  // refuses to serialize it to a Client Component — the whole
                  // setup page failed to render once an admin existed.
                  action={sendFirstRunTestEmail}
                  disabled={platform.mode === 'disabled'}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-6 pt-6">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <GeneratedText id="m_09c6f298c853d7" />
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <GeneratedText id="m_1b4e6e8ec54acc" />
                </p>
              </div>
              <FirstRunTenantForm />
            </CardContent>
          </Card>
        </div>
      ) : null}

      {state.stage === 'complete' ? (
        <Card>
          <CardContent className="space-y-4 pt-6 text-center">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GeneratedText id="m_1e9bc0caa67cb5" />
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <GeneratedText id="m_07bd2129a86542" />
            </p>
            <a
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white"
            >
              <GeneratedText id="m_00b4adfb14ffcb" />
            </a>
          </CardContent>
        </Card>
      ) : null}

      {state.stage === 'forbidden' ? (
        <Card>
          <CardContent className="space-y-4 pt-6 text-center">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GeneratedText id="m_1da8b8f3b20370" />
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <GeneratedText id="m_1fb7b1e9fc4015" />
            </p>
          </CardContent>
        </Card>
      ) : null}
    </main>
  )
}
