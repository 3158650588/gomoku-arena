# Rapfi third-party source

The unmodified Rapfi WebAssembly loader, binary and model bundle in `public/rapfi/` (or `dist/rapfi/` in the playable package) are from [rapfi-wasm v0.1.0](https://github.com/brianhliou/rapfi-wasm/releases/tag/v0.1.0). See the accompanying `LICENSE.txt`, `AUTHORS.txt` and `NETWORKS-LICENSE.txt` in that directory. The JavaScript worker named `worker.js` belongs to this game and communicates with Rapfi through its Gomocup text protocol.

- `rapfi-source.zip` is the [matching Rapfi source snapshot](https://github.com/dotb1ue/rapfi/tree/1387d11312190ec66665d361ff07a7c70221b78a), commit `1387d11312190ec66665d361ff07a7c70221b78a`.
- `build.sh` is the [upstream build script](https://github.com/brianhliou/rapfi-wasm/blob/87b34f2f3e4e6cd20f7577046006377ef4afc9b9/build.sh). It retrieves the pinned Rapfi source, [networks at commit 7eeb19b](https://github.com/dhbloo/rapfi-networks/tree/7eeb19b55219a48138756293f92211a1539bab4d) and Emscripten 6.0.13, and writes the three release files. The `.data` bundle also contains the original network and configuration files. The manifest with byte offsets is embedded in the vendor loader.

| Release asset | SHA-256 |
| --- | --- |
| rapfi-single-simd128.js | d0987108ee8cb1133b9624a789130fddb5f9ff0747dca9ee8a2b027985986592 |
| rapfi-single-simd128.wasm | 6d07362503d344c01734c98640f66a2d599dfe6cb6f7df76b70f1426d9cb3bcf |
| rapfi-single-simd128.data | f61d31b4d98fc53fb43a31a4f0b4357a8b64053bb5762a0967250b873cc9a57e |

## Windows arena engine

`native/` contains the unmodified Windows AVX2 and SSE binaries, freestyle model, default config and original authors list from the [official 250615 release](https://github.com/dotb1ue/rapfi/releases/tag/250615). The upstream engine archive SHA-256 is `1a3e24024062a153ac079060ee9589a37c6bdd1ecc54fed3908793c519594e05`. The launcher sets the thread count and turn budget using the engine's Gomocup protocol.

- Matching source at commit `1be1551ced57e38d53ed58f6d74bf6f8b4bdc230` is included as `rapfi-250615-source.tar.gz`. The archive includes the upstream CMake presets. The license is included at `native/Copying.txt`.
- The AVX2 binary SHA-256 is `1e02497433fb765626f954c895b0b92e057ac12a76c76318abe74d4050914e8e`.
- The SSE binary SHA-256 is `dc98082d74e862547fd7f45130399782f21f6023ae15676a2ad471ecd1daca4c`.
