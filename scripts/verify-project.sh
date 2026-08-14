#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node --experimental-vm-modules scripts/check-inline-js.cjs
node --check aitimata/sw.js
node --check entoles/sw.js
jq empty aitimata/manifest.json entoles/manifest.json
git diff --check

if rg -n 'kwsbhdhkswjjfzbnxysz|rodios-v9-20-test|supabase_atomic_sequences' \
  aitimata entoles config.js index.html supabase/functions supabase/migrations; then
  echo 'Βρέθηκε παλιό production identifier σε deployable αρχείο.' >&2
  exit 1
fi

if rg -n 'sb_secret_|postgres(ql)?://|eyJ[A-Za-z0-9_-]{20,}\.' \
  aitimata entoles config.js index.html; then
  echo 'Βρέθηκε πιθανό μυστικό σε στατικό/browser αρχείο.' >&2
  exit 1
fi

for file in supabase/export-readonly/*.sql; do
  clean="$(sed '/^[[:space:]]*--/d' "$file")"
  if printf '%s' "$clean" | rg -ni '\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|copy|merge)\b|\bdo[[:space:]]+\$'; then
    echo "Το $file δεν πέρασε τον έλεγχο μόνο-ανάγνωσης." >&2
    exit 1
  fi
done

test "$(rg -o 'PASTE_THE_EXPORTED_JSON_HERE' supabase/bootstrap/01_import_reference_data.sql | wc -l)" -eq 1

echo 'Project verification: OK'
