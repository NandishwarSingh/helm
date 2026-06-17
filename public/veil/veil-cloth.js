// src/loader.ts
var VeilError = class extends Error {
  constructor(code, message, recoverable = false) {
    super(message);
    this.name = "VeilError";
    this.code = code;
    this.recoverable = recoverable;
  }
};
function threadsAvailable() {
  return typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
}
async function requestWebGPUDevice() {
  const gpu = navigator.gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}
async function loadVeil(opts) {
  const isolated = threadsAvailable();
  if (opts.threads === "on" && !isolated && opts.renderer === "webgl") {
    throw new VeilError(
      "coi-required",
      'threads="on" but the page is not cross-origin isolated. Send COOP: same-origin + COEP: require-corp, or use threads="auto".'
    );
  }
  let device = null;
  if (opts.renderer !== "webgl") device = await requestWebGPUDevice();
  let variant;
  let usingThreads = false;
  if (device) {
    variant = "webgpu";
  } else {
    usingThreads = opts.threads === "on" || opts.threads === "auto" && isolated;
    variant = usingThreads ? "mt" : "st";
  }
  const moduleUrl = new URL(`veil.${variant}.mjs`, opts.baseUrl).href;
  let factory;
  try {
    const mod = await import(
      /* @vite-ignore */
      /* webpackIgnore: true */
      moduleUrl
    );
    factory = mod.default;
  } catch (e) {
    throw new VeilError("load-failed", `failed to import ${moduleUrl}: ${e.message}`);
  }
  const gateWasm = !!(opts.gated && opts.licenseServer && opts.licenseKey);
  const moduleArg = {
    canvas: opts.canvas,
    onVeilEvent: opts.onEvent,
    locateFile: (path) => {
      if (gateWasm && path.endsWith(".wasm")) {
        const u = new URL("/v1/asset", opts.licenseServer);
        u.searchParams.set("file", path);
        u.searchParams.set("key", opts.licenseKey);
        u.searchParams.set("origin", location.origin);
        return u.href;
      }
      return new URL(path, opts.baseUrl).href;
    },
    print: () => {},
    printErr: (t) => console.error("[veil]", t)
  };
  if (device) moduleArg.preinitializedWebGPUDevice = device;
  let module;
  try {
    module = await factory(moduleArg);
  } catch (e) {
    throw new VeilError("load-failed", `wasm instantiate failed: ${e.message}`);
  }
  return { module, usingThreads, usingWebGPU: !!device };
}

// src/license.ts
var PUBLIC_JWK = { crv: "Ed25519", x: "2gdGzPMN-lYkCLlDYPzBtTDVe9Lo_ARQzqy-yy6at3Y", kty: "OKP" };
var GRACE_MS = 7 * 24 * 3600 * 1e3;
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8(s) {
  const a = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(a.length));
  out.set(a);
  return out;
}
var keyPromise = null;
function pubKey() {
  if (!keyPromise) keyPromise = crypto.subtle.importKey("jwk", PUBLIC_JWK, { name: "Ed25519" }, false, ["verify"]);
  return keyPromise;
}
async function verifyToken(token, origin, allowExpired = false) {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return { valid: false, reason: "malformed", exp: 0 };
    const sig = b64urlToBytes(s);
    const msg = utf8(h + "." + p);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, await pubKey(), sig, msg);
    if (!ok) return { valid: false, reason: "bad-signature", exp: 0 };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    if (payload.aud !== origin) return { valid: false, reason: "origin-mismatch", exp: 0 };
    const exp = payload.exp ?? 0;
    if (!allowExpired && (!exp || exp * 1e3 < Date.now())) return { valid: false, reason: "expired", exp };
    return { valid: true, reason: "ok", exp };
  } catch {
    return { valid: false, reason: "verify-error", exp: 0 };
  }
}
function readCache(k) {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function writeCache(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
  }
}
async function acquireLicense(serverUrl, key, origin) {
  if (!serverUrl) return { licensed: true, reason: "unmanaged" };
  if (!key) return { licensed: false, reason: "no-key" };
  const cacheKey = `veil.lic.${origin}`;
  try {
    const r = await fetch(new URL("/v1/token", serverUrl).href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, origin })
    });
    const j = await r.json();
    if (j.ok && j.token) {
      const v = await verifyToken(j.token, origin);
      if (v.valid) {
        writeCache(cacheKey, { token: j.token, exp: v.exp });
        return { licensed: true, reason: "minted" };
      }
      return { licensed: false, reason: "bad-token" };
    }
    return { licensed: false, reason: j.reason || "rejected" };
  } catch {
    const cached = readCache(cacheKey);
    if (cached) {
      const v = await verifyToken(cached.token, origin, true);
      if (v.valid && v.exp * 1e3 + GRACE_MS > Date.now()) return { licensed: true, reason: "offline-grace" };
    }
    return { licensed: false, reason: "offline-no-grace" };
  }
}

