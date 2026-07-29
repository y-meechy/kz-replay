#!/bin/sh
set -eu

seed_directory() {
  source_dir=$1
  target_dir=$2

  if [ ! -e "$target_dir" ]; then
    mkdir -p "$target_dir"
    cp -a "$source_dir/." "$target_dir/"
  fi
}

mkdir -p /data
seed_directory /opt/kz-seed/data "$KZ_DATA_DIR"
seed_directory /opt/kz-seed/maps "$KZ_MAPS_DIR"

# The CT character. Nothing to seed: it is in no image, because it is borrowed out of
# CS2 rather than built from the repository. The server writes it here on the first
# start that finds it missing, and it survives every deploy after that.
mkdir -p "${KZ_MODELS_DIR:-/data/models}"

# View counts. Nothing to seed: an empty counter is the correct starting point, and
# the bundled files must never overwrite what visitors wrote.
mkdir -p "${KZ_STATE_DIR:-/data/state}"

# Base game assets borrowed out of CS2 for the maps' real skies. Nothing to seed: the
# conversion fetches what it needs and caches it here, and a part is ~105 MB, so it must
# survive a deploy rather than be rebuilt into every image.
mkdir -p "${KZ_CS2_DIR:-/data/cs2}"

# The bind mount is created as root on a new host. The server and its nightly
# refresh run as the unprivileged node user after ownership has been corrected.
chown -R node:node /data /opt/kz-tools /opt/steamcmd

exec gosu node "$@"

