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

# The bind mount is created as root on a new host. The server and its nightly
# refresh run as the unprivileged node user after ownership has been corrected.
chown -R node:node /data /opt/kz-tools /opt/steamcmd

exec gosu node "$@"

