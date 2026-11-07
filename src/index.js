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
const PROFILE_URL = "https://www.last.fm/user/be_m";
const IMG_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"; // Last.fm "no art" star

const SOCIALS = [
  { name: "discord", url: "https://discord.com/users/1562529389906886719" },
  { name: "github", url: "https://github.com/ressurectd" },
  { name: "spotify", url: "https://open.spotify.com/user/yv4if8jl1tqqh05i8an54k9th" },
];

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

    // Each subdomain exposes its own RSS feed.
    if (path === "/rss" || path === "/feed.xml") {
      if (site === "songs") return songsFeed(ctx);
      if (site === "socials") return socialsFeed();
      return apiiFeed();
    }

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

/* ------------------------------------------------------------------ *
 *  RSS — one feed per subdomain
 * ------------------------------------------------------------------ */
function rssItem(it) {
  return (
    "<item>" +
    "<title>" + esc(it.title) + "</title>" +
    (it.link ? "<link>" + esc(it.link) + "</link>" : "") +
    (it.link ? '<guid isPermaLink="true">' + esc(it.link) + "</guid>" : "") +
    (it.description ? "<description>" + esc(it.description) + "</description>" : "") +
    (it.date ? "<pubDate>" + it.date + "</pubDate>" : "") +
    "</item>"
  );
}

function rssResponse(ch, items, ttl) {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
    "<title>" + esc(ch.title) + "</title>" +
    "<link>" + esc(ch.link) + "</link>" +
    "<description>" + esc(ch.description) + "</description>" +
    '<atom:link href="' + esc(ch.link) + '/rss" rel="self" type="application/rss+xml"/>' +
    items.map(rssItem).join("") +
    "</channel></rss>";
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=" + (ttl || 300),
    },
  });
}

// songs.apii.uk/rss — recent scrobbles (dynamic).
async function songsFeed(ctx) {
  let tracks = [];
  try {
    const data = await fetchLastfm(
      endpoint("user.getRecentTracks", LASTFM_API_KEY, { limit: "25" }),
      60,
      ctx
    );
    tracks = asArray(data && data.recenttracks && data.recenttracks.track).map((t) => ({
      name: text(t.name),
      artist: text(t.artist && (t.artist["#text"] || t.artist.name)),
      album: text(t.album && (t.album["#text"] || t.album.name)),
      url: text(t.url),
      nowplaying: !!(t["@attr"] && t["@attr"].nowplaying === "true"),
      uts: t.date && t.date.uts ? parseInt(t.date.uts, 10) : null,
    }));
  } catch (_) {
    tracks = [];
  }

  const items = tracks
    .filter((t) => !t.nowplaying) // only settled scrobbles get a feed entry
    .map((t) => ({
      title: t.name + " — " + t.artist,
      link: t.url,
      description: t.album ? "from " + t.album : t.artist,
      date: t.uts ? new Date(t.uts * 1000).toUTCString() : "",
    }));

  return rssResponse(
    {
      title: LASTFM_USER + " — recent scrobbles",
      link: "https://songs.apii.uk",
      description: "What " + LASTFM_USER + " has been listening to, via Last.fm.",
    },
    items,
    60
  );
}

// apii.uk/rss — the two destinations (static).
function apiiFeed() {
  return rssResponse(
    {
      title: "apii",
      link: "https://apii.uk",
      description: "apii.uk",
    },
    [
      { title: "accounts", link: "https://socials.apii.uk", description: "discord · github · spotify" },
      { title: "songs", link: "https://songs.apii.uk", description: "what i'm listening to" },
    ]
  );
}

// socials.apii.uk/rss — the account links (static).
function socialsFeed() {
  return rssResponse(
    {
      title: "apii — accounts",
      link: "https://socials.apii.uk",
      description: "Where to find me.",
    },
    SOCIALS.map((s) => ({ title: s.name, link: s.url, description: s.name }))
  );
}

function val(settled) {
  return settled && settled.status === "fulfilled" ? settled.value : null;
}

/* ---- parsing (Last.fm shapes are inconsistent: objects vs arrays) --- */
function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

// Largest usable image from a Last.fm image[] (ignores the "no art" star).
function pickImage(images) {
  let best = "";
  for (const im of asArray(images)) {
    const u = im && text(im["#text"]);
    if (u) best = u; // array runs small -> extralarge, so keep the last
  }
  return best && best.indexOf(IMG_PLACEHOLDER) === -1 ? best : "";
}

