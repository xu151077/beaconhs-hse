#!/usr/bin/env bash
# Gate 5 — reconcile the digest that is actually running with the digest that
# was gated, against the roster the deployment is DEFINED to have.
#
# Readiness reports APP_VERSION, a runtime environment variable. A task can
# answer 200 with the expected version while running a different image
# (EA56-T23), so readiness is not evidence of image identity. Only the service
# spec and task state are. This reads them back for every gated service in the
# stack and fails on a stale, mixed or INCOMPLETE fleet.
#
# Usage: reconcile-running-digest.sh <stack-name> <expected-digest> <roster-file>
#
#   <roster-file>  key=value roster describing what the stack is DEFINED to
#                  run (roles, replica counts, which roles must be live), with
#                  a `source=` provenance line. It is generated from the
#                  deployment's own definition (deploy/dokploy-dev.compose.yaml
#                  plus the workflow's WRITER_REPLICAS env), never from a query
#                  of the running fleet: a roster derived from what was found
#                  could not detect a missing service.
#
# Exits:
#   0  every rostered service exists, is inspectable, and runs the gated
#      digest at its expected replica state
#   1  a service runs something else, the fleet is incomplete or not
#      converged, a service cannot be inspected, the stack exposes no gated
#      service, the roster is missing or invalid, or the query itself failed
#   2  usage error (missing arguments, non-canonical digest, roster/digest
#      mismatch, malformed roster)
set -euo pipefail

stack="${1:-}"
expected="${2:-}"
roster_file="${3:-}"

if [ -z "$stack" ] || [ -z "$expected" ] || [ -z "$roster_file" ]; then
  echo "usage: reconcile-running-digest.sh <stack-name> <expected-digest> <roster-file>" >&2
  exit 2
fi

if ! [[ "$expected" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::refusing to reconcile: '$expected' is not a canonical sha256 digest" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Roster — the completeness contract. Without it the gate could only ever
# vouch for the services a query happened to return (EA59 S12).
# ---------------------------------------------------------------------------
if [ ! -r "$roster_file" ]; then
  echo "::error::Gate 5 has no roster file ('$roster_file'): an unrostered gate cannot detect a missing service, so it cannot prove completeness" >&2
  exit 1
fi

declare -A roster_replicas=()
declare -A roster_running=()
roster_stack=''
roster_digest=''
roster_source=''

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || { echo "::error::Gate 5 roster line is not key=value: '$line'" >&2; exit 2; }
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in
    stack) roster_stack="$value" ;;
    digest) roster_digest="$value" ;;
    source) roster_source="$value" ;;
    *.replicas)
      role="${key%.replicas}"
      [[ "$value" =~ ^[0-9]+$ ]] || { echo "::error::Gate 5 roster: $key must be a non-negative integer, got '$value'" >&2; exit 2; }
      roster_replicas["$role"]="$value"
      ;;
    *.running)
      role="${key%.running}"
      case "$value" in
        true|false) roster_running["$role"]="$value" ;;
        *) echo "::error::Gate 5 roster: $key must be true or false, got '$value'" >&2; exit 2 ;;
      esac
      ;;
    *)
      echo "::error::Gate 5 roster: unknown key '$key'" >&2
      exit 2
      ;;
  esac
done < "$roster_file"

# The roster must describe THIS stack and THIS digest; anything else is a
# misconfiguration, not a fleet fact.
if [ "$roster_stack" != "$stack" ]; then
  echo "::error::Gate 5 roster names stack '$roster_stack' but the gate targets '$stack'" >&2
  exit 2
fi
if [ -n "$roster_digest" ] && [ "$roster_digest" != "$expected" ]; then
  echo "::error::Gate 5 roster pins digest $roster_digest but the gate reconciles $expected" >&2
  exit 2
fi
if [ "${#roster_replicas[@]}" -eq 0 ]; then
  echo "::error::Gate 5 roster defines no <role>.replicas entries; refusing to gate against an empty roster" >&2
  exit 2
