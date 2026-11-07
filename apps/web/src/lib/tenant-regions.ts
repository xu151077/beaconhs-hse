/**
 * Tenant region options for the platform "create tenant" form.
 *
 * `tenants.region` is free text in the database, so this list is the only
 * place the choices are defined. Keep it in one module so the platform form
 * and any future region picker read the same catalogue instead of drifting.
 *
 * The labels are English source strings; the translation catalogue carries
 * the per-locale rendering, the same way every other GeneratedValue works.
 */
export const TENANT_REGIONS = [
  { value: 'ap-southeast-1', label: 'Singapore (ap-southeast-1)' },
  { value: 'ap-southeast-2', label: 'Sydney (ap-southeast-2)' },
  { value: 'ap-southeast-3', label: 'Jakarta (ap-southeast-3)' },
  { value: 'ap-southeast-4', label: 'Melbourne (ap-southeast-4)' },
  { value: 'cn-north-1', label: 'Beijing (cn-north-1)' },
  { value: 'cn-northwest-1', label: 'Ningxia (cn-northwest-1)' },
  { value: 'ap-south-1', label: 'Mumbai (ap-south-1)' },
  { value: 'ap-northeast-1', label: 'Tokyo (ap-northeast-1)' },
  { value: 'ap-northeast-2', label: 'Seoul (ap-northeast-2)' },
  { value: 'ap-northeast-3', label: 'Osaka (ap-northeast-3)' },
  { value: 'ap-east-1', label: 'Hong Kong (ap-east-1)' },
  { value: 'ca-central-1', label: 'Canada (Central)' },
  { value: 'ca-west-1', label: 'Calgary (ca-west-1)' },
  { value: 'us-east-1', label: 'US East (N. Virginia)' },
  { value: 'us-east-2', label: 'US East (Ohio)' },
  { value: 'us-west-1', label: 'US West (N. California)' },
  { value: 'us-west-2', label: 'US West (Oregon)' },
  { value: 'sa-east-1', label: 'São Paulo (sa-east-1)' },
  { value: 'eu-west-1', label: 'Ireland (eu-west-1)' },
  { value: 'eu-west-2', label: 'London (eu-west-2)' },
  { value: 'eu-central-1', label: 'Frankfurt (eu-central-1)' },
  { value: 'eu-north-1', label: 'Stockholm (eu-north-1)' },
  { value: 'eu-south-1', label: 'Milan (eu-south-1)' },
  { value: 'me-central-1', label: 'UAE (me-central-1)' },
  { value: 'af-south-1', label: 'Cape Town (af-south-1)' },
] as const

export type TenantRegion = (typeof TENANT_REGIONS)[number]

export const DEFAULT_TENANT_REGION = 'ca-central-1'

export function isTenantRegion(value: string): value is TenantRegion['value'] {
  return TENANT_REGIONS.some((region) => region.value === value)
}
