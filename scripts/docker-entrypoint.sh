#!/bin/sh
# Boot the container with secrets pulled live from Infisical, so Infisical is
# the single source of truth instead of a hand-copied set of Coolify env vars.
#
# Chain: tini (PID 1) -> exec infisical run -> app
# Both hops are `exec`, so SIGTERM from `docker stop` reaches the app.
#
# Injection is gated on the machine-identity credentials being present. Unset
# them (in Coolify) and the container falls straight back to booting on the
# ambient environment -- that is the rollback lever, and it needs no rebuild.
#
# Configure with image ENV (set in the Dockerfile):
#   INFISICAL_PROJECT_ID     Infisical project id
#   INFISICAL_ENVIRONMENT    dev | staging | prod
#   INFISICAL_SECRET_PATH    /<project> folder this app boots on
#   INFISICAL_MIN_SECRETS    refuse to start if the fetch returns fewer keys
# Supplied at runtime by the platform (the ONLY secret it holds):
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_ID / INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
set -eu

: "${INFISICAL_PROJECT_ID:=}"
: "${INFISICAL_ENVIRONMENT:=prod}"
: "${INFISICAL_SECRET_PATH:=/}"
: "${INFISICAL_MIN_SECRETS:=1}"
: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:=}"
: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:=}"

if [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" ] || [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ]; then
  echo "[entrypoint] no Infisical machine identity configured -- booting on the ambient environment" >&2
  exec "$@"
fi

if [ -z "$INFISICAL_PROJECT_ID" ]; then
  echo "[entrypoint] FATAL: INFISICAL_PROJECT_ID is not set in the image" >&2
  exit 1
fi

# Token cache goes to a plain file under $HOME; the container has no keyring and
# `auto` would otherwise probe for one on every boot.
infisical vault set file --silent --telemetry=false >/dev/null 2>&1 || true

echo "[entrypoint] authenticating to Infisical as clientId=${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID}" >&2

# --plain prints the access token and nothing else. Captured into a variable and
# exported so it is never an argv value (argv is world-readable via /proc).
INFISICAL_TOKEN="$(
  infisical login \
    --method=universal-auth \
    --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
    --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
    --plain --silent --telemetry=false
)"
export INFISICAL_TOKEN

if [ -z "$INFISICAL_TOKEN" ]; then
  echo "[entrypoint] FATAL: Infisical login returned an empty token" >&2
  exit 1
fi
echo "[entrypoint] authenticated (token length ${#INFISICAL_TOKEN})" >&2

# Pre-flight: a wrong-scoped identity does NOT fail. It fetches zero secrets and
# exits 0, and because `infisical run` layers its secrets over the inherited
# environment, the app would then boot happily on stale platform copies -- the
# exact drift this entrypoint exists to eliminate, made invisible. So count what
# the fetch actually returned and refuse to start if it came back short.
#
# `-- true` runs the cheapest possible child; the count is read from the CLI's own
# "Injecting N Infisical secrets" line, which carries no values.
INJECTED="$(
  infisical run \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="$INFISICAL_ENVIRONMENT" \
    --path="$INFISICAL_SECRET_PATH" \
    --telemetry=false \
    -- true 2>&1 | sed -n 's/.*Injecting \([0-9][0-9]*\) Infisical secrets.*/\1/p' | head -1
)"

if [ -z "$INJECTED" ]; then
  # Unparseable (most likely an Infisical CLI upgrade changed the wording). Warn
  # rather than fail: refusing to boot over a log-format change would be worse
  # than the drift risk it guards against.
  echo "[entrypoint] WARNING: could not determine the injected secret count -- skipping the floor check" >&2
elif [ "$INJECTED" -lt "$INFISICAL_MIN_SECRETS" ]; then
  echo "[entrypoint] FATAL: Infisical returned ${INJECTED} secrets from ${INFISICAL_ENVIRONMENT}:${INFISICAL_SECRET_PATH}, expected at least ${INFISICAL_MIN_SECRETS}." >&2
  echo "[entrypoint] Refusing to start on the stale platform environment." >&2
  echo "[entrypoint] MOST LIKELY CAUSE: the machine identity cannot read that path." >&2
  echo "[entrypoint] FIX: Infisical -> project -> Access Control -> Identities -> this app's identity" >&2
  echo "[entrypoint]      -> its role -> secret path ${INFISICAL_SECRET_PATH} in ${INFISICAL_ENVIRONMENT}." >&2
  echo "[entrypoint] No redeploy needed; restart the container after fixing the role." >&2
  exit 1
else
  echo "[entrypoint] Infisical returned ${INJECTED} secrets from ${INFISICAL_ENVIRONMENT}:${INFISICAL_SECRET_PATH}" >&2
fi

# Deliberately NOT --silent: the CLI's own "Injecting N Infisical secrets" line
# is a value-free health signal in the container log.
exec infisical run \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENVIRONMENT" \
  --path="$INFISICAL_SECRET_PATH" \
  --telemetry=false \
  -- "$@"