fi
for role in "${!roster_replicas[@]}"; do
  if [ -z "${roster_running[$role]:-}" ]; then
    echo "::error::Gate 5 roster: role '$role' has .replicas but no .running" >&2
    exit 2
  fi
done
if [[ ! "$stack" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "::error::Gate 5 refusing to reconcile an invalid stack name" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Enumeration — one query, status captured. A failed query is a failed query.
# ---------------------------------------------------------------------------
if ! services="$(docker service ls \
  --format '{{.Name}}' \
  --filter "label=com.docker.stack.namespace=${stack}")"; then
  echo "::error::Gate 5 could not list services for stack '$stack': the 'docker service ls' query failed (see the error above). This is a query failure, not an empty fleet; the running digest is unverified." >&2
  exit 1
fi

declare -A found=()
seen=0
while IFS= read -r service; do
  [ -n "$service" ] || continue
  seen=$((seen + 1))
  found["$service"]=1
done <<<"$services"

matched=0
failures=0
declare -a notes=()

# A query that succeeds and returns nothing is an empty fleet, not a complete
# one. Report it as such before the roster checks, so the operator sees the
# fleet-level cause rather than one "missing service" line per role.
if [ "$seen" -eq 0 ]; then
  echo "::error::Gate 5 matched no running service in stack '$stack': the query succeeded and returned no service; refusing to report success" >&2
  exit 1
fi

# Completeness: every rostered service must exist. This is the check EA-59's
# S12 proved missing — a subset listing used to pass.
for role in "${!roster_replicas[@]}"; do
  service="${stack}_${role}"
  if [ -z "${found[$service]:-}" ]; then
    echo "::error::Gate 5: rostered service '$service' is not in stack '$stack' (the query returned $seen service(s)); the instance set is incomplete" >&2
    failures=$((failures + 1))
  fi
done

# Unexpected gated services: any service in the stack that runs the gated image
# but is not in the roster is an unmanaged instance, not a detail. Services
# running OTHER images (minio, collabora, …) are out of Gate 5's scope.
while IFS= read -r service; do
  [ -n "$service" ] || continue
  role="${service#"${stack}_"}"
  [ "$role" != "$service" ] || continue
  [ -z "${roster_replicas[$role]:-}" ] || continue
  if other_image="$(docker service inspect "$service" \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null)"; then
    if [ "${other_image##*@}" = "$expected" ]; then
      echo "::error::Gate 5: service '$service' runs the gated digest but is absent from the roster; the roster does not describe this fleet" >&2
      failures=$((failures + 1))
    fi
  else
    echo "::error::Gate 5 cannot inspect $service (present in the stack, absent from the roster)" >&2
    failures=$((failures + 1))
  fi
done <<<"$services"

if [ "$failures" -ne 0 ]; then
  echo "::error::Gate 5 failed: the fleet does not match the roster; the instance set is not proven complete" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Identity + replica state, per rostered service.
# ---------------------------------------------------------------------------
for role in "${!roster_replicas[@]}"; do
  service="${stack}_${role}"
  desired="${roster_replicas[$role]}"
  requires_running="${roster_running[$role]}"
  matched=$((matched + 1))

  if ! spec_image="$(docker service inspect "$service" \
    --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')"; then
    echo "::error::Gate 5 cannot inspect $service" >&2
    failures=$((failures + 1))
    continue
  fi

  # Swarm stores the canonical `repo@sha256:...` form; compare the digest.
  running_digest="${spec_image##*@}"
  if [ "$running_digest" != "$expected" ] || [ "$running_digest" = "$spec_image" ]; then
    echo "::error::$service runs ${running_digest:-<not digest-addressed>}, expected $expected" >&2
    failures=$((failures + 1))
    continue
  fi

  if [ "$requires_running" != "true" ]; then
    # One-shot role (scheduler, storage-init): exits 0 after its work, so no
    # live task is expected. Identity is proven by the service spec above and
    # by task history: at least one task must have run the gated digest.
    if ! ps_out="$(docker service ps "$service" \
      --format '{{.CurrentState}}|{{.DesiredState}}|{{.Image}}' 2>&1)"; then
      echo "::error::Gate 5 cannot read task history for $service: the 'docker service ps' query failed" >&2
      failures=$((failures + 1))
      continue
    fi
    history_ok=0
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      state="${row%%|*}"
      rest="${row#*|}"
      image="${rest##*|}"
      task_digest="${image##*@}"
      if [ "$task_digest" = "$expected" ] && [[ "$state" == Complete* ]]; then
        history_ok=1
        break
      fi
    done <<<"$ps_out"
    if [ "$history_ok" -ne 1 ]; then
      echo "::error::$service is a one-shot service with no completed task on the gated digest; the rollout is not proven" >&2
      failures=$((failures + 1))
    else
      notes+=("$service: one-shot, spec + completed task on the gated digest")
    fi
    continue
  fi

  # Long-running role: desired replicas must be live, no update in flight.
  if ! ls_replicas="$(docker service inspect "$service" \
    --format '{{.Spec.Mode.Replicated.Replicas}}')"; then
    echo "::error::Gate 5 cannot read the replica spec of $service" >&2
    failures=$((failures + 1))
    continue
  fi
  if [ -z "$ls_replicas" ]; then
    echo "::error::$service is not a replicated service (no replica spec); the roster expects $desired" >&2
    failures=$((failures + 1))
    continue
  fi
  if [ "$ls_replicas" != "$desired" ]; then
    echo "::error::$service wants $ls_replicas replica(s) but the roster defines $desired; the deployment does not match its own definition" >&2
    failures=$((failures + 1))
    continue
  fi

  if ! ps_out="$(docker service ps "$service" \
    --format '{{.CurrentState}}|{{.DesiredState}}|{{.Image}}' 2>&1)"; then
    echo "::error::Gate 5 cannot read task state for $service: the 'docker service ps' query failed" >&2
    failures=$((failures + 1))
    continue
  fi
  running_here=0
  mismatched_tasks=0
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    state="${row%%|*}"
    rest="${row#*|}"
    desired_state="${rest%%|*}"
    image="${rest#*|}"
    image="${image##*|}"
    task_digest="${image##*@}"
    # Only tasks whose CURRENT state starts with Running count as live; swarm
    # history rows (Complete/Shutdown/Rejected) are excluded automatically.
    [[ "$state" == Running* ]] || continue
    running_here=$((running_here + 1))
    if [ "$task_digest" != "$expected" ] || [ "$task_digest" = "$image" ]; then
      echo "::error::$service has a running task on ${task_digest:-<not digest-addressed>}, expected $expected: mixed fleet" >&2
      mismatched_tasks=$((mismatched_tasks + 1))
    fi
  done <<<"$ps_out"
  if [ "$mismatched_tasks" -ne 0 ]; then
    failures=$((failures + mismatched_tasks))
    continue
  fi
  if [ "$running_here" -ne "$desired" ]; then
    echo "::error::$service has $running_here running task(s), expected $desired; the fleet is not converged" >&2
    failures=$((failures + 1))
    continue
  fi
  notes+=("$service: $running_here/$desired task(s) running the gated digest")
done

if [ "$failures" -ne 0 ]; then
  echo "::error::Gate 5 failed: $failures check(s) do not hold against the roster" >&2
  exit 1
fi

if [ "$matched" -eq 0 ]; then
  echo "::error::Gate 5 reconciled no service: the roster is empty or no rostered service could be checked" >&2
  exit 1
fi

for note in "${notes[@]}"; do
  echo "$note"
done
echo "Gate 5 PASS: all $matched rostered service(s) match the roster and run $expected (roster source: ${roster_source:-<unspecified>})"
