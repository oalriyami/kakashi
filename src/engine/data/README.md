# Name data

Read by [`../names.js`](../names.js) to tell names from other words (issue #12).
Nothing here is fetched at run time.

| File | What | Source and licence |
|---|---|---|
| `names-wikidata.json.br` | About 49,000 given names and 69,000 family names in Latin and Arabic script, normalised, brotli-compressed; plus about 1,800 names that are also everyday English words | Built by `npm run names:build` ([`scripts/build-name-list.js`](../../../scripts/build-name-list.js)) from [`wikidata-names@1.0.0`](https://www.npmjs.com/package/wikidata-names): data from [Wikidata](https://www.wikidata.org), [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The everyday-word flags come from [`subtlex-word-frequencies@2.0.0`](https://www.npmjs.com/package/subtlex-word-frequencies) (SUBTLEX-US), licence below. |
| `names-supplement.json` | Hand-kept regional names Wikidata lacks (Gulf, South Asian, Filipino), Gulf family names, Arabic names that are also everyday words, and words never to treat as names | Part of Kakashi, MIT. Edit freely; no rebuild needed. |

## subtlex-word-frequencies licence

```
ISC License

Copyright (c) 2015 Zeke Sikelianos <zeke@sikelianos.com>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
