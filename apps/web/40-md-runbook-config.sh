#!/bin/sh
# The web app's runtime configuration, written when the container starts (nginx's entrypoint runs
# /docker-entrypoint.d/*.sh before nginx): /config.json, which the app reads on load
# (apps/mobile/src/settings/runtimeConfig.ts), and the team library's location when it is not
# /runbooks/. Both go to /tmp: the container runs read-only (--read-only --tmpfs /tmp).
#
#   MD_RUNBOOK_PUBLIC_URL  the address users reach the web app at (https://runbooks.example.net):
#                          share links, QR codes and pairing links start with it. Default: none,
#                          the app uses the address its page was opened from.
#   MD_RUNBOOK_LIBRARY     the team library's folder on the app's origin, /runbooks/ by default
#                          (/sop/: the folder mounted at /usr/share/nginx/html/sop).
#
# No secrets: anyone who reaches the web app can read /config.json. A value that isn't valid
# stops the container, rather than serving links that lead nowhere.
set -eu

out=/tmp/md-runbook
public="${MD_RUNBOOK_PUBLIC_URL:-}"
library="${MD_RUNBOOK_LIBRARY:-/runbooks/}"

fail() {
    echo "$0: $*" >&2
    exit 1
}

public="${public%/}"
if [ -n "$public" ]; then
    case "$public" in
        https://?*) ;;
        http://localhost | http://localhost:* | http://127.0.0.1 | http://127.0.0.1:*) ;;
        *) fail "MD_RUNBOOK_PUBLIC_URL must be an https:// address (http:// only for localhost): $public" ;;
    esac
    # An address only: no query, fragment, user name, quotes or blanks (it goes into JSON as it is).
    if printf '%s' "$public" | grep -q '[^]A-Za-z0-9._~:/%[-]'; then
        fail "MD_RUNBOOK_PUBLIC_URL may contain letters, digits and . _ ~ : / % - [ ] only: $public"
    fi
fi

case "$library" in
    */) ;;
    *) library="$library/" ;;
esac
# A folder path on the app's origin: /runbooks/, /sop/, /teams/ops/; no .., no hidden folders.
if ! printf '%s' "$library" | grep -Eq '^/([A-Za-z0-9_~-][A-Za-z0-9._~-]*/)+$'; then
    fail "MD_RUNBOOK_LIBRARY must be a folder path such as /runbooks/ or /sop/: $library"
fi
# Not over the app's own pages and bundles.
case "$library" in
    /_expo/* | /runbook/* | /hosts/* | /assets/*) fail "MD_RUNBOOK_LIBRARY can't be one of the web app's own paths: $library" ;;
esac

mkdir -p "$out"
if [ -n "$public" ]; then
    printf '{"publicUrl":"%s","library":"%s"}\n' "$public" "$library" > "$out/config.json"
else
    printf '{"library":"%s"}\n' "$library" > "$out/config.json"
fi

# The library at another path: served from the folder of that name under the web root, with the
# same rules as /runbooks/ (nginx.conf includes /tmp/md-runbook/*.conf).
rm -f "$out/library.conf"
if [ "$library" != /runbooks/ ]; then
    printf 'location %s {\n    include /etc/nginx/md-runbook-library.conf;\n}\n' "$library" > "$out/library.conf"
fi

echo "$0: config.json: $(cat "$out/config.json")"
