# UKR WIRE — Ukraine war news

A single-page site that lists Ukraine war headlines from the past 24 hours,
newest first, aggregated from Google News RSS.

Live at <https://yurijkos.github.io/ukraine-news/>

## Why the page no longer calls the RSS feed directly

`news.google.com` responds to RSS requests **without** an
`Access-Control-Allow-Origin` header, so JavaScript running on the page cannot
read it. The previous version worked around this with the third-party proxy
`api.rss2json.com`. That service now answers unauthenticated requests with
`HTTP 403` plus a Cloudflare challenge, which is why the page sat on
"Loading latest headlines…" and showed no articles.

There is no reliable free, key-less CORS proxy left (checked `allorigins`,
`corsproxy.io`, `r.jina.ai`, `codetabs` — all failing, key-gated or rate-limited).
GDELT's API also returns `429` and sends no CORS header.

So the feed is now fetched **server-side** by a GitHub Actions job, which writes
`news.json` into the repo. The page reads its own same-origin `news.json`, so
there is no proxy, no API key, and no CORS dependency.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The page. Fetches `news.json`, renders cards, filter + refresh. |
| `scripts/fetch-news.mjs` | Node script: fetch RSS → parse → write `news.json`. |
| `news.json` | Generated data (committed so Pages can serve it). |
| `.github/workflows/update-news.yml` | Runs the script every 30 min and commits the result. |

## Running the updater locally

```sh
node scripts/fetch-news.mjs
```

Options: `--out <path>` (default `news.json`), `--max <n>` (default 60),
`--hours <n>` (default 24). Exits non-zero and leaves the previous file in place
if the feed fails or returns nothing.

## Preview locally

`index.html` fetches `news.json` over HTTP, so `file://` will not work. Serve the
folder:

```sh
npx serve .
# or: python -m http.server 8080
```

## If the headline list goes stale

The page warns when `news.json` is older than 6 hours. Check the **Actions** tab
for a failed `Update headlines` run. Note that GitHub disables scheduled
workflows on a repository after 60 days of no activity; re-enable it from the
Actions tab.
