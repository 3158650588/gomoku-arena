#!/usr/bin/env bash
# Browser build of unmodified Rapfi with upstream's own CMake Emscripten target.
# Fetches the pinned Rapfi, its Networks submodule and Emscripten into build/,
# then writes the three release files and SHA256SUMS to dist/.
# Needs git, cmake and python3.
set -euo pipefail

RAPFI=1387d11312190ec66665d361ff07a7c70221b78a
NETWORKS=7eeb19b55219a48138756293f92211a1539bab4d
EMSDK=6.0.13

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work="$root/build"
dist="$root/dist"
mkdir -p "$work" "$dist"

[ -d "$work/rapfi" ] || git clone -q https://github.com/dhbloo/rapfi "$work/rapfi"
git -C "$work/rapfi" checkout -q "$RAPFI"
git -C "$work/rapfi" submodule update -q --init Networks
git -C "$work/rapfi/Networks" checkout -q "$NETWORKS"

[ -d "$work/emsdk" ] || git clone -q https://github.com/emscripten-core/emsdk "$work/emsdk"
"$work/emsdk/emsdk" install "$EMSDK" >/dev/null
"$work/emsdk/emsdk" activate "$EMSDK" >/dev/null
set +u; source "$work/emsdk/emsdk_env.sh" >/dev/null 2>&1; set -u

out="$work/wasm-single-simd128"
emcmake cmake -S "$work/rapfi/Rapfi" -B "$out" -DCMAKE_BUILD_TYPE=Release \
  -DNO_MULTI_THREADING=ON -DNO_COMMAND_MODULES=ON -DUSE_WASM_SIMD=ON
cmake --build "$out" -j

cp "$out"/rapfi-single-simd128.{js,wasm,data} "$dist/"
(cd "$dist" && shasum -a 256 rapfi-single-simd128.{js,wasm,data} > SHA256SUMS)
cat "$dist/SHA256SUMS"
