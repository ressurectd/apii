/* ------------------------------------------------------------------ *
 *  Live "now playing" — polls /now.json and swaps only the regions that
 *  change (top band + previous). Progressive enhancement: the page is
 *  fully server-rendered, this just keeps it fresh without a reload.
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  var top = document.querySelector(".top");
  var prev = document.querySelector(".prev");
  if (!top) return;

  // Remember the last markup we applied so unchanged polls are a no-op
  // (no DOM write = no equaliser restart / cover reload).
  var lastTop = null;
  var lastPrev = null;

  var INTERVAL = 20000; // 20s — Last.fm is edge-cached, so this is cheap
  var timer = null;

  // location.search keeps the dev-only ?site=songs preview working; in
  // production it's empty and the hostname routes the request.
  var ENDPOINT = "/now.json" + location.search;

  async function tick() {
    try {
      var res = await fetch(ENDPOINT, { cache: "no-store" });
      if (!res.ok) return;
      var data = await res.json();
      if (data.top != null && data.top !== lastTop) {
        top.innerHTML = data.top;
        lastTop = data.top;
      }
      if (prev && data.prev != null && data.prev !== lastPrev) {
        prev.innerHTML = data.prev;
        lastPrev = data.prev;
      }
    } catch (e) {
      /* offline / transient — just try again next tick */
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, INTERVAL);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Pause polling when the tab is hidden; refresh immediately on return.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stop();
    } else {
      tick();
      start();
    }
  });

  start();
})();
