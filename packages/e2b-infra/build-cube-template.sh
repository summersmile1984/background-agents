#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
image=${CUBE_IMAGE:-localhost:5000/oi-e2b:latest}
image_build_label=${CUBE_IMAGE_BUILD_LABEL:-}
template_alias=${CUBE_TEMPLATE_ALIAS:-oi-e2b-multi-harness}
writable_layer_size=${CUBE_WRITABLE_LAYER_SIZE:-4G}
dns_server=${CUBE_DNS_SERVER:-223.5.5.5}
template_cpu_millicores=${CUBE_TEMPLATE_CPU_MILLICORES:-4000}
template_memory_mb=${CUBE_TEMPLATE_MEMORY_MB:-8192}
build_dir=$(mktemp -d /tmp/open-inspect-cube-build.XXXXXX)

cleanup() {
  case "$build_dir" in
    /tmp/open-inspect-cube-build.*) rm -rf -- "$build_dir" ;;
    *) printf 'Refusing to remove unexpected build directory: %s\n' "$build_dir" >&2 ;;
  esac
}
trap cleanup EXIT

cp "$script_dir/cube.Dockerfile" "$build_dir/Dockerfile"
cp \
  "$script_dir/cube-entry.sh" \
  "$script_dir/cube-health-server.py" \
  "$script_dir/oi-launch.py" \
  "$build_dir/"
cp -R "$repo_root/packages/sandbox-runtime/src/sandbox_runtime" "$build_dir/sandbox_runtime"
find "$build_dir/sandbox_runtime" -type d -name __pycache__ -prune -exec rm -rf -- {} +
find "$build_dir/sandbox_runtime" -type f -name '*.pyc' -delete

# Cube imports one runnable image manifest. Disable BuildKit's provenance and
# SBOM attestations so the registry tag resolves to a single-architecture
# manifest instead of an OCI index with an auxiliary attestation manifest.
# The latter can restore successfully as a template but fail at sandbox create
# time with an opaque guest-clock/reset error on some Cube runtimes.
docker_build_args=(--pull --provenance=false --sbom=false -t "$image")
if [[ -n "$image_build_label" ]]; then
  docker_build_args+=(--label "org.openinspect.cube-build=$image_build_label")
fi
docker build "${docker_build_args[@]}" "$build_dir"
docker push "$image"
cubemastercli tpl create-from-image \
  --image "$image" \
  --alias "$template_alias" \
  --writable-layer-size "$writable_layer_size" \
  --dns "$dns_server" \
  --cpu "$template_cpu_millicores" \
  --memory "$template_memory_mb" \
  --expose-port 49999 \
  --expose-port 49983 \
  --expose-port 4173 \
  --probe 49999
