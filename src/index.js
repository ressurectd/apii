/* ------------------------------------------------------------------ *
 *  One Worker, three hostnames.
 *    apii.uk          -> static globe page
 *    socials.apii.uk  -> static links page
 *    songs.apii.uk    -> server-rendered Last.fm listening page
 *
 *  Static assets (fonts, css, globe, html) are served from the ASSETS
 *  binding. The songs page is rendered here from the Last.fm API using
 *  LASTFM_API_KEY (from .dev.vars locally / a secret in production).
 * ------------------------------------------------------------------ */

const LASTFM_USER = "be_m";
const API = "https://ws.audioscrobbler.com/2.0/";

const LASTFM_API_KEY = "b2fd6b9b255b713fb9823aadd3d3955b";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Static files always pass straight through to the assets binding.
    if (path.startsWith("/assets/") || path.startsWith("/fonts/")) {
      return env.ASSETS.fetch(request);
    }
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    const site = resolveSite(url, env);

    if (site === "songs") {
      return renderSongs(ctx);
    }

    // apii + socials are static documents in ./public
    const file = site === "socials" ? "/socials.html" : "/apii.html";
    return env.ASSETS.fetch(new Request(new URL(file, url), request));
  },
};

/* Which of the three sites is this request for? Hostname decides in
   production. In `wrangler dev` the host is forced to apii.uk, so a
   ?site= override (enabled only by the dev-only DEV var) previews each. */
function resolveSite(url, env) {
  const host = url.hostname;
  if (host.startsWith("songs.")) return "songs";
  if (host.startsWith("socials.")) return "socials";

  if (env && env.DEV) {
    const q = url.searchParams.get("site");
    if (q === "songs" || q === "socials" || q === "apii") return q;
  }
  return "apii";
}

/* ------------------------------------------------------------------ *
 *  Last.fm
 * ------------------------------------------------------------------ */

function endpoint(method, key, extra) {
  const p = new URLSearchParams({
    method,
    user: LASTFM_USER,
    api_key: key,
    format: "json",
  });
  if (extra) for (const k in extra) p.set(k, extra[k]);
  return API + "?" + p.toString();
}

// Fetch + parse JSON with an edge-cache layer (best effort). ttl in seconds.
async function fetchLastfm(url, ttl, ctx) {
  let cache = null;
  let cacheKey = null;
  try {
    cache = caches.default;
    cacheKey = new Request(url, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();
  } catch (_) {
    cache = null; // caches.default unavailable (e.g. some local setups)
  }

  // One retry smooths over the occasional transient blip / rate-limit.
  let body;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "apii.uk (+https://apii.uk)" },
        cf: { cacheTtl: ttl, cacheEverything: true },
      });
      if (!res.ok) throw new Error("lastfm http " + res.status);
      body = await res.text();
      break;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (body == null) throw lastErr || new Error("lastfm fetch failed");

  const data = JSON.parse(body);
  if (data && data.error) throw new Error("lastfm " + data.error);

  if (cache && cacheKey) {
    const stored = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, s-maxage=" + ttl,
      },
    });
    try {
      ctx.waitUntil(cache.put(cacheKey, stored));
    } catch (_) { /* ignore */ }
  }
  return data;
}

async function renderSongs(ctx) {
  const key = LASTFM_API_KEY;

  const RECENT_TTL = 60; // now-playing + recent
  const INFO_TTL = 60; // scrobble total
  const RANK_TTL = 3600; // all-time rankings change slowly

  const [recent, info, artists, tracks, albums] = await Promise.allSettled([
    fetchLastfm(endpoint("user.getRecentTracks", key, { limit: "5" }), RECENT_TTL, ctx),
    fetchLastfm(endpoint("user.getInfo", key), INFO_TTL, ctx),
    fetchLastfm(endpoint("user.getTopArtists", key, { limit: "5" }), RANK_TTL, ctx),
    fetchLastfm(endpoint("user.getTopTracks", key, { limit: "5" }), RANK_TTL, ctx),
    fetchLastfm(endpoint("user.getTopAlbums", key, { limit: "5" }), RANK_TTL, ctx),
  ]);

  const model = {
    listening: parseRecent(val(recent)),
    scrobbles: parseScrobbles(val(info)),
    artists: parseTop(val(artists), "artist", "topartists"),
    tracks: parseTop(val(tracks), "track", "toptracks"),
    albums: parseTop(val(albums), "album", "topalbums"),
  };

  // Only declare the whole page "unavailable" when nothing at all loaded —
  // otherwise render every section that did come back.
  model.error =
    !model.listening &&
    model.scrobbles == null &&
    !model.artists.length &&
    !model.tracks.length &&
    !model.albums.length;

  if (model.error) {
    // key is present but every call failed — note the first reason (invisible)
    const first = [recent, info, artists, tracks, albums].find(
      (s) => s.status === "rejected"
    );
    model.reason = "api-" + (first && first.reason ? String(first.reason.message || first.reason) : "fail");
  }

  return htmlResponse(songsPage(model), 200);
}

function val(settled) {
  return settled && settled.status === "fulfilled" ? settled.value : null;
}

