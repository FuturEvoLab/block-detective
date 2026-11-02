# Third-party notices

Block Detective itself is licensed under the GNU AGPL-3.0 (see [LICENSE](LICENSE)). It bundles the following third-party components, which keep their own licenses.

## Cytoscape.js 3.30.2 — MIT License

Files: `static/vendor/cytoscape.min.js` (the app) and `docs/vendor/cytoscape.min.js` (the online demo); the full license notice is also kept at the top of each file.

```
Copyright (c) 2016-2024, The Cytoscape Consortium.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts — SIL Open Font License 1.1

Files in `static/fonts/` (the app) and `docs/fonts/` (the online demo) — identical Latin subsets in WOFF2 format, as distributed by Google Fonts. They are licensed under the SIL Open Font License, Version 1.1; the full text is in [licenses/OFL-1.1.txt](licenses/OFL-1.1.txt).

Copyright notices, reproduced exactly from each font's official `OFL.txt` (https://github.com/google/fonts/tree/main/ofl):

| Font | Files | Copyright notice |
|---|---|---|
| Inter | `Inter-0.woff2` | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) |
| JetBrains Mono | `JetBrainsMono-1.woff2` | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Orbitron | `Orbitron-2.woff2` | Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron), with Reserved Font Name: "Orbitron" |
| Rajdhani | `Rajdhani-3.woff2`, `Rajdhani-4.woff2`, `Rajdhani-5.woff2` | Copyright (c) 2014, Indian Type Foundry (info@indiantypefoundry.com). |

The font files are redistributed unmodified, exactly as served by Google Fonts. "Orbitron" is a Reserved Font Name: if you modify that font file, the modified version must not be called "Orbitron".

## Data sources

No third-party data is redistributed in this repository, apart from the sample case data in `docs/demo-data.json` that the online demo displays. At run time the tool fetches public data from Etherscan V2, Blockscout, TronGrid, mempool.space, CoinGecko, DexScreener, GeckoTerminal, GoPlus, Binance, DefiLlama and alternative.me, and links to block explorers such as Etherscan, Tronscan and mempool.space. Each of these is subject to its provider's own terms of use. You are responsible for complying with them.