// src/veil-cloth.ts
var INTERACTION_CODE = { both: 0, tear: 1, drag: 2, none: 3 };
var LOAD_TIMEOUT_MS = 2e4;
var FACE_INTERACTIVE_SEL = 'input,textarea,select,button,a[href],[contenteditable],[tabindex],[role="button"]';
function cssColorToRgb(color) {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) return [1, 1, 1];
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
function quadMatrix3d(w, h, dst) {
  const adj = (m) => [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3]
  ];
  const mm = (a, b) => {
    const r = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s2 = 0;
      for (let k = 0; k < 3; k++) s2 += a[3 * i + k] * b[3 * k + j];
      r[3 * i + j] = s2;
    }
    return r;
  };
  const mv = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  const basis = (x1, y1, x2, y2, x3, y3, x4, y4) => {
    const m = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
    const v = mv(adj(m), [x4, y4, 1]);
    return mm(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
  };
  const s = basis(0, 0, w, 0, 0, h, w, h);
  const d = basis(dst[0], dst[1], dst[2], dst[3], dst[4], dst[5], dst[6], dst[7]);
  const t = mm(d, adj(s));
  if (!isFinite(t[8]) || Math.abs(t[8]) < 1e-6) return null;
  for (let i = 0; i < 9; i++) t[i] /= t[8];
  const m3d = [t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]];
  for (const n of m3d) if (!isFinite(n)) return null;
  return `matrix3d(${m3d.join(",")})`;
}
var VeilClothElement = class _VeilClothElement extends HTMLElement {
  static get observedAttributes() {
    return ["reveal-threshold", "interaction", "tearable", "disabled"];
  }
  static {
    /** Override to point all instances at a custom runtime directory. */
    this.runtimeBase = null;
  }
  #canvas = null;
  #revealBtn = null;
  #uiLayer = null;
  #module = null;
  #state = "idle";
  #usingThreads = false;
  #usingWebGPU = false;
  #licensed = true;
  #progress = 0;
  #resizeObserver = null;
  #resizeTimer = 0;
  // Live video texture (the `video` attr): plays media onto the cloth each frame.
  #video = null;
  #videoCtx = null;
  #videoPtr = 0;
  #videoRAF = 0;
  #videoStop = false;
  // veil-ui "ride": clickable overlay elements warp with the cloth's deformation
  // (4-corner matrix3d, relative to rest — so at rest they stay where placed).
  #ridePtr = 0;
  #rideRAF = 0;
  #rideItems = [];
  // Clickable/typeable veil-face: render UI to the cloth texture + raycast
  // pointer→UV→real hidden DOM control (the pushmatrix technique).
  #faceCtx = null;
  #facePtr = 0;
  #facePickPtr = 0;
  #faceOverlay = null;
  #faceRenderTimer = 0;
  #faceUp = null;
  #readyResolve;
  #readyReject;
  #ready;
  #loadTimer = 0;
  // Bumped on every mount AND every destroy. An in-flight async #mount captures
  // its epoch and bails (tearing down anything it created) if it no longer
  // matches — i.e. the element was destroyed or re-mounted mid-load.
  #mountEpoch = 0;
  constructor() {
    super();
    this.#ready = new Promise((res, rej) => {
      this.#readyResolve = res;
      this.#readyReject = rej;
    });
  }
  /* ---- public API ---- */
  /** Resolves once the veil is loaded, initialized and covering the content. */
  get ready() {
    return this.#ready;
  }
  get state() {
    return this.#state;
  }
  get progress() {
    return this.#progress;
  }
  get usingThreads() {
    return this.#usingThreads;
  }
  /** Whether the WebGPU (depth-buffered, MSAA) renderer is active. */
  get usingWebGPU() {
    return this.#usingWebGPU;
  }
  /** Whether the license check passed (true in unmanaged/dev mode). */
  get licensed() {
    return this.#licensed;
  }
  get revealed() {
    return this.#state === "revealed";
  }
  /** Force the reveal (drop the pins) without waiting for the tear threshold. */
  reveal() {
    this.#call("veil_reveal", null, [], []);
  }
  /** Rebuild the cloth and return to the covered state. */
  reset() {
    this.removeAttribute("revealed");
    if (this.#canvas) this.#canvas.style.opacity = "1";
    this.#call("veil_reset", null, [], []);
  }
  /** Inject a tear at element-space coordinates (CSS px relative to the host). */
  tearAt(x, y, radius = 0) {
    this.#call("veil_tear_at", null, ["number", "number", "number"], [x, y, radius]);
  }
  pause() {
    this.#call("veil_pause", null, [], []);
  }
  resume() {
    this.#call("veil_resume", null, [], []);
  }
  /* ---- lifecycle ---- */
  connectedCallback() {
    if (this.hasAttribute("disabled") || this.#module) return;
    if (this.#unsupported()) {
      this.#fail(new VeilError("unsupported", "WebAssembly/canvas not available", false));
      return;
    }
    this.#mount();
  }
  disconnectedCallback() {
    this.destroy();
  }
  attributeChangedCallback(name, _old, value) {
    if (name === "disabled") {
      if (value != null) {
        if (this.#module || this.#canvas) this.destroy();
      } else if (this.isConnected && !this.#module && !this.#unsupported()) {
        void this.#mount();
      }
      return;
    }
    if (!this.#module) return;
    if (name === "reveal-threshold" && value != null) {
      this.#call("veil_set_reveal_threshold", null, ["number"], [parseFloat(value)]);
    } else if (name === "interaction" && value != null) {
      this.#call("veil_set_interaction", null, ["number"], [INTERACTION_CODE[value] ?? 0]);
    } else if (name === "tearable") {
      this.#call("veil_set_tearable", null, ["number"], [value !== null && value !== "false" ? 1 : 0]);
    }
  }
  /** Tear everything down so the element can be removed/recreated cleanly. */
  destroy() {
    this.#mountEpoch++;
    if (this.#loadTimer) {
      clearTimeout(this.#loadTimer);
      this.#loadTimer = 0;
    }
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
    if (this.#resizeTimer) {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = 0;
    }
    const m = this.#module;
    this.#module = null;
    this.#videoStop = true;
    if (this.#videoRAF) {
      cancelAnimationFrame(this.#videoRAF);
      this.#videoRAF = 0;
    }
    if (this.#video) {
      try {
        this.#video.pause();
      } catch {
      }
      this.#video.removeAttribute("src");
      this.#video = null;
    }
    if (m && this.#videoPtr) {
      try {
        m._free(this.#videoPtr);
      } catch {
      }
    }
    this.#videoPtr = 0;
    this.#videoCtx = null;
    if (this.#rideRAF) {
      cancelAnimationFrame(this.#rideRAF);
      this.#rideRAF = 0;
    }
    for (const it of this.#rideItems) {
      it.el.style.transform = it.base;
      it.el.style.willChange = "";
      it.el.style.transformOrigin = "";
    }
    this.#rideItems = [];
    if (m && this.#ridePtr) {
      try {
        m._free(this.#ridePtr);
      } catch {
      }
    }
    this.#ridePtr = 0;
    if (this.#faceRenderTimer) {
      clearTimeout(this.#faceRenderTimer);
      this.#faceRenderTimer = 0;
    }
    if (this.#faceUp) {
      removeEventListener("pointerup", this.#faceUp);
      this.#faceUp = null;
    }
    if (this.#faceOverlay) {
      this.#faceOverlay.remove();
      this.#faceOverlay = null;
    }
    if (m && this.#facePtr) {
      try {
        m._free(this.#facePtr);
      } catch {
      }
    }
    if (m && this.#facePickPtr) {
      try {
        m._free(this.#facePickPtr);
      } catch {
      }
    }
    this.#facePtr = 0;
    this.#facePickPtr = 0;
    this.#faceCtx = null;
    if (m) {
      try {
        m.ccall("veil_destroy", null, [], []);
      } catch {
      }
      try {
        m.PThread?.terminateAllThreads?.();
      } catch {
      }
    }
    if (this.#canvas) {
      this.#canvas.remove();
      this.#canvas = null;
    }
    if (this.#revealBtn) {
      this.#revealBtn.remove();
      this.#revealBtn = null;
    }
    if (this.#uiLayer) {
      while (this.#uiLayer.firstChild) this.appendChild(this.#uiLayer.firstChild);
      this.#uiLayer.remove();
      this.#uiLayer = null;
    }
    this.#state = "idle";
    this.#progress = 0;
    this.removeAttribute("revealed");
  }
  /* ---- internals ---- */
  #unsupported() {
    return typeof WebAssembly === "undefined" || typeof document.createElement("canvas").getContext !== "function";
  }
  #runtimeBase() {
    const attr = this.getAttribute("src");
    if (attr) return new URL(attr, document.baseURI).href;
    if (_VeilClothElement.runtimeBase) return _VeilClothElement.runtimeBase;
    return new URL("./runtime/", import.meta.url).href;
  }
  async #mount() {
    if (this.#state === "loading" || this.#module) return;
    const epoch = ++this.#mountEpoch;
    this.#state = "loading";
    this.#ready = new Promise((res, rej) => {
      this.#readyResolve = res;
      this.#readyReject = rej;
    });
    if (getComputedStyle(this).position === "static") this.style.position = "relative";
    const canvas = document.createElement("canvas");
    canvas.id = `veil-canvas-${Math.floor(performance.now())}-${_VeilClothElement.#seq++}`;
    canvas.setAttribute("aria-hidden", "true");
    canvas.setAttribute("role", "presentation");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      zIndex: "var(--veil-z, 5)",
      cursor: "var(--veil-cursor, grab)",
      touchAction: "none",
      transition: "opacity var(--veil-fade-duration, 1.1s) ease",
      // Cover the content immediately (no flash) using the configured top color.
      background: this.getAttribute("color")?.split(",")[0]?.trim() || "#2a2722"
    });
    this.appendChild(canvas);
    this.#canvas = canvas;
    this.#sizeCanvas();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Reveal content";
    Object.assign(btn.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "-1px",
      overflow: "hidden",
      clip: "rect(0 0 0 0)",
      whiteSpace: "nowrap",
      border: "0",
      zIndex: "var(--veil-z, 5)"
    });
    btn.addEventListener("click", () => this.reveal());
    this.appendChild(btn);
    this.#revealBtn = btn;
    const uiEls = Array.from(this.querySelectorAll(':scope > [slot="veil-ui"]'));
    if (uiEls.length) {
      const layer = document.createElement("div");
      Object.assign(layer.style, {
        position: "absolute",
        inset: "0",
        zIndex: "calc(var(--veil-z, 5) + 1)",
        pointerEvents: "none"
      });
      for (const el of uiEls) {
        el.style.pointerEvents = "auto";
        layer.appendChild(el);
      }
      this.appendChild(layer);
      this.#uiLayer = layer;
    }
    let result;
    try {
      result = await loadVeil({
        baseUrl: this.#runtimeBase(),
        threads: this.getAttribute("threads") || "auto",
        renderer: this.getAttribute("renderer") || "auto",
        gated: this.hasAttribute("gated"),
        licenseServer: this.getAttribute("license-server"),
        licenseKey: this.getAttribute("license-key"),
        canvas,
        onEvent: (type, value) => this.#onVeilEvent(type, value)
      });
    } catch (e) {
      if (this.#mountEpoch === epoch) this.#fail(e);
      return;
    }
    if (this.#mountEpoch !== epoch) {
      try {
        result.module.ccall("veil_destroy", null, [], []);
      } catch {
      }
      try {
        result.module.PThread?.terminateAllThreads?.();
      } catch {
      }
      return;
    }
    this.#module = result.module;
    this.#usingThreads = result.usingThreads;
    this.#usingWebGPU = result.usingWebGPU;
    try {
      const lic = await acquireLicense(this.getAttribute("license-server"), this.getAttribute("license-key"), location.origin);
      if (this.#mountEpoch !== epoch) return;
      this.#licensed = lic.licensed;
      if (!lic.licensed) console.warn(`[veil] unlicensed (${lic.reason}) \u2014 watermark shown`);
      this.#applyConfig();
      await this.#applyTexture();
      if (this.#mountEpoch !== epoch) return;
    } catch (e) {
      if (this.#mountEpoch === epoch) this.#fail(e);
      return;
    }
    this.#loadTimer = self.setTimeout(() => {
      if (this.#state === "loading") {
        this.#fail(new VeilError("load-failed", "veil did not become ready in time", true));
      }
    }, LOAD_TIMEOUT_MS);
    this.#call("veil_start", null, [], []);
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(this);
  }
  /** Read attributes and push them to the runtime BEFORE veil_start. */
  #applyConfig() {
    if (this.#canvas) this.#call("veil_set_canvas_selector", null, ["string"], ["#" + this.#canvas.id]);
    const cfg = this.#configFromAttributes();
    if (cfg.grid) this.#call("veil_set_grid", null, ["number", "number"], cfg.grid);
    else if (!this.#usingThreads) this.#call("veil_set_grid", null, ["number", "number"], [160, 96]);
    if (cfg.drape != null || cfg.drapeFolds != null) {
      this.#call("veil_set_drape", null, ["number", "number"], [cfg.drape ?? 26, cfg.drapeFolds ?? 3]);
    }
    if (cfg.breeze != null) this.#call("veil_set_breeze", null, ["number"], [cfg.breeze]);
    else if (this.#uiLayer) this.#call("veil_set_breeze", null, ["number"], [0]);
    if (cfg.length != null) this.#call("veil_set_length", null, ["number"], [cfg.length]);
    if (cfg.revealThreshold != null) {
      this.#call("veil_set_reveal_threshold", null, ["number"], [cfg.revealThreshold]);
    }
    if (cfg.color) {
      const [tr, tg, tb] = cssColorToRgb(cfg.color[0]);
      const [br, bg, bb] = cssColorToRgb(cfg.color[1]);
      this.#call(
        "veil_set_colors",
        null,
        ["number", "number", "number", "number", "number", "number"],
        [tr, tg, tb, br, bg, bb]
      );
    }
    if (cfg.label != null) this.#call("veil_set_label", null, ["string"], [cfg.label]);
    if (cfg.tearable != null) this.#call("veil_set_tearable", null, ["number"], [cfg.tearable ? 1 : 0]);
    if (cfg.interaction) {
      this.#call("veil_set_interaction", null, ["number"], [INTERACTION_CODE[cfg.interaction] ?? 0]);
    }
    if (cfg.seed != null) this.#call("veil_set_seed", null, ["number"], [cfg.seed >>> 0]);
    this.#call("veil_set_autoscale", null, ["number"], [this.getAttribute("autoscale") === "off" ? 0 : 1]);
    this.#call("veil_set_licensed", null, ["number"], [this.#licensed ? 1 : 0]);
  }
  /** Build the cloth surface in a 2D canvas — a consumer image (`texture`) OR the
   * `color` gradient, plus the `label` in a real web font — and upload it to the
   * engine so it tears with the fabric. Falls back to the engine's procedural
   * bake if anything here fails. Runs before veil_start. */
  async #applyTexture() {
    const m = this.#module;
    if (!m) return;
    const TW = 1024, TH = 640;
    let ctx = null;
    try {
      const cnv = document.createElement("canvas");
      cnv.width = TW;
      cnv.height = TH;
      ctx = cnv.getContext("2d");
    } catch {
    }
    if (!ctx) return;
    const src = this.getAttribute("texture");
    if (src) {
      try {
        const img = await this.#loadImage(src);
        const ar = img.width / img.height, tr = TW / TH;
        let dw = TW, dh = TH, dx = 0, dy = 0;
        if (ar > tr) {
          dh = TH;
          dw = TH * ar;
          dx = (TW - dw) / 2;
        } else {
          dw = TW;
          dh = TW / ar;
          dy = (TH - dh) / 2;
        }
        ctx.drawImage(img, dx, dy, dw, dh);
      } catch (e) {
        console.warn("[veil] texture image failed; using gradient", e);
        this.#drawGradient(ctx, TW, TH);
      }
    } else {
      this.#drawGradient(ctx, TW, TH);
    }
    await this.#paintFace(ctx, TW, TH);
    if (this.#module !== m) return;
    const label = this.getAttribute("label");
    if (label) {
      const font = this.getAttribute("label-font") || "system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `800 ${Math.round(TH * 0.16)}px ${font}`;
      ctx.fillStyle = "rgba(20,12,18,0.28)";
      ctx.fillText(label, TW / 2 + 3, TH / 2 + 3);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fillText(label, TW / 2, TH / 2);
    }
    if (!this.#licensed) this.#drawWatermark(ctx, TW, TH);
    if (this.#module !== m) return;
    try {
      const data = ctx.getImageData(0, 0, TW, TH).data;
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const ptr = m._malloc(u8.length);
      try {
        m.HEAPU8.set(u8, ptr);
        m.ccall("veil_set_texture_rgba", null, ["number", "number", "number"], [ptr, TW, TH]);
      } finally {
        m._free(ptr);
      }
    } catch (e) {
      console.warn("[veil] texture upload failed (CORS-tainted image?)", e);
    }
    const slotted = this.querySelector(':scope > video[slot="veil-video"]');
    const videoSrc = this.getAttribute("video");
    if (slotted || videoSrc) this.#startVideo(m, slotted, videoSrc, TW, TH);
  }
  /** Play a <video> live onto the cloth: each video frame is drawn to a canvas and
   * pushed into the running cloth texture, so the media tears with the fabric.
   * Muted + playsinline so autoplay is allowed; cross-origin video needs CORS or
   * the frame read taints and is skipped. */
  #startVideo(m, existing, src, TW, TH) {
    try {
      const v = existing ?? document.createElement("video");
      if (!existing) {
        if (src) v.src = src;
        v.loop = true;
        v.autoplay = true;
        v.crossOrigin = "anonymous";
        v.preload = "auto";
      }
      v.muted = true;
      v.playsInline = true;
      this.#video = existing ? null : v;
      if (existing) {
        existing.style.display = "none";
      }
      const cnv = document.createElement("canvas");
      cnv.width = TW;
      cnv.height = TH;
      this.#videoCtx = cnv.getContext("2d");
      if (!this.#videoCtx) return;
      this.#videoPtr = m._malloc(TW * TH * 4);
      this.#videoStop = false;
      const label = this.getAttribute("label");
      const labelFont = this.getAttribute("label-font") || "system-ui, -apple-system, sans-serif";
      const hasRVFC = typeof v.requestVideoFrameCallback === "function";
      const draw = () => {
        if (this.#videoStop || this.#module !== m) return;
        const ctx = this.#videoCtx;
        if (ctx && v.readyState >= 2 && v.videoWidth > 0) {
          const ar = v.videoWidth / v.videoHeight, tr = TW / TH;
          let dw = TW, dh = TH, dx = 0, dy = 0;
          if (ar > tr) {
            dh = TH;
            dw = TH * ar;
            dx = (TW - dw) / 2;
          } else {
            dw = TW;
            dh = TW / ar;
            dy = (TH - dh) / 2;
          }
          ctx.drawImage(v, dx, dy, dw, dh);
          if (label) {
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = `800 ${Math.round(TH * 0.16)}px ${labelFont}`;
            ctx.fillStyle = "rgba(20,12,18,0.30)";
            ctx.fillText(label, TW / 2 + 3, TH / 2 + 3);
            ctx.fillStyle = "rgba(255,255,255,0.96)";
            ctx.fillText(label, TW / 2, TH / 2);
          }
          try {
            const data = ctx.getImageData(0, 0, TW, TH).data;
            const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            m.HEAPU8.set(u8, this.#videoPtr);
            m.ccall("veil_update_texture_rgba", null, ["number", "number", "number"], [this.#videoPtr, TW, TH]);
          } catch {
          }
        }
        if (hasRVFC) v.requestVideoFrameCallback(draw);
        else this.#videoRAF = self.requestAnimationFrame(draw);
      };
      void v.play().catch(() => {
      });
      if (hasRVFC) v.requestVideoFrameCallback(draw);
      else this.#videoRAF = self.requestAnimationFrame(draw);
    } catch (e) {
      console.warn("[veil] video setup failed", e);
    }
  }
  /** Make slot="veil-ui" overlay elements WARP with the cloth: each frame, sample
   * the cloth's deformation at the element's 4 corners and apply a matrix3d quad
   * warp — RELATIVE to the resting drape, so at rest the element sits exactly
   * where CSS placed it (and stays clickable: buttons/sliders/inputs are real
   * DOM, hit-tested through the transform). It rides/warps when the cloth moves
   * (grab, tear, reveal) but cannot shred (atomic DOM). */
  #startUIRide() {
    const layer = this.#uiLayer, m = this.#module;
    if (!layer || !m || !layer.children.length) return;
    const W = Math.max(1, this.clientWidth), H = Math.max(1, this.clientHeight);
    const host = this.getBoundingClientRect();
    this.#ridePtr = m._malloc(12);
    const sample = (u, v) => {
      m.ccall("veil_sample", null, ["number", "number", "number"], [u, v, this.#ridePtr]);
      const f = new Float32Array(m.HEAPU8.buffer, this.#ridePtr, 2);
      return [f[0], f[1]];
    };
    this.#rideItems = [];
    for (const el of Array.from(layer.children)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cx = [r.left, r.right, r.left, r.right], cy = [r.top, r.top, r.bottom, r.bottom];
      const uv = [], rest = [];
      for (let i = 0; i < 4; i++) {
        const u = Math.min(1, Math.max(0, (cx[i] - host.left) / W));
        const v = Math.min(1, Math.max(0, (cy[i] - host.top) / H));
        uv.push([u, v]);
        rest.push(sample(u, v));
      }
      const ct = getComputedStyle(el).transform;
      this.#rideItems.push({ el, base: ct && ct !== "none" ? ct : "", w: el.offsetWidth, h: el.offsetHeight, uv, rest });
      el.style.transformOrigin = "0 0";
      el.style.willChange = "transform";
    }
    if (!this.#rideItems.length) {
      m._free(this.#ridePtr);
      this.#ridePtr = 0;
      return;
    }
    const loop = () => {
      if (!this.#module || this.#module !== m) return;
      for (const it of this.#rideItems) {
        try {
          const dst = [];
          let maxd = 0;
          for (let i = 0; i < 4; i++) {
            const s = sample(it.uv[i][0], it.uv[i][1]);
            const dx = s[0] - it.rest[i][0], dy = s[1] - it.rest[i][1];
            maxd = Math.max(maxd, Math.abs(dx), Math.abs(dy));
            const lx = i === 1 || i === 3 ? it.w : 0, ly = i >= 2 ? it.h : 0;
            dst.push(lx + dx, ly + dy);
          }
          const mat = maxd < 6 ? null : quadMatrix3d(it.w, it.h, dst);
          it.el.style.transform = mat ? `${it.base} ${mat}` : it.base;
        } catch {
        }
      }
      this.#rideRAF = self.requestAnimationFrame(loop);
    };
    this.#rideRAF = self.requestAnimationFrame(loop);
  }
  /** Make a veil-face that contains real controls CLICKABLE and TYPEABLE on the
   * cloth (the pushmatrix technique): the UI is rendered into the cloth texture
   * (so it tears with the fabric), and a transparent overlay raycasts the pointer
   * onto the cloth (veil_pick → UV), maps the UV to the hidden real DOM control at
   * that spot, and clicks/focuses it — the focused real input receives keystrokes
   * natively, and the texture is re-rendered so the text appears on the cloth.
   * Drags off the UI tear the cloth (via tearAt). */
  #initFaceInteraction() {
    const face = this.querySelector(':scope > [slot="veil-face"]');
    const m = this.#module;
    if (!face || !m || !face.querySelector(FACE_INTERACTIVE_SEL)) return;
    const TW = 1024, TH = 640;
    const cnv = document.createElement("canvas");
    cnv.width = TW;
    cnv.height = TH;
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    this.#faceCtx = ctx;
    this.#facePtr = m._malloc(TW * TH * 4);
    this.#facePickPtr = m._malloc(8);
    const reRender = () => {
      if (this.#module !== m) return;
      ctx.clearRect(0, 0, TW, TH);
      this.#drawGradient(ctx, TW, TH);
      this.#drawFace(face, ctx, TW, TH);
      try {
        const data = ctx.getImageData(0, 0, TW, TH).data;
        const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        m.HEAPU8.set(u8, this.#facePtr);
        m.ccall("veil_update_texture_rgba", null, ["number", "number", "number"], [this.#facePtr, TW, TH]);
      } catch {
      }
    };
    const sched = () => {
      if (this.#faceRenderTimer) return;
      this.#faceRenderTimer = self.setTimeout(() => {
        this.#faceRenderTimer = 0;
        reRender();
      }, 30);
    };
    face.addEventListener("input", sched, true);
    face.addEventListener("change", sched, true);
    face.addEventListener("click", sched, true);
    const hitFace = (u, v) => {
      const r = face.getBoundingClientRect();
      const px = r.left + u * r.width, py = r.top + v * r.height;
      let best = null;
      const visit = (el) => {
        const er = el.getBoundingClientRect();
        if (px >= er.left && px <= er.right && py >= er.top && py <= er.bottom) best = el;
        for (const c of Array.from(el.children)) visit(c);
      };
      visit(face);
      return best;
    };
    const pick = (clientX, clientY) => {
      const r = this.getBoundingClientRect();
      m.ccall("veil_pick", null, ["number", "number", "number"], [clientX - r.left, clientY - r.top, this.#facePickPtr]);
      const f = new Float32Array(m.HEAPU8.buffer, this.#facePickPtr, 2);
      return f[0] < 0 ? null : [f[0], f[1]];
    };
    const ov = document.createElement("div");
    Object.assign(ov.style, {
      position: "absolute",
      inset: "0",
      zIndex: "var(--veil-z, 5)",
      touchAction: "none",
      cursor: "var(--veil-cursor, grab)"
    });
    this.appendChild(ov);
    this.#faceOverlay = ov;
    let down = false;
    const onDown = (e) => {
      const uv = pick(e.clientX, e.clientY);
      if (uv) {
        const hit = hitFace(uv[0], uv[1]);
        const ctrl = hit?.closest(FACE_INTERACTIVE_SEL);
        if (ctrl) {
          const tag = ctrl.tagName;
          if (tag === "BUTTON" || tag === "A" || ctrl.getAttribute("role") === "button") ctrl.click();
          else ctrl.focus({ preventScroll: true });
          sched();
          e.preventDefault();
          return;
        }
      }
      down = true;
      const r = this.getBoundingClientRect();
      this.tearAt(e.clientX - r.left, e.clientY - r.top);
      try {
        ov.setPointerCapture(e.pointerId);
      } catch {
      }
    };
    const onMove = (e) => {
      if (!down) return;
      const r = this.getBoundingClientRect();
      this.tearAt(e.clientX - r.left, e.clientY - r.top);
    };
    const onUp = () => {
      down = false;
    };
    ov.addEventListener("pointerdown", onDown);
    ov.addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    this.#faceUp = onUp;
    reRender();
  }
  #drawGradient(ctx, w, h) {
    let top = "#2a2722", bottom = "#171512";
    const c = this.getAttribute("color");
    if (c?.includes(",")) {
      const [t, b] = c.split(",");
      top = t.trim();
      bottom = b.trim();
    }
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  /** Bake a `slot="veil-face"` element's HTML/CSS onto the cloth texture so the
   * markup tears with the fabric (a STATIC snapshot — not interactive; use
   * slot="veil-ui" for clickable controls). We CANNOT use SVG <foreignObject>:
   * browsers taint the canvas (SecurityError on getImageData), so the pixels
   * could never be read back to upload. Instead we walk the LAID-OUT DOM and
   * redraw it with Canvas-2D primitives — using each element's real
   * getBoundingClientRect + computed style — which is taint-free and readable.
   * Supports: solid background-color, uniform border + border-radius, text
   * (font/color/align, word-wrapped), and <img> (CORS-enabled). Not supported:
   * gradients/shadows/filters/pseudo-elements/transforms on face elements — use
   * solid colors, or the `texture` attr for a fully-designed surface. Design the
   * face for the cloth aspect (~1024x640). */
  async #paintFace(ctx, TW, TH) {
    const face = this.querySelector(':scope > [slot="veil-face"]');
    if (!face) return false;
    try {
      this.#drawFace(face, ctx, TW, TH);
      if (face.querySelector(FACE_INTERACTIVE_SEL)) {
        face.style.opacity = "0";
        face.style.pointerEvents = "none";
      } else face.style.display = "none";
      return true;
    } catch (e) {
      console.warn("[veil] veil-face paint failed; skipping", e);
      return false;
    }
  }
  /** Draw a veil-face element's HTML/CSS onto ctx (sized TW×TH) via a DOM walk.
   * Supports solid background-color, uniform border + radius, text (word-wrapped),
   * and <img>. Used for the initial bake and for live re-render on UI changes. */
  #drawFace(face, ctx, TW, TH) {
    const fr = face.getBoundingClientRect();
    if (fr.width < 1 || fr.height < 1) return;
    const sx = TW / fr.width, sy = TH / fr.height, ss = Math.min(sx, sy);
    const rrect = (x, y, w, h, r) => {
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, r);
      } else {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }
    };
    const draw = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return;
      const r = el.getBoundingClientRect();
      const x = (r.left - fr.left) * sx, y = (r.top - fr.top) * sy;
      const w = r.width * sx, h = r.height * sy;
      const radius = parseFloat(cs.borderTopLeftRadius) * ss || 0;
      const bg = cs.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        ctx.fillStyle = bg;
        rrect(x, y, w, h, radius);
        ctx.fill();
      }
      const bw = parseFloat(cs.borderTopWidth) * ss || 0;
      if (bw > 0.3 && cs.borderTopStyle !== "none") {
        ctx.strokeStyle = cs.borderTopColor;
        ctx.lineWidth = bw;
        rrect(x + bw / 2, y + bw / 2, w - bw, h - bw, Math.max(0, radius - bw / 2));
        ctx.stroke();
      }
      if (el.tagName === "IMG") {
        try {
          ctx.drawImage(el, x, y, w, h);
        } catch {
        }
      }
      let text;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const ie = el;
        text = (ie.value || ie.placeholder || "").replace(/\s+/g, " ").trim();
      } else {
        text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
      }
      if (text) {
        const fs = parseFloat(cs.fontSize) * sy;
        ctx.fillStyle = cs.color;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
        ctx.textBaseline = "top";
        const a = cs.textAlign;
        ctx.textAlign = a === "center" ? "center" : a === "right" || a === "end" ? "right" : "left";
        const padL = parseFloat(cs.paddingLeft) * sx || 0, padR = parseFloat(cs.paddingRight) * sx || 0;
        const padT = parseFloat(cs.paddingTop) * sy || 0;
        const cw = w - padL - padR;
        const lh = cs.lineHeight === "normal" ? fs * 1.2 : parseFloat(cs.lineHeight) * sy || fs * 1.2;
        const tx = ctx.textAlign === "center" ? x + w / 2 : ctx.textAlign === "right" ? x + w - padR : x + padL;
        let line = "", ty = y + padT;
        for (const word of text.split(" ")) {
          const test = line ? line + " " + word : word;
          if (cw > 0 && ctx.measureText(test).width > cw && line) {
            ctx.fillText(line, tx, ty);
            line = word;
            ty += lh;
          } else line = test;
        }
        if (line) ctx.fillText(line, tx, ty);
      }
    };
    const walk = (el) => {
      draw(el);
      for (const c of Array.from(el.children)) walk(c);
    };
    walk(face);
  }
  #drawWatermark(ctx, w, h) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(h * 0.05)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 8);
    const stepY = Math.round(h * 0.16), stepX = Math.round(w * 0.5);
    for (let y = -h; y <= h; y += stepY) {
      for (let x = -w; x <= w; x += stepX) ctx.fillText("VEIL \xB7 UNLICENSED", x, y);
    }
    ctx.restore();
  }
  #loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed: " + src));
      img.src = src;
    });
  }
  #configFromAttributes() {
    const cfg = {};
    const grid = this.getAttribute("grid");
    if (grid && /^\d+x\d+$/.test(grid)) {
      const [c, r] = grid.split("x").map(Number);
      cfg.grid = [c, r];
    }
    const num = (a) => {
      const v = this.getAttribute(a);
      return v == null ? void 0 : parseFloat(v);
    };
    cfg.drape = num("drape");
    cfg.drapeFolds = num("drape-folds");
    cfg.breeze = num("breeze");
    cfg.length = num("length");
    cfg.revealThreshold = num("reveal-threshold");
    const color = this.getAttribute("color");
    if (color?.includes(",")) {
      const [t, b] = color.split(",");
      cfg.color = [t.trim(), b.trim()];
    }
    const label = this.getAttribute("label");
    if (label != null) cfg.label = label;
    if (this.hasAttribute("tearable")) cfg.tearable = this.getAttribute("tearable") !== "false";
    const inter = this.getAttribute("interaction");
    if (inter && inter in INTERACTION_CODE) cfg.interaction = inter;
    const seed = num("seed");
    if (seed != null && !Number.isNaN(seed)) cfg.seed = seed;
    return cfg;
  }
  #onVeilEvent(type, value) {
    switch (type) {
      case "ready":
        if (this.#loadTimer) {
          clearTimeout(this.#loadTimer);
          this.#loadTimer = 0;
        }
        this.#state = "ready";
        if (this.#canvas) this.#canvas.style.background = "transparent";
        this.#readyResolve();
        this.#startUIRide();
        this.#initFaceInteraction();
        this.#emit("veil-ready", { usingThreads: this.#usingThreads, usingWebGPU: this.#usingWebGPU, threadCount: value });
        break;
      case "progress":
        this.#progress = value;
        if (this.#state === "ready") this.#state = "tearing";
        this.#emit("veil-tear-progress", { progress: value });
        break;
      case "revealed":
        this.#progress = 1;
        this.#state = "revealed";
        this.setAttribute("revealed", "");
        if (this.#canvas) {
          this.#canvas.style.opacity = "0";
          this.#canvas.style.pointerEvents = "none";
        }
        if (this.#revealBtn) {
          this.#revealBtn.remove();
          this.#revealBtn = null;
        }
        this.#emit("veil-revealed", { progress: value });
        break;
      case "reset":
        this.#progress = 0;
        this.#state = "ready";
        this.#emit("veil-reset", {});
        break;
      case "error":
        this.#fail(new VeilError("load-failed", "engine reported an error", true));
        break;
    }
  }
  #onResize() {
    if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = self.setTimeout(() => this.#sizeCanvas(), 150);
  }
  #sizeCanvas() {
    if (!this.#canvas) return;
    const w = Math.max(1, this.clientWidth | 0);
    const h = Math.max(1, this.clientHeight | 0);
    if (this.#canvas.width === w && this.#canvas.height === h) return;
    this.#canvas.width = w;
    this.#canvas.height = h;
    if (this.#module) this.#call("veil_resize", null, ["number", "number"], [w, h]);
  }
  #call(fn, ret, types, args) {
    try {
      this.#module?.ccall(fn, ret, types, args);
    } catch (e) {
      console.error(`[veil] ${fn} failed`, e);
    }
  }
  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  #fail(e) {
    this.#state = "error";
    if (this.#canvas) {
      this.#canvas.remove();
      this.#canvas = null;
    }
    const err = e instanceof VeilError ? e : new VeilError("load-failed", String(e), true);
    this.#readyReject(err);
    this.#ready.catch(() => {
    });
    this.#emit("veil-error", { code: err.code, message: err.message, recoverable: err.recoverable });
  }
  static #seq = 0;
};

// src/index.ts
function register(tag = "veil-cloth") {
  if (typeof customElements !== "undefined" && !customElements.get(tag)) {
    customElements.define(tag, VeilClothElement);
  }
}
register();
export {
  VeilClothElement,
  VeilError,
  register
};
//# sourceMappingURL=veil-cloth.js.map
