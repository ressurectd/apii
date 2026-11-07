# apii

One Cloudflare Worker serving three hostnames:

| Host | What |
| --- | --- |
| `apii.uk` | Two centred links over a WebGL wireframe globe |
| `socials.apii.uk` | Plain text links: discord · github · spotify |
| `songs.apii.uk` | Server-rendered Last.fm dashboard (`be_m`) |

Every subdomain exposes an RSS feed at `/rss` (and `/feed.xml`): apii.uk lists its
two destinations, socials lists the account links, songs serves recent scrobbles.

No framework, no database, no analytics, no cookies. Two small scripts ship:
the WebGL globe (`public/assets/globe.js`) and a ~1 KB poller
(`public/assets/now.js`) that live-refreshes the now-playing block on
`songs.apii.uk` every 20s via `/now.json` — progressive enhancement over the
fully server-rendered page.

## Layout

```
public/            static assets (served via the ASSETS binding)
  apii.html        globe page
  socials.html     links page
  assets/          style.css, globe.js, now.js
  fonts/           Redaction 35 + Libre Barcode 39 Text (self-hosted, OFL)
src/index.js       Worker: hostname routing + songs server-render
wrangler.toml      config (assets binding, three custom-domain routes)
```

Fonts are self-hosted under the SIL Open Font License; the license texts sit
alongside the `.woff2` files in `public/fonts/`.

## Local development

```sh
npm install
npm run dev          # wrangler dev — http://localhost:8787
```

`wrangler dev` serves a single host, so preview each site with a query param:

- `http://localhost:8787/`            → apii.uk (globe)
- `http://localhost:8787/?site=socials`
- `http://localhost:8787/?site=songs`

In production the site is chosen by hostname and `?site=` is ignored.

## Last.fm API key

The key lives in `src/index.js` as `LASTFM_API_KEY` and is used only in
server-side fetches — never sent to the browser.

Recent listening + scrobble count are cached ~60s; all-time rankings ~1h.

`songs.apii.uk/rss` (also `/feed.xml`) serves an RSS 2.0 feed of recent scrobbles.

## Deploy

```sh
npm run deploy       # wrangler deploy
```

The three `custom_domain` routes in `wrangler.toml` require the `apii.uk` zone
to be on your Cloudflare account; Wrangler provisions the hostnames on deploy.

## Git

Repository lives under the `ressurectd` GitHub account. `.dev.vars`, `.env` and
any credentials are gitignored and must never be committed.
```sh
git add -A && git commit -m "…"
git push
```
