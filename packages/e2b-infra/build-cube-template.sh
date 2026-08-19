#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
image=${CUBE_IMAGE:-localhost:5000/oi-e2b:latest}
template_alias=${CUBE_TEMPLATE_ALIAS:-oi-e2b-multi-harness}
writable_layer_size=${CUBE_WRITABLE_LAYER_SIZE:-4G}
dns_server=${CUBE_DNS_SERVER:-119.29.29.29}
build_dir=$(mktemp -d /tmp/open-inspect-cube-build.XXXXXX)

cleanup() {
  case "$build_dir" in
    /tmp/open-inspect-cube-build.*) rm -rf -- "$build_dir" ;;
    *) printf 'Refusing to remove unexpected build directory: %s\n' "$build_dir" >&2 ;;
  esac
}
trap cleanup EXIT

cp "$script_dir/cube.Dockerfile" "$build_dir/Dockerfile"
cp "$script_dir/cube-entry.sh" "$script_dir/oi-launch.py" "$build_dir/"
cp -R "$repo_root/packages/sandbox-runtime/src/sandbox_runtime" "$build_dir/sandbox_runtime"
find "$build_dir/sandbox_runtime" -type d -name __pycache__ -prune -exec rm -rf -- {} +
find "$build_dir/sandbox_runtime" -type f -name '*.pyc' -delete

docker build --pull -t "$image" "$build_dir"
docker push "$image"
cubemastercli tpl create-from-image \
  --image "$image" \
  --alias "$template_alias" \
  --writable-layer-size "$writable_layer_size" \
  --dns "$dns_server" \
  --expose-port 49999 \
  --expose-port 49983 \
  --probe 49999
