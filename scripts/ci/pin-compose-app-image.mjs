#!/usr/bin/env node
/**
 * Pin ONLY the BeaconHS application services in a Compose file.
 *
 * The drill build used to run a global `sed` over every `image:` line. That
 * rewrote postgres/redis/minio/mailpit/collabora to the application image and
 * made the stack unusable. This helper is a strict, service-scoped replacement:
 *
 *   - the application service set is read from the trusted Gate 5 manifest
 *     (`image_class: gated`);
 *   - only the `image:` line directly inside those service blocks is replaced;
 *   - every other byte is preserved;
 *   - the service set, service count, and every non-application image are
 *     parsed before and after and compared;
 *   - on any error the helper writes nothing to stdout and exits non-zero, so
 *     the caller keeps the original file/content.
 *
 * Usage:
 *   node pin-compose-app-image.mjs --manifest <gate5.manifest.yaml> --image <ref> < compose.yaml
 *
 * The caller must still validate the result with `docker compose config` and
 * must not publish it until that validation passes.
 */
import { readFileSync } from 'node:fs'

function fail(message) {
  console.error(`[pin-compose-app-image] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  let manifest = ''
  let image = ''
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--manifest':
        manifest = argv[index + 1] ?? ''
        index += 1
        break
      case '--image':
        image = argv[index + 1] ?? ''
        index += 1
        break
      default:
        fail(`unknown argument '${argv[index]}'`)
    }
  }
  if (!manifest) fail('--manifest is required')
  if (!image) fail('--image is required')
  if (!/^[A-Za-z0-9._:/-]+$/.test(image)) fail(`unsafe image reference '${image}'`)
  return { manifest, image }
}

function gatedServices(manifestPath) {
  let text
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    fail(`cannot read manifest '${manifestPath}': ${error.message}`)
  }
  const gated = new Set()
  let inServices = false
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^ */)[0].length
    const stripped = line.trim()
    if (indent === 0) {
      inServices = stripped === 'services:'
      current = null
      continue
    }
    if (!inServices) continue
    if (indent === 2 && stripped.endsWith(':')) {
      current = stripped.slice(0, -1)
      continue
    }
    if (indent === 4 && current && stripped === 'image_class: gated') {
      gated.add(current)
    }
  }
  if (gated.size === 0) fail(`manifest '${manifestPath}' declares no gated services`)
  return gated
}

/**
 * Parse the strict Compose shape used by this repository: a top-level
 * `services:` mapping, service names at two spaces, direct fields at four.
 * It intentionally rejects duplicate services/images rather than guessing.
 */
function parseCompose(lines) {
  const services = new Map()
  const images = new Map()
  let inServices = false
  let current = null

  lines.forEach((line, index) => {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true
      current = null
      return
    }
    if (inServices && /^\S/.test(line)) {
      inServices = false
      current = null
      return
    }
    if (!inServices) return

    const serviceMatch = /^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line)
    if (serviceMatch) {
      current = serviceMatch[1]
      if (services.has(current)) fail(`duplicate service '${current}'`)
      services.set(current, index)
      return
    }

    if (!current) return
    const imageMatch = /^    image:\s*(\S+)(\s*(?:#.*)?)$/.exec(line)
    if (!imageMatch) return
    if (images.has(current)) fail(`duplicate image field for service '${current}'`)
    images.set(current, { value: imageMatch[1], suffix: imageMatch[2], line: index })
  })

  return { services, images }
}

const { manifest, image } = parseArgs(process.argv.slice(2))
const gated = gatedServices(manifest)
const input = readFileSync(0, 'utf8')
if (input.length === 0) fail('empty Compose input')

const lines = input.split('\n')
const before = parseCompose(lines)
if (before.services.size === 0) fail('no services found')

const output = [...lines]
for (const service of gated) {
  if (!before.services.has(service))
    fail(`gated service '${service}' is missing from the Compose file`)
  const current = before.images.get(service)
  if (!current) fail(`gated service '${service}' has no image field`)
  output[current.line] = `    image: ${image}${current.suffix}`
}

const after = parseCompose(output)
if (before.services.size !== after.services.size) fail('service count changed')
if ([...before.services.keys()].join('\n') !== [...after.services.keys()].join('\n')) {
  fail('service set changed')
}
for (const service of gated) {
  if (after.images.get(service)?.value !== image) {
    fail(`gated service '${service}' was not pinned to '${image}'`)
  }
}
for (const service of before.services.keys()) {
  if (gated.has(service)) continue
  if (before.images.get(service)?.value !== after.images.get(service)?.value) {
    fail(`non-application image changed for '${service}'`)
  }
}

process.stdout.write(output.join('\n'))