/* ---- parsing (Last.fm shapes are inconsistent: objects vs arrays) --- */
function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function parseRecent(data) {
  const tracks = asArray(data && data.recenttracks && data.recenttracks.track);
  if (!tracks.length) return null;

  const mapped = tracks.map((t) => ({
    name: text(t.name),
    artist: text(t.artist && (t.artist["#text"] || t.artist.name)),
    album: text(t.album && (t.album["#text"] || t.album.name)),
    nowplaying: !!(t["@attr"] && t["@attr"].nowplaying === "true"),
  }));

  const nowOn = !!(mapped[0] && mapped[0].nowplaying);
  const current = mapped[0] || null;
  // The two tracks preceding the shown entry (index 0), either way.
  const previous = mapped.slice(1, 3);

  return { current, nowplaying: nowOn, previous };
}

function parseScrobbles(data) {
  const n = data && data.user && data.user.playcount;
  const num = n != null ? parseInt(n, 10) : NaN;
  return Number.isFinite(num) ? num : null;
}

function parseTop(data, itemKey, rootKey) {
  const root = data && data[rootKey];
  const items = asArray(root && root[itemKey]);
  return items
    .map((it) => ({
      name: text(it.name),
      artist: text(it.artist && (it.artist.name || it.artist["#text"])),
      count: parseInt(it.playcount, 10) || 0,
    }))
    .filter((it) => it.name);
}

/* ------------------------------------------------------------------ *
 *  HTML
 * ------------------------------------------------------------------ */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function text(s) {
  return (s == null ? "" : String(s)).trim();
}
function fmt(n) {
  return n == null ? "" : n.toLocaleString("en-GB");
}

function nowBlock(listening) {
  if (!listening || !listening.current) {
    return '<p class="err">nothing to show.</p>';
  }
  const c = listening.current;
  const playing = listening.nowplaying;
  const state = playing
    ? '<span class="state pulse">listening now</span>'
    : '<span class="state">last played</span>';
  const album = c.album
    ? '<span class="album">' + esc(c.album) + "</span>"
    : "";
  return (
    state +
    '<p class="now">' +
    esc(c.name || "—") +
    '<br><span class="artist">' +
    esc(c.artist || "") +
    "</span>" +
    album +
    "</p>"
  );
}

function previousBlock(listening) {
  const prev = (listening && listening.previous) || [];
  if (!prev.length) return "";
  const items = prev
    .map(
      (t) =>
        '<li><span class="name">' +
        esc(t.name) +
        " <small>" +
        esc(t.artist) +
        "</small></span></li>"
    )
    .join("");
  return (
    "<section><h2>previous</h2><ul class=\"ranks\">" + items + "</ul></section>"
  );
}

function rankList(items, withArtist) {
  if (!items || !items.length) return '<p class="err">—</p>';
  return (
    '<ul class="ranks">' +
    items
      .map(
        (it) =>
          '<li><span class="name">' +
          esc(it.name) +
          (withArtist && it.artist ? " <small>" + esc(it.artist) + "</small>" : "") +
          '</span><span class="count">' +
          fmt(it.count) +
          "</span></li>"
      )
      .join("") +
    "</ul>"
  );
}

function barChart(items) {
  if (!items || !items.length) return '<p class="err">—</p>';
  const max = items.reduce((m, it) => Math.max(m, it.count), 0) || 1;
  return (
    '<ul class="chart">' +
    items
      .map((it) => {
        const pct = Math.max(3, Math.round((it.count / max) * 100));
        return (
          "<li><div class=\"row\"><span class=\"name\">" +
          esc(it.name) +
          '</span><span class="count">' +
          fmt(it.count) +
          '</span></div><span class="bar" style="width:' +
          pct +
          '%"></span></li>'
        );
      })
      .join("") +
    "</ul>"
  );
}

function songsPage(model) {
  // Invisible marker so the failure mode can be diagnosed from the live page.
  const diag = model.error ? "\n<!-- songs:" + (model.reason || "error") + " -->" : "";
  const body =
    model.error
      ? '<p class="err">last.fm is unavailable right now. refresh in a moment.</p>'
      : [
          "<section>" + nowBlock(model.listening) +
            (model.scrobbles != null
              ? '<p class="scrobbles"><b>' + fmt(model.scrobbles) + "</b> scrobbles</p>"
              : "") +
            "</section>",
          previousBlock(model.listening),
          "<section><h2>artists</h2>" + barChart(model.artists) + "</section>",
          "<section><h2>tracks</h2>" + rankList(model.tracks, true) + "</section>",
          "<section><h2>albums</h2>" + rankList(model.albums, true) + "</section>",
        ].join("");

  return (
    "<!doctype html>" + diag + "\n" +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>songs — apii</title>" +
    '<meta name="description" content="what i\'m listening to">' +
    '<meta name="color-scheme" content="dark">' +
    '<link rel="preload" href="/fonts/redaction-35-400.woff2" as="font" type="font/woff2" crossorigin>' +
    '<link rel="stylesheet" href="/assets/style.css">' +
    "</head><body class=\"songs\">" +
    '<main class="sheet"><div class="column">' +
    body +
    '<p class="foot"><a href="https://apii.uk" aria-label="home"><span class="mark">api.i</span></a></p>' +
    "</div></main></body></html>"
  );
}

function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // let the edge hold the rendered page briefly; refreshing updates it
      "Cache-Control": "public, max-age=0, s-maxage=30",
    },
  });
}
