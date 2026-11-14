#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  printf 'Aufruf: %s SEPARATER_HABEN_KLON VOLLSTAENDIGER_COMMIT\n' "$0" >&2
  exit 2
fi

candidate=$(realpath -e -- "$1")
commit=$2
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Ein vollständiger Git-Commit aus 40 Kleinbuchstaben/Ziffern ist erforderlich.\n' >&2
  exit 2
fi
root=$(git -C "$candidate" rev-parse --show-toplevel)
if [ "$(realpath -e -- "$root")" != "$candidate" ]; then
  printf 'Der Zielpfad muss die Wurzel eines separaten Klons sein.\n' >&2
  exit 2
fi
case "$candidate/" in
  "$(realpath -e -- "$(dirname -- "$0")/../../..")/"*)
    printf 'Der Update-Kandidat muss außerhalb des Video-Maker-Quellbaums liegen.\n' >&2
    exit 2
    ;;
esac
origin=$(git -C "$candidate" remote get-url origin)
case "$origin" in
  https://github.com/firsttris/haben|https://github.com/firsttris/haben.git|git@github.com:firsttris/haben.git) ;;
  *) printf 'Der Klon hat keinen erwarteten Haben-Upstream als origin.\n' >&2; exit 2 ;;
esac
if [ "$(git -C "$candidate" rev-parse HEAD)" != "$commit" ] || [ -n "$(git -C "$candidate" status --porcelain)" ]; then
  printf 'Der Klon muss sauber sein und auf dem angegebenen Commit stehen.\n' >&2
  exit 2
fi

patch_dir=$(realpath -e -- "$(dirname -- "$0")/patches")
for patch in "$patch_dir"/*.patch; do
  git -C "$candidate" apply --check "$patch"
  git -C "$candidate" apply "$patch"
done
printf 'Update-Kandidat vorbereitet: %s\nPrüfung und Übernahme sind noch erforderlich.\n' "$candidate"
