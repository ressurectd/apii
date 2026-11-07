/* ------------------------------------------------------------------ *
 *  Hollow wireframe globe, seen from a point just inside it.
 *  Raw WebGL — no libraries. Lat/long great circles, extremely fine,
 *  low opacity, depth-faded, very slow drift. Respects reduced motion;
 *  silently does nothing if WebGL is unavailable (gradient stands in).
 * ------------------------------------------------------------------ */
(function () {
  "use strict";

  var canvas = document.getElementById("globe");
  if (!canvas) return;

  var gl =
    canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false }) ||
    canvas.getContext("experimental-webgl", { antialias: true, alpha: true });
  if (!gl) return; // static gradient fallback

  var reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- geometry: parallels + meridians on a unit sphere ---------- */
  var SEG = 96;        // samples per circle (smooth curves)
  var PARALLELS = 11;  // latitude rings between the poles
  var MERIDIANS = 18;  // longitude half-circles
  var verts = [];

  function push(phi, theta) {
    // phi: polar angle 0..PI, theta: azimuth 0..2PI
    var s = Math.sin(phi);
    verts.push(s * Math.cos(theta), Math.cos(phi), s * Math.sin(theta));
  }

  // parallels (constant phi, swept theta) — drawn as line segments
  for (var i = 1; i <= PARALLELS; i++) {
    var phi = (Math.PI * i) / (PARALLELS + 1);
    for (var j = 0; j < SEG; j++) {
      var a = (2 * Math.PI * j) / SEG;
      var b = (2 * Math.PI * (j + 1)) / SEG;
      push(phi, a);
      push(phi, b);
    }
  }
  // meridians (constant theta, swept phi)
  for (var m = 0; m < MERIDIANS; m++) {
    var theta = (2 * Math.PI * m) / MERIDIANS;
    for (var k = 0; k < SEG; k++) {
      var p1 = (Math.PI * k) / SEG;
      var p2 = (Math.PI * (k + 1)) / SEG;
      push(p1, theta);
      push(p2, theta);
    }
  }

  var data = new Float32Array(verts);
  var count = verts.length / 3;

  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  /* ---- shaders --------------------------------------------------- */
  var vsrc =
    "attribute vec3 position;" +
    "uniform mat4 uProj;" +
    "uniform mat4 uRot;" +
    "uniform vec3 uEye;" +
    "varying float vFade;" +
    "void main(){" +
    "  vec3 p = (uRot * vec4(position, 1.0)).xyz;" +
    "  vec3 viewPos = p - uEye;" +            // camera at origin, looks -z
    "  gl_Position = uProj * vec4(viewPos, 1.0);" +
    "  float d = length(viewPos);" +          // visible wall ~1.0 (near) .. 1.34 (far)
    "  vFade = smoothstep(1.4, 0.98, d);" +   // nearer = brighter
    "}";

  var fsrc =
    "precision mediump float;" +
    "uniform vec3 uColor;" +
    "uniform float uBase;" +
    "varying float vFade;" +
    "void main(){" +
    "  gl_FragColor = vec4(uColor, uBase * vFade);" +
    "}";

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);

  var aPos = gl.getAttribLocation(prog, "position");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  var uProj = gl.getUniformLocation(prog, "uProj");
  var uRot = gl.getUniformLocation(prog, "uRot");
  var uEye = gl.getUniformLocation(prog, "uEye");
  var uColor = gl.getUniformLocation(prog, "uColor");
  var uBase = gl.getUniformLocation(prog, "uBase");

  // soft teal-white lines, very low opacity
  gl.uniform3f(uColor, 0.78, 0.88, 0.85);
  gl.uniform1f(uBase, 0.42);
  // eye sits a little off the sphere's centre so there is real depth
  gl.uniform3f(uEye, 0.0, 0.0, 0.28);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // colour blends "over"; alpha accumulates linearly (no squaring) so the
  // canvas composites cleanly onto the page gradient behind it.
  gl.blendFuncSeparate(
    gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE, gl.ONE_MINUS_SRC_ALPHA
  );
  gl.clearColor(0, 0, 0, 0);

  /* ---- matrices -------------------------------------------------- */
  var proj = new Float32Array(16);
  function perspective(fovy, aspect, near, far) {
    var f = 1.0 / Math.tan(fovy / 2);
    var nf = 1.0 / (near - far);
    proj[0] = f / aspect; proj[1] = 0; proj[2] = 0; proj[3] = 0;
    proj[4] = 0; proj[5] = f; proj[6] = 0; proj[7] = 0;
    proj[8] = 0; proj[9] = 0; proj[10] = (far + near) * nf; proj[11] = -1;
    proj[12] = 0; proj[13] = 0; proj[14] = 2 * far * near * nf; proj[15] = 0;
  }

  var rot = new Float32Array(16);
  function rotation(ay, ax) {
    var cy = Math.cos(ay), sy = Math.sin(ay);
    var cx = Math.cos(ax), sx = Math.sin(ax);
    // Ry then Rx  (column-major)
    rot[0] = cy;        rot[1] = sy * sx;   rot[2] = -sy * cx;  rot[3] = 0;
    rot[4] = 0;         rot[5] = cx;        rot[6] = sx;        rot[7] = 0;
    rot[8] = sy;        rot[9] = -cy * sx;  rot[10] = cy * cx;  rot[11] = 0;
    rot[12] = 0;        rot[13] = 0;        rot[14] = 0;        rot[15] = 1;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.floor(canvas.clientWidth * dpr);
    var h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    var aspect = canvas.width / canvas.height || 1;
    // wide field, as if standing inside the sphere
    perspective((78 * Math.PI) / 180, aspect, 0.01, 10);
    gl.uniformMatrix4fv(uProj, false, proj);
  }

  function draw(ay, ax) {
    rotation(ay, ax);
    gl.uniformMatrix4fv(uRot, false, rot);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.LINES, 0, count);
  }

  window.addEventListener("resize", function () {
    resize();
    if (reduced) draw(0.6, 0.35); // redraw the still frame on resize
  });
  resize();

  if (reduced) {
    draw(0.6, 0.35); // a single composed still frame
    return;
  }

  var start = performance.now();
  (function frame(now) {
    var t = (now - start) / 1000;
    draw(t * 0.045, 0.32 + Math.sin(t * 0.08) * 0.12); // very slow drift
    requestAnimationFrame(frame);
  })(start);
})();