function parseRecent(data) {
  const tracks = asArray(data && data.recenttracks && data.recenttracks.track);
  if (!tracks.length) return null;

  const mapped = tracks.map((t) => ({
    name: text(t.name),
    artist: text(t.artist && (t.artist["#text"] || t.artist.name)),
    album: text(t.album && (t.album["#text"] || t.album.name)),
    url: text(t.url),
    cover: pickImage(t.image),
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
      url: text(it.url),
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

// Wrap text in a Last.fm link when a url is present, else a plain span.
function link(url, inner, cls) {
  const c = cls ? ' class="' + cls + '"' : "";
  return url
    ? '<a' + c + ' href="' + esc(url) + '" rel="noopener">' + inner + "</a>"
    : "<span" + c + ">" + inner + "</span>";
}

function coverImg(listening) {
  const c = listening && listening.current;
  if (!c || !c.cover) return "";
  const alt = c.album ? c.album + " cover" : "album cover";
  return (
    '<a class="cover" href="' + esc(c.url || PROFILE_URL) + '" rel="noopener">' +
    '<img src="' + esc(c.cover) + '" alt="' + esc(alt) + '" loading="lazy" width="300" height="300">' +
    "</a>"
  );
}

function nowBlock(listening) {
  if (!listening || !listening.current) {
    return '<p class="err">nothing to show.</p>';
  }
  const c = listening.current;
  const eq = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
  const state = listening.nowplaying
    ? '<span class="state pulse">listening now ' + eq + "</span>"
    : '<span class="state">last played</span>';
  const title = link(c.url, esc(c.name || "—"));
  const album = c.album ? '<span class="album">' + esc(c.album) + "</span>" : "";
  return (
    state +
    '<p class="now">' +
    title +
    '<span class="artist">' +
    esc(c.artist || "") +
    "</span>" +
    album +
    "</p>"
  );
}

function previousList(listening) {
  const prev = (listening && listening.previous) || [];
  if (!prev.length) return '<p class="err">—</p>';
  return (
    '<ul class="ranks">' +
    prev
      .map(
        (t) =>
          "<li>" +
          link(t.url, esc(t.name) + " <small>" + esc(t.artist) + "</small>", "name") +
          "</li>"
      )
      .join("") +
    "</ul>"
  );
}

function rankList(items, withArtist) {
  if (!items || !items.length) return '<p class="err">—</p>';
  return (
    '<ul class="ranks">' +
    items
      .map(
        (it) =>
          "<li>" +
          link(
            it.url,
            esc(it.name) +
              (withArtist && it.artist ? " <small>" + esc(it.artist) + "</small>" : ""),
            "name"
          ) +
          '<span class="count">' +
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
          '<li><div class="row">' +
          link(it.url, esc(it.name), "name") +
          '<span class="count">' +
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

  const scrobbles =
    model.scrobbles != null
      ? '<p class="scrobbles"><b>' + fmt(model.scrobbles) + "</b> scrobbles</p>"
      : "";
  const profile =
    '<span class="links">' +
    '<a class="profile" href="' + PROFILE_URL + '" rel="me noopener">' +
    LASTFM_USER + " on last.fm</a>" +
    '<a class="profile feed" href="/rss">rss</a>' +
    "</span>";

  const body = model.error
    ? '<div class="dash dash-error"><p class="err">last.fm is unavailable right now. refresh in a moment.</p></div>'
    : '<main class="dash">' +
      '<header class="top">' +
      coverImg(model.listening) +
      '<div class="nowtext">' + nowBlock(model.listening) + "</div>" +
      '<div class="meta">' + scrobbles + profile + "</div>" +
      "</header>" +
      '<section class="col col-artists"><h2>artists</h2>' + barChart(model.artists) + "</section>" +
      '<section class="col col-tracks"><h2>tracks</h2>' + rankList(model.tracks, true) + "</section>" +
      '<section class="col col-albums"><h2>albums</h2>' + rankList(model.albums, true) + "</section>" +
      '<footer class="bottom">' +
      '<section class="prev"><h2>previous</h2>' + previousList(model.listening) + "</section>" +
      '<a class="back" href="https://apii.uk" aria-label="home"><span class="mark">api.i</span></a>' +
      "</footer>" +
      "</main>";

  return (
    "<!doctype html>" + diag + "\n" +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>songs — apii</title>" +
    '<meta name="description" content="what i\'m listening to">' +
    '<meta name="color-scheme" content="dark">' +
    '<link rel="alternate" type="application/rss+xml" title="' + LASTFM_USER + ' — recent scrobbles" href="/rss">' +
    '<link rel="preload" href="/fonts/redaction-35-400.woff2" as="font" type="font/woff2" crossorigin>' +
    '<link rel="stylesheet" href="/assets/style.css">' +
    "</head><body class=\"songs\">" +
    body +
    "</body></html>"
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
