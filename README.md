# apii

One Cloudflare Worker serving three hostnames:

| Host | What |
| --- | --- |
| `apii.uk` | Two centred links over a WebGL wireframe globe |
| `socials.apii.uk` | Plain text links: discord · github · spotify |
| `songs.apii.uk` | Server-rendered Last.fm listening page (`be_m`) |

No framework, no database, no analytics, no cookies, no client-side music JS.
The only JavaScript that ships is the globe (`public/assets/globe.js`).

## Layout

```
public/            static assets (served via the ASSETS binding)
  apii.html        globe page
  socials.html     links page
  assets/          style.css, globe.js
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

Public listening data only — no shared secret required.

- **Local:** the key lives in `.dev.vars` (gitignored) as:

  ```
  LASTFM_API_KEY=your_key_here
  ```

- **Production:** store it as a Worker secret:

  ```sh
  npx wrangler secret put LASTFM_API_KEY
  ```

The key is read from `env.LASTFM_API_KEY` and used only in server-side fetches.
It is never hardcoded, logged, or sent to the browser.

Recent listening + scrobble count are cached ~60s; all-time rankings ~1h.

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
