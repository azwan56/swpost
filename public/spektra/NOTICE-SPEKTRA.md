# SpektraLab / spektrafilm Attribution & License Notice

This directory contains prebuilt WebAssembly engine binaries, constants, and spectral film/paper profiles integrated into the darkroom module (`src/spektra/`).

## Licenses & Upstream Attribution

- **SpektraLab Engine & App (`JamesQiu2005/SpektraLab`)**
  - Author: Hanze Qiu (`JamesQiu2005`) and contributors
  - License: **GPL-3.0-or-later**
  - Repository: https://github.com/JamesQiu2005/SpektraLab

- **spektrafilm Spectral Analog Simulation (`andreavolpato/spektrafilm`)**
  - Author: Andrea Volpato
  - Code License: **GPL-3.0-or-later**
  - 28 Upstream Film & Paper Profiles: **CC BY-SA 4.0** (measured spectral data, unmodified numerical curves)
  - Repository: https://github.com/andreavolpato/spektrafilm

- **spektra-web Browser WASM Build (`cut-hand/spektra-web`)**
  - Browser WASM port (`vendor/core.mjs`, `vendor/core.wasm`, `vendor/spektrafilm_constants.bin`, `vendor/neutral_print_filters.json`, `stock-catalog.json`, `profiles/*.json`)
  - License: **GPL-3.0-or-later**
  - Repository: https://github.com/cut-hand/spektra-web

- **6 Product Profiles (`cinestill_800t`, `fujifilm_neopan_acros_100_ii`, `ilford_hp5_plus_400`, `ilford_multigrade_iv_rc`, `kodak_tmax_100`, `kodak_tri_x_400`)**
  - Derived/authored in `JamesQiu2005/SpektraLab` from manufacturer datasheets (`cinestill_800t` aliases `kodak_vision3_500t` with `antihalation: "no"`).
