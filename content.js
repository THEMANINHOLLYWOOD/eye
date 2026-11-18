// Eye — the in-page half.
//
// Hover any picture or video for Bin / Ask / Send. Highlight text for the
// same. Select mode (⌥⇧M) picks many pieces of media at once. The code picker
// (⌥⇧C) lets you grab any element, edit its HTML or hand it to the agent.
// Eye mode (⌥⇧E) makes the whole page editable — type over it, move and
// delete things — then Done keeps the edits or Restore reloads the page.
// The agent's page tools (read / edit / notify) run here too.
// All UI lives in one shadow root so the site's CSS can't touch it.
(() => {
  if (window.top !== window || window.__eyeLoaded) return;
  window.__eyeLoaded = true;

  // ---------- messaging ----------
  function ask(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(/context invalidated/i.test(err.message) ? "Eye was updated — reload this page." : err.message));
          if (res?.error) {
            const e = new Error(res.error);
            e.code = res.code;
            return reject(e);
          }
          resolve(res);
        });
      } catch {
        reject(new Error("Eye was updated — reload this page."));
      }
    });
  }

  let settings = { hoverChips: true, selectionPill: true };
  ask({ type: "settings" }).then((s) => (settings = { ...settings, ...s })).catch(() => {});
  chrome.storage?.onChanged?.addListener((changes) => {
    const s = changes["eye.settings"]?.newValue;
    if (s) settings = { ...settings, ...s };
  });

  // ---------- page facts + media (same picking rules as the clippers) ----------
  const abs = (u) => {
    if (!u) return null;
    try {
      return new URL(u, location.href).href;
    } catch {
      return null;
    }
  };
  const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
  function pageMeta() {
    return {
      pageUrl: location.href,
      pageTitle: meta('meta[property="og:title"]') || document.title || location.hostname,
      description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
      siteName: meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\./, ""),
      ogImage: abs(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')),
    };
  }
  function parseSrcset(srcset) {
    const out = [];
    if (!srcset) return out;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      const url = abs(u?.replace(/,$/, ""));
      if (!url) continue;
      const m = (d || "").match(/^(\d+(?:\.\d+)?)([wx])$/);
      out.push({ url, w: m?.[2] === "w" ? +m[1] : 0, x: m?.[2] === "x" ? +m[1] : m ? 0 : 1 });
    }
    return out;
  }
  function upgrade(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "pbs.twimg.com" && u.searchParams.has("name")) {
        u.searchParams.set("name", "orig");
        return u.href;
      }
      if (u.hostname === "i.pinimg.com") return url.replace(/\/(\d+x|\d+x\d+)\//, "/originals/");
      if (/(^|\.)googleusercontent\.com$/.test(u.hostname)) return url.replace(/=w\d+-h\d+[^/]*$/, "=s0").replace(/=s\d+[^/]*$/, "=s0");
    } catch {
      /* leave it */
    }
    return url;
  }
  function bestImageSrc(img) {
    const cands = [];
    const push = (list, scale = img.naturalWidth || img.width || 1) => list.forEach((c) => cands.push({ url: c.url, score: c.w || (c.x || 1) * scale }));
    push(parseSrcset(img.getAttribute("srcset")));
    push(parseSrcset(img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset")));
    img.closest("picture")?.querySelectorAll("source").forEach((s) => push(parseSrcset(s.getAttribute("srcset") || s.getAttribute("data-srcset"))));
    for (const a of ["data-src", "data-original", "data-lazy-src", "data-full", "data-large", "data-hi-res-src"]) {
      const v = abs(img.getAttribute(a));
      if (v && !/^data:image\/(gif|svg)/.test(v)) cands.push({ url: v, score: (img.naturalWidth || 1) * 1.01 });
    }
    const cur = img.currentSrc || img.src;
    if (cur) cands.push({ url: cur, score: img.naturalWidth || img.width || 1 });
    cands.sort((a, b) => b.score - a.score);
    const best = cands.find((c) => !/^data:image\/gif/.test(c.url))?.url || cur;
    return best && !best.startsWith("data:") ? upgrade(best) : best;
  }
  function youtubeId(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "youtu.be") return u.pathname.slice(1);
      if (u.hostname.endsWith("youtube.com")) return u.searchParams.get("v") || (u.pathname.match(/\/(shorts|embed|live)\/([\w-]+)/) || [])[2] || null;
    } catch {
      /* no */
    }
    return null;
  }
  /** The post a piece of media belongs to (X / Instagram style feeds), else the page. */
  function postUrlFor(el) {
    const art = el?.closest?.("article");
    const link = art?.querySelector('a[href*="/status/"], a[href*="/p/"], a[href*="/reel/"], time')?.closest("a");
    return link ? abs(link.getAttribute("href")) : location.href;
  }
  function videoMomentUrl(time, el) {
    const t = Math.max(0, Math.floor(time || 0));
    const id = youtubeId(location.href);
    if (id) return `https://www.youtube.com/watch?v=${id}${t ? `&t=${t}s` : ""}`;
    if (/vimeo\.com$/.test(location.hostname)) return `${location.href.split("#")[0]}${t ? `#t=${t}s` : ""}`;
    return postUrlFor(el);
  }
  function textFragmentUrl(text) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return location.href;
    const base = location.href.split("#")[0];
    const words = clean.split(" ");
    const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
    if (clean.length <= 90) return `${base}#:~:text=${enc(clean)}`;
    return `${base}#:~:text=${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-5).join(" "))}`;
  }
  function imageClip(img) {
    const src = bestImageSrc(img);
    const same = src === (img.currentSrc || img.src) && !img.getAttribute("srcset");
    return { kind: "image", src, alt: img.alt || null, width: same ? img.naturalWidth || null : null, height: same ? img.naturalHeight || null : null, title: img.alt || img.title || document.title, url: postUrlFor(img), ...pageMeta() };
  }
  function videoClip(video) {
    const direct = video.currentSrc && /^https?:/.test(video.currentSrc) ? video.currentSrc : video.querySelector("source[src]")?.src || null;
    const id = youtubeId(location.href);
    return {
      kind: "video",
      src: direct && !/\.m3u8|\.mpd/.test(direct) ? direct : null,
      url: videoMomentUrl(video.currentTime, video),
      poster: abs(video.poster) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : pageMeta().ogImage),
      time: video.currentTime || 0,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      title: document.title,
      ...pageMeta(),
    };
  }
  const pageClip = () => {
    const m = pageMeta();
    return { kind: "page", url: location.href, title: m.pageTitle, ...m };
  };
  function selectionClip(text) {
    const t = (text ?? String(getSelection() || "")).trim();
    if (!t) return null;
    return { kind: "text", text: t.slice(0, 20000), fragmentUrl: textFragmentUrl(t), title: document.title, ...pageMeta() };
  }
  const fmtTime = (s) => {
    s = Math.floor(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  // ---------- shadow UI ----------
  const host = document.createElement("eye-ui");
  host.setAttribute("contenteditable", "false");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  (document.documentElement || document.body).appendChild(host);
  const ours = (e) => e.composedPath().includes(host);

  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,-apple-system,"SF Pro Text","Inter",system-ui,sans-serif}
    .layer{position:fixed;inset:0;pointer-events:none}
    button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
    .glass{background:rgba(15,15,17,.94);color:#f4f3ee;border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.6);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
    .chips{position:fixed;display:none;gap:4px;padding:4px;border-radius:999px;pointer-events:auto;z-index:5}
    .chips.on{display:flex}
    .chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.01em;white-space:nowrap;color:#f4f3ee;transition:background .12s,color .12s}
    .chip:hover{background:#d7ff3a;color:#0b0b0d}
    .chip svg{width:14px;height:14px;flex:none}
    .chip.eye{padding:0 8px}
    .card{position:fixed;width:360px;max-width:calc(100vw - 24px);border-radius:16px;pointer-events:auto;z-index:8;font-size:13px;line-height:1.4;animation:pop .14s ease-out}
    @keyframes pop{from{transform:translateY(6px) scale(.98)}to{transform:none}}
    @media (prefers-reduced-motion:reduce){.card{animation:none}}
    .hd{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 14px}
    .hd b{font-size:13px;font-weight:700;letter-spacing:.02em}
    .dot{width:8px;height:8px;border-radius:50%;background:#d7ff3a;flex:none}
    .x{margin-left:auto;width:26px;height:26px;border-radius:8px;color:#a3a29c;font-size:16px;line-height:1}
    .x:hover{background:rgba(255,255,255,.08);color:#fff}
    .bd{padding:0 14px 14px}
    .strip{display:flex;gap:6px;overflow-x:auto;margin-bottom:10px}
    .strip img{height:64px;max-width:120px;object-fit:cover;border-radius:8px;background:#222;flex:none}
    .strip .txt{font-size:12px;color:#c9c8c2;background:rgba(255,255,255,.06);border-radius:8px;padding:8px 10px;max-height:64px;overflow:hidden;flex:1 1 auto;min-width:0}
    .strip .code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px}
    textarea,input,select{width:100%;font:inherit;font-size:13px;color:#f4f3ee;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 10px;outline:none}
    textarea:focus,input:focus,select:focus{border-color:#d7ff3a;box-shadow:0 0 0 3px rgba(215,255,58,.18)}
    textarea{resize:vertical;min-height:74px}
    select option,select optgroup{background:#18181b;color:#f4f3ee}
    .mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11.5px;line-height:1.45}
    .row{display:flex;gap:8px;align-items:center;margin-top:10px}
    .grow{flex:1}
    .quick{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .quick button{font-size:11.5px;padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.07);color:#dcdbd5}
    .quick button:hover{background:rgba(215,255,58,.18);color:#efffb5}
    .btn{height:34px;padding:0 14px;border-radius:10px;font-weight:700;font-size:13px;background:rgba(255,255,255,.09)}
    .btn:hover{background:rgba(255,255,255,.15)}
    .btn.go{background:#d7ff3a;color:#0b0b0d}
    .btn.go:hover{background:#e6ff7a}
    .btn:disabled{opacity:.45;cursor:default}
    .sm{font-size:11.5px;color:#a3a29c}
    .sm a,.link{color:#d7ff3a;text-decoration:none;cursor:pointer}
    .ok{color:#d7ff3a}.bad{color:#ff7b87}
    label.tog{display:flex;align-items:center;gap:7px;font-size:12px;color:#c9c8c2;cursor:pointer;user-select:none}
    label.tog input{width:auto;accent-color:#d7ff3a}
    .status{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#a3a29c}
    .status i{width:7px;height:7px;border-radius:50%;background:#6b6a66}
    .status.on i{background:#7dff6a;box-shadow:0 0 8px #7dff6a}
    .status.off i{background:#ff6a6a}
    .toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);padding:10px 14px;border-radius:12px;font-size:13px;pointer-events:auto;z-index:20;display:flex;gap:10px;align-items:center;max-width:min(560px,calc(100vw - 24px))}
    .box{position:fixed;border:2px solid #d7ff3a;border-radius:6px;pointer-events:none;z-index:3;box-shadow:0 0 0 9999px rgba(0,0,0,0)}
    .box.sel{border-color:#d7ff3a;background:rgba(215,255,58,.12)}
    .box .n{position:absolute;top:-10px;left:-10px;min-width:22px;height:22px;border-radius:11px;background:#d7ff3a;color:#0b0b0d;font:700 12px/22px ui-sans-serif,system-ui;text-align:center;padding:0 6px}
    .tag{position:fixed;pointer-events:none;z-index:4;background:#d7ff3a;color:#0b0b0d;font:600 11px/1 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:5px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
    .bar{position:fixed;left:50%;transform:translateX(-50%);display:flex;gap:6px;align-items:center;padding:6px 6px 6px 14px;border-radius:999px;pointer-events:auto;z-index:9;font-size:12.5px;white-space:nowrap}
    .bar.top{top:14px}.bar.bottom{bottom:22px}
    .badge{background:#d7ff3a;color:#0b0b0d;font-weight:800;font-size:11px;letter-spacing:.08em;padding:4px 8px;border-radius:999px}
    .bar .btn{height:30px;padding:0 12px;font-size:12px;border-radius:999px}
    .mini{position:fixed;display:flex;gap:2px;padding:3px;border-radius:10px;pointer-events:auto;z-index:9}
    .mini button{font-size:11.5px;font-weight:600;padding:5px 8px;border-radius:7px}
    .mini button:hover{background:#d7ff3a;color:#0b0b0d}
    .crumbs{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px}
    .crumbs button{font:600 10.5px/1 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:5px;background:rgba(255,255,255,.07);color:#c9c8c2}
    .crumbs button.cur{background:#d7ff3a;color:#0b0b0d}
    .runs{position:fixed;right:16px;bottom:16px;width:360px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:10}
    .run{border-radius:14px;pointer-events:auto;padding:12px 12px 10px 14px;font-size:12.5px}
    .run .p{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .run .out{margin-top:6px;color:#dcdbd5;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
    .run .act{margin-top:4px;color:#a3a29c;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pillst{font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;border-radius:999px;background:rgba(255,255,255,.1)}
    .pillst.running,.pillst.starting{background:#d7ff3a;color:#0b0b0d}
    .pillst.error{background:#ff5a6a;color:#fff}
    .shade{position:fixed;inset:0;pointer-events:auto;cursor:crosshair;z-index:2}
  `;
  root.append(style);
  const layer = document.createElement("div");
  layer.className = "layer";
  root.append(layer);

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  const svg = (d) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    for (const p of d.split("|")) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", p);
      s.append(path);
    }
    return s;
  };
  const I = {
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    bin: "M12 5v14|M5 12h14",
    ask: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z",
    send: "M5 12h14|M13 6l6 6-6 6",
    frame: "M3 7V5a2 2 0 0 1 2-2h2|M17 3h2a2 2 0 0 1 2 2v2|M21 17v2a2 2 0 0 1-2 2h-2|M7 21H5a2 2 0 0 1-2-2v-2|M10 9l5 3-5 3z",
  };
  const hide = (n) => n?.remove();

  function toast(text, action) {
    root.querySelectorAll(".toast").forEach(hide);
    const t = el("div", { class: "toast glass" }, el("span", { text }));
    if (action) t.append(el("a", { class: "link", text: action.label, onclick: action.run }));
    layer.append(t);
    setTimeout(() => hide(t), action ? 7000 : 3200);
  }

  // ---------- capture ----------
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  async function captureRect(rect, type = "image/png", quality = 0.95) {
    host.style.visibility = "hidden";
    await frames();
    let shot;
    try {
      shot = await ask({ type: "captureVisible" });
    } finally {
      host.style.visibility = "";
    }
    const img = new Image();
    img.src = shot.dataUrl;
    await img.decode();
    const scale = img.naturalWidth / innerWidth;
    const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
    const w = Math.min(innerWidth, rect.left + rect.width) - x;
    const h = Math.min(innerHeight, rect.top + rect.height) - y;
    if (w < 2 || h < 2) throw new Error("That area is off screen.");
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext("2d").drawImage(img, x * scale, y * scale, w * scale, h * scale, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL(type, quality), width: c.width, height: c.height };
  }
  function looksBlack(canvas) {
    const s = document.createElement("canvas");
    s.width = s.height = 16;
    const g = s.getContext("2d");
    g.drawImage(canvas, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (d.length / 4) / 3 < 3;
  }
  function videoContentRect(v) {
    const r = v.getBoundingClientRect();
    const fit = getComputedStyle(v).objectFit;
    if (!v.videoWidth || !v.videoHeight || fit === "fill" || fit === "cover") return r;
    const va = v.videoWidth / v.videoHeight, ea = r.width / r.height;
    if (Math.abs(va - ea) < 0.01) return r;
    if (va > ea) {
      const h = r.width / va;
      return { left: r.left, top: r.top + (r.height - h) / 2, width: r.width, height: h };
    }
    const w = r.height * va;
    return { left: r.left + (r.width - w) / 2, top: r.top, width: w, height: r.height };
  }
  async function captureVideoFrame(v) {
    if (!v.videoWidth) throw new Error("The video hasn't shown a frame yet — press play first.");
    const time = v.currentTime;
    let dataUrl = null, width = v.videoWidth, height = v.videoHeight;
    try {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d").drawImage(v, 0, 0, width, height);
      if (!looksBlack(c)) dataUrl = c.toDataURL("image/jpeg", 0.95);
    } catch {
      dataUrl = null;
    }
    if (!dataUrl) {
      const shot = await captureRect(videoContentRect(v), "image/jpeg", 0.95);
      const probe = new Image();
      probe.src = shot.dataUrl;
      await probe.decode();
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      c.getContext("2d").drawImage(probe, 0, 0, 32, 32);
      if (looksBlack(c)) throw new Error("This video is copy-protected, so the frame comes out black.");
      ({ dataUrl, width, height } = shot);
    }
    return { dataUrl, width, height, time };
  }
  /** A video becomes its current frame (with a link back to the moment); pictures stay pictures. */
  async function clipFor(target) {
    if (target instanceof HTMLVideoElement) {
      const v = videoClip(target);
      try {
        const f = await captureVideoFrame(target);
        const base = (document.title || "frame").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "frame";
        return { ...v, kind: "frame", src: null, videoSrc: v.src, dataUrl: f.dataUrl, width: f.width, height: f.height, time: f.time, fileName: `${base} ${fmtTime(f.time).replace(/:/g, "-")}.jpg`, title: `${document.title} · ${fmtTime(f.time)}` };
      } catch {
        return v;
      }
    }
    return imageClip(target);
  }

  function mediaAt(x, y) {
    for (const n of document.elementsFromPoint(x, y)) {
      if (n === host) continue;
      if (n instanceof HTMLVideoElement || n instanceof HTMLImageElement) return n;
      if (n.tagName === "PICTURE") return n.querySelector("img");
    }
    return null;
  }
  const bigEnough = (n) => {
    const r = n.getBoundingClientRect();
    return r.width >= 120 && r.height >= 90;
  };

  // ---------- hover chips ----------
  const chips = el("div", { class: "chips glass hoverbar" });
  layer.append(chips);
  let hoverTarget = null;
  let hideTimer = 0;
  let mode = null; // null | "select" | "pick" | "eye"

  function chipBtn(icon, label, title, run) {
    return el("button", {
      class: "chip" + (label ? "" : " eye"),
      title,
      onmousedown: (e) => e.preventDefault(),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(e);
      },
    }, svg(icon), label ? document.createTextNode(label) : null);
  }

  function placeChips(target) {
    const r = target.getBoundingClientRect();
    if (!bigEnough(target) || r.bottom < 0 || r.top > innerHeight) return hideChips();
    chips.replaceChildren(
      chipBtn(I.bin, "Bin", "Add to your Eye bin", () => addToBin(target)),
      chipBtn(I.ask, "Ask", "Ask the agent to do something with this", async () => openComposer({ clips: [await clipFor(target)], anchor: target })),
      chipBtn(I.send, "Send", "Send to Storyboardmore or BRN", async () => openSend({ clips: [await clipFor(target)], anchor: target })),
    );
    chips.classList.add("on");
    const w = chips.offsetWidth, h = chips.offsetHeight;
    chips.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + 10))}px`;
    chips.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, r.bottom - h - 10))}px`;
    hoverTarget = target;
  }
  function hideChips() {
    chips.classList.remove("on");
    hoverTarget = null;
  }
  let lastMove = 0;
  addEventListener(
    "mousemove",
    (e) => {
      if (!settings.hoverChips || mode) return;
      const now = performance.now();
      if (now - lastMove < 70) return;
      lastMove = now;
      if (ours(e)) {
        clearTimeout(hideTimer);
        return;
      }
      const m = mediaAt(e.clientX, e.clientY);
      if (m && m !== hoverTarget) {
        clearTimeout(hideTimer);
        placeChips(m);
      } else if (!m && hoverTarget) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideChips, 280);
      } else if (m) clearTimeout(hideTimer);
    },
    { passive: true, capture: true },
  );
  addEventListener("scroll", () => hoverTarget && placeChips(hoverTarget), { passive: true, capture: true });

  async function addToBin(target) {
    try {
      const clip = target instanceof Element ? await clipFor(target) : target;
      const item = await ask({ type: "bin:add", clip });
      toast(`In your bin: ${item.title.slice(0, 60)}`, { label: "Open bin", run: () => ask({ type: "openPanel", tab: "bin" }) });
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- highlight pill ----------
  const pill = el("div", { class: "chips glass pill" });
  layer.append(pill);
  const editableNode = (node) => {
    const n = node?.nodeType === 1 ? node : node?.parentElement;
    return !!n?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
  };
  function showPill() {
    const sel = getSelection();
    const text = String(sel || "").trim();
    if (mode || !settings.selectionPill || !sel || sel.isCollapsed || text.length < 3 || editableNode(sel.anchorNode)) return pill.classList.remove("on");
    const rects = sel.getRangeAt(0).getClientRects();
    const first = rects[0], last = rects[rects.length - 1];
    if (!first) return pill.classList.remove("on");
    pill.replaceChildren(
      chipBtn(I.bin, "Bin", "Add the highlight to your bin", () => {
        pill.classList.remove("on");
        addToBin(selectionClip(text));
      }),
      chipBtn(I.ask, "Ask", "Ask the agent about the highlight", () => {
        pill.classList.remove("on");
        openComposer({ clips: [selectionClip(text)], anchorRect: last });
      }),
      chipBtn(I.send, "Send", "Send the highlight as a storynote or to BRN", () => {
        pill.classList.remove("on");
        openSend({ clips: [selectionClip(text)], anchorRect: last });
      }),
    );
    pill.classList.add("on");
    const w = pill.offsetWidth;
    pill.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, first.left))}px`;
    pill.style.top = `${last.bottom + 50 > innerHeight ? Math.max(8, first.top - 46) : last.bottom + 10}px`;
  }
  let pillTimer = 0;
  document.addEventListener("mouseup", (e) => {
    if (ours(e)) return;
    clearTimeout(pillTimer);
    pillTimer = setTimeout(showPill, 30);
  });
  document.addEventListener("selectionchange", () => {
    if (String(getSelection() || "").trim().length < 3) pill.classList.remove("on");
  });
  addEventListener("scroll", () => pill.classList.remove("on"), { passive: true, capture: true });

  // ---------- cards ----------
  let openCard = null;
  function closeCard() {
    hide(openCard);
    openCard = null;
  }
  function placeCard(card, { anchor, anchorRect }) {
    layer.append(card);
    const r = anchorRect || anchor?.getBoundingClientRect?.() || null;
    const w = card.offsetWidth, h = card.offsetHeight;
    let left, top;
    if (r) {
      left = r.right + 12 + w < innerWidth ? r.right + 12 : r.left - w - 12 > 0 ? r.left - w - 12 : innerWidth - w - 16;
      top = Math.min(Math.max(12, r.top), innerHeight - h - 12);
    } else {
      left = innerWidth - w - 20;
      top = 20;
    }
    card.style.left = `${Math.max(12, left)}px`;
    card.style.top = `${Math.max(12, top)}px`;
  }
  function cardShell(title, onClose) {
    const card = el("div", { class: "card glass" });
    const hd = el("div", { class: "hd" }, el("span", { class: "dot" }), el("b", { text: title }), el("button", { class: "x", title: "Close", text: "×", onclick: () => (onClose ? onClose() : closeCard()) }));
    const bd = el("div", { class: "bd" });
    card.append(hd, bd);
    card.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeCard();
    });
    // Keep the site's keyboard shortcuts out while typing here.
    ["keyup", "keypress"].forEach((t) => card.addEventListener(t, (e) => e.stopPropagation()));
    return { card, bd };
  }
  function previewStrip(clips, element) {
    const strip = el("div", { class: "strip" });
    for (const c of clips.slice(0, 8)) {
      if (c.dataUrl || (c.kind === "image" && c.src)) strip.append(el("img", { src: c.dataUrl || c.src, alt: "" }));
      else if (c.kind === "video" && c.poster) strip.append(el("img", { src: c.poster, alt: "" }));
      else if (c.kind === "text") strip.append(el("div", { class: "txt", text: `“${c.text.slice(0, 220)}”` }));
      else strip.append(el("div", { class: "txt", text: c.title || c.url || c.kind }));
    }
    if (clips.length > 8) strip.append(el("div", { class: "txt", text: `+${clips.length - 8} more` }));
    if (element) strip.append(el("div", { class: "txt code", text: element.label }));
    return strip;
  }

  // ----- Ask (agent prompt) -----
  const QUICK = {
    media: ["Describe this shot like a DP would", "Write a shot list from this", "Write a prompt to recreate this image", "Find where this is from", "Save it to my latest storyboard with notes"],
    text: ["Turn this into a storynote with key points", "Fact-check this", "Rewrite this punchier"],
    code: ["Explain what this is", "Restyle this to look premium", "Make this element better", "Rebuild this as a React component"],
    page: ["Summarize this page", "Pull every image from this page into my bin", "Map this site's design system"],
  };
  async function openComposer({ clips = [], itemIds = [], element = null, anchor = null, anchorRect = null }) {
    closeCard();
    const kind = element ? "code" : clips.some((c) => c.kind === "text") ? "text" : clips.length ? "media" : "page";
    const { card, bd } = cardShell("Ask Eye's agent");
    const box = el("textarea", { placeholder: element ? "What should the agent do with this piece of the page?" : clips.length ? "What should the agent do with this?" : "What should the agent do on this page?" });
    const quick = el("div", { class: "quick" }, QUICK[kind].map((q) => el("button", { text: q, onclick: () => ((box.value = q), box.focus()) })));
    const seePage = el("input", { type: "checkbox", checked: true });
    const status = el("span", { class: "status" }, el("i"), el("span", { text: "Checking helper…" }));
    const go = el("button", { class: "btn go", text: "Run" });
    const run = async () => {
      const prompt = box.value.trim();
      if (!prompt) return box.focus();
      go.disabled = true;
      go.textContent = "Starting…";
      try {
        await ask({ type: "agent:run", prompt, clips, itemIds, element, includePage: seePage.checked });
        closeCard();
      } catch (e) {
        go.disabled = false;
        go.textContent = "Run";
        status.className = "status off";
        status.lastChild.textContent = e.message;
      }
    };
    go.addEventListener("click", run);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
    });
    bd.append(
      clips.length || element ? previewStrip(clips, element) : el("div", { class: "sm", text: `${document.title || location.hostname}` }),
      box,
      quick,
      el("div", { class: "row" }, el("label", { class: "tog" }, seePage, document.createTextNode("Let it see this page"))),
      el("div", { class: "row" }, status, el("span", { class: "grow" }), go),
    );
    openCard = card;
    placeCard(card, { anchor, anchorRect });
    box.focus();
    try {
      const h = await ask({ type: "helper:status" });
      status.className = `status ${h.running ? "on" : "off"}`;
      status.lastChild.textContent = h.running ? "Claude on this Mac is ready" : "Helper not running — double-click eye-helper/start.command";
    } catch {
      status.className = "status off";
      status.lastChild.textContent = "Can't reach Eye";
    }
  }

  // ----- Send -----
  async function openSend({ clips = [], anchor = null, anchorRect = null }) {
    closeCard();
    const { card, bd } = cardShell("Send");
    const dest = el("select", { "aria-label": "Where it goes" });
    const newName = el("input", { placeholder: "Name", style: "display:none;margin-top:8px" });
    const note = el("textarea", { placeholder: "Add a note (optional)", style: "min-height:56px;margin-top:8px" });
    const asNote = el("input", { type: "checkbox" });
    const noteTog = el("label", { class: "tog" }, asNote, document.createTextNode("As a storynote"));
    const idName = el("input", { placeholder: "Your name" });
    const idEmail = el("input", { placeholder: "Your email", type: "email" });
    const idRow = el("div", { class: "row", style: "display:none" }, idName, idEmail);
    const msg = el("div", { class: "sm", style: "margin-top:8px;min-height:16px" });
    const go = el("button", { class: "btn go", text: "Send" });
    const accounts = el("div", { class: "sm", style: "margin-top:8px" });
    bd.append(previewStrip(clips), dest, newName, note, idRow, el("div", { class: "row" }, noteTog, el("span", { class: "grow" }), go), msg, accounts);
    openCard = card;
    placeCard(card, { anchor, anchorRect });

    let state;
    const refresh = () => {
      const v = dest.value || "";
      newName.style.display = v.endsWith(":new") ? "block" : "none";
      noteTog.style.display = v.startsWith("sbm:") && !clips.every((c) => c.kind === "text") ? "flex" : "none";
      idRow.style.display = v === "brn:inbox" && state?.brnNeedsIdentity ? "flex" : "none";
    };
    async function load() {
      state = await ask({ type: "destinations" });
      dest.replaceChildren();
      const groups = new Map();
      for (const d of state.destinations) {
        if (!groups.has(d.group)) groups.set(d.group, el("optgroup", { label: d.group }));
        groups.get(d.group).append(el("option", { value: d.id, text: d.label }));
      }
      groups.forEach((g) => dest.append(g));
      dest.value = state.defaultId;
      if (state.identity) {
        idName.value = state.identity.name || "";
        idEmail.value = state.identity.email || "";
      }
      accounts.replaceChildren();
      if (!state.accounts.sbm.signedIn) accounts.append(el("a", { class: "link", text: "Sign in to Storyboardmore", onclick: () => signIn("sbm") }), document.createTextNode(" for your boards.  "));
      if (!state.accounts.brn.signedIn) accounts.append(el("a", { class: "link", text: "BRN admin sign in", onclick: () => signIn("brn") }), document.createTextNode(" for Files."));
      refresh();
    }
    async function signIn(app) {
      msg.textContent = "Opening sign-in…";
      try {
        await ask({ type: "signIn", app });
        msg.textContent = "";
        await load();
      } catch (e) {
        msg.className = "sm bad";
        msg.textContent = e.message;
      }
    }
    dest.addEventListener("change", refresh);
    go.addEventListener("click", async () => {
      go.disabled = true;
      msg.className = "sm";
      msg.textContent = "Sending…";
      try {
        const identity = idRow.style.display !== "none" ? { name: idName.value.trim(), email: idEmail.value.trim() } : undefined;
        let res;
        if (clips.length === 1) res = await ask({ type: "send", clip: clips[0], destination: dest.value, note: note.value, asNote: asNote.checked, identity, newName: newName.value });
        else {
          // Many at once: they go through the bin so each keeps its file.
          const ids = [];
          for (const c of clips) ids.push((await ask({ type: "bin:add", clip: c })).id);
          res = await ask({ type: "send", itemIds: ids, destination: dest.value, note: note.value, asNote: asNote.checked, identity, newName: newName.value });
        }
        msg.className = "sm ok";
        msg.replaceChildren(document.createTextNode(`✓ ${res.message}  `));
        if (res.openUrl) msg.append(el("a", { class: "link", text: "Open", onclick: () => ask({ type: "openTab", url: res.openUrl }) }));
        go.textContent = "Sent";
        setTimeout(() => openCard === card && closeCard(), 4500);
      } catch (e) {
        go.disabled = false;
        msg.className = "sm bad";
        msg.textContent = e.message;
      }
    });
    try {
      await load();
    } catch (e) {
      msg.className = "sm bad";
      msg.textContent = e.message;
    }
  }

  // ---------- modes: shared click capture ----------
  const swallow = (e) => {
    if (ours(e)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  function captureClicks(onClick) {
    const types = ["pointerdown", "mousedown", "mouseup", "pointerup", "click", "dblclick", "auxclick", "contextmenu"];
    const h = (e) => {
      if (ours(e)) return;
      if (e.type === "contextmenu") return; // keep right-click menus
      swallow(e);
      if (e.type === "click") onClick(e);
    };
    types.forEach((t) => addEventListener(t, h, true));
    return () => types.forEach((t) => removeEventListener(t, h, true));
  }
  function trackBoxes(getList) {
    let raf = 0;
    const tick = () => {
      for (const { node, box } of getList()) {
        const r = node.getBoundingClientRect();
        Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, display: r.width ? "block" : "none" });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }
  function exitMode() {
    modeCleanup?.();
    modeCleanup = null;
    mode = null;
  }
  let modeCleanup = null;

  // ---------- select mode ----------
  function startSelect() {
    if (mode === "select") return exitMode();
    exitMode();
    mode = "select";
    hideChips();
    const picked = []; // { node, box }
    const count = el("span", { text: "Click any picture or video" });
    const binBtn = el("button", { class: "btn", text: "Add to bin", disabled: true });
    const sendBtn = el("button", { class: "btn", text: "Send…", disabled: true });
    const askBtn = el("button", { class: "btn go", text: "Ask…", disabled: true });
    const done = el("button", { class: "btn", text: "Done" });
    const bar = el("div", { class: "bar bottom glass" }, el("span", { class: "badge", text: "SELECT" }), count, binBtn, sendBtn, askBtn, done);
    layer.append(bar);
    const update = () => {
      picked.forEach((p, i) => (p.box.querySelector(".n").textContent = String(i + 1)));
      count.textContent = picked.length ? `${picked.length} selected` : "Click any picture or video";
      [binBtn, sendBtn, askBtn].forEach((b) => (b.disabled = !picked.length));
    };
    const stopBoxes = trackBoxes(() => picked);
    const release = captureClicks((e) => {
      const m = mediaAt(e.clientX, e.clientY);
      if (!m) return;
      const at = picked.findIndex((p) => p.node === m);
      if (at >= 0) {
        hide(picked[at].box);
        picked.splice(at, 1);
      } else {
        const box = el("div", { class: "box sel" }, el("span", { class: "n" }));
        layer.append(box);
        picked.push({ node: m, box });
      }
      update();
    });
    const clips = async () => Promise.all(picked.map((p) => clipFor(p.node)));
    binBtn.addEventListener("click", async () => {
      const list = await clips();
      for (const c of list) await ask({ type: "bin:add", clip: c }).catch(() => {});
      toast(`${list.length} added to your bin`, { label: "Open bin", run: () => ask({ type: "openPanel", tab: "bin" }) });
      exitMode();
    });
    sendBtn.addEventListener("click", async () => {
      const list = await clips();
      exitMode();
      openSend({ clips: list });
    });
    askBtn.addEventListener("click", async () => {
      const list = await clips();
      exitMode();
      openComposer({ clips: list });
    });
    done.addEventListener("click", exitMode);
    const onKey = (e) => e.key === "Escape" && exitMode();
    addEventListener("keydown", onKey, true);
    modeCleanup = () => {
      release();
      stopBoxes();
      picked.forEach((p) => hide(p.box));
      hide(bar);
      removeEventListener("keydown", onKey, true);
    };
  }

  // ---------- code picker ----------
  function cssPath(node) {
    if (!(node instanceof Element)) return null;
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return `#${CSS.escape(node.id)}`;
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && n !== document.documentElement && parts.length < 10) {
      let part = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (sib.length > 1) part += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(part);
      const sel = parts.join(" > ");
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* keep climbing */
      }
      n = n.parentElement;
    }
    return parts.join(" > ");
  }
  const labelOf = (n) => {
    const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("") : "";
    return `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${cls}`;
  };

  const undo = []; // { label, revert }
  function pushUndo(label, revert) {
    undo.push({ label, revert });
    if (undo.length > 200) undo.shift();
  }

  function startPick() {
    if (mode === "pick") return exitMode();
    const wasEye = mode === "eye";
    exitMode();
    mode = "pick";
    hideChips();
    const box = el("div", { class: "box" });
    const tag = el("div", { class: "tag" });
    layer.append(box, tag);
    let current = null;
    const show = (n) => {
      const r = n.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`, display: "block" });
      tag.textContent = `${labelOf(n)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      tag.style.left = `${Math.max(4, r.left)}px`;
      tag.style.top = `${r.top > 24 ? r.top - 22 : r.bottom + 4}px`;
    };
    const onMove = (e) => {
      if (ours(e)) return;
      const n = document.elementFromPoint(e.clientX, e.clientY);
      if (n && n !== host && n !== current) {
        current = n;
        show(n);
      }
    };
    addEventListener("mousemove", onMove, true);
    const release = captureClicks((e) => {
      const n = document.elementFromPoint(e.clientX, e.clientY);
      if (!n || n === host) return;
      exitMode();
      openInspector(n);
    });
    const hint = el("div", { class: "bar top glass" }, el("span", { class: "badge", text: "PICK" }), el("span", { text: "Click any part of the page · Esc to stop" }), el("button", { class: "btn", text: "Stop", onclick: () => exitMode() }));
    layer.append(hint);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        exitMode();
        if (wasEye) startEye();
      }
    };
    addEventListener("keydown", onKey, true);
    modeCleanup = () => {
      release();
      removeEventListener("mousemove", onMove, true);
      removeEventListener("keydown", onKey, true);
      hide(box);
      hide(tag);
      hide(hint);
    };
  }

  let inspected = null;
  function openInspector(node) {
    closeCard();
    inspected = node;
    const { card, bd } = cardShell("Piece of the page", () => {
      closeCard();
      hide(ibox);
      inspected = null;
    });
    card.style.width = "420px";
    const ibox = el("div", { class: "box" });
    layer.append(ibox);
    // Outline follows the element while this card is open; gone as soon as it closes (✕, Esc or another card).
    const follow = () => {
      if (openCard !== card || !inspected?.isConnected) return hide(ibox);
      const r = inspected.getBoundingClientRect();
      Object.assign(ibox.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, display: "block" });
      requestAnimationFrame(follow);
    };
    const crumbs = el("div", { class: "crumbs" });
    const code = el("textarea", { class: "mono", spellcheck: "false", style: "min-height:180px;max-height:46vh" });
    const msg = el("div", { class: "sm", style: "margin-top:6px;min-height:15px" });
    const promptBox = el("textarea", { placeholder: "Ask the agent to change or use this piece…", style: "min-height:56px;margin-top:10px" });
    const fill = () => {
      crumbs.replaceChildren();
      const chain = [];
      for (let n = inspected; n && n.nodeType === 1 && chain.length < 7; n = n.parentElement) chain.unshift(n);
      for (const n of chain) crumbs.append(el("button", { class: n === inspected ? "cur" : "", text: labelOf(n), onclick: () => ((inspected = n), fill()) }));
      const html = inspected.outerHTML;
      code.value = html.length > 60000 ? html.slice(0, 60000) + "\n<!-- … cut at 60k characters -->" : html;
      msg.textContent = cssPath(inspected) || "";
    };
    const apply = () => {
      const target = inspected;
      const before = target.outerHTML;
      const parent = target.parentNode;
      const next = target.nextSibling;
      try {
        const tpl = document.createElement("template");
        tpl.innerHTML = code.value;
        const nodes = [...tpl.content.childNodes];
        target.replaceWith(...nodes);
        const first = nodes.find((n) => n.nodeType === 1);
        pushUndo("Edit HTML", () => {
          nodes.forEach((n) => n.remove());
          const t2 = document.createElement("template");
          t2.innerHTML = before;
          parent.insertBefore(t2.content, next);
        });
        if (first) {
          inspected = first;
          fill();
        }
        msg.className = "sm ok";
        msg.textContent = "Applied — it lasts until the page reloads.";
      } catch (e) {
        msg.className = "sm bad";
        msg.textContent = e.message;
      }
    };
    const element = () => ({ selector: cssPath(inspected), label: labelOf(inspected), html: inspected.outerHTML.slice(0, 40000), styles: keyStyles(inspected) });
    const go = el("button", {
      class: "btn go",
      text: "Ask agent",
      onclick: async () => {
        const prompt = promptBox.value.trim();
        if (!prompt) return promptBox.focus();
        go.disabled = true;
        try {
          await ask({ type: "agent:run", prompt, element: element(), includePage: true });
          msg.className = "sm ok";
          msg.textContent = "The agent is on it — watch the card at the bottom right.";
        } catch (e) {
          msg.className = "sm bad";
          msg.textContent = e.message;
        }
        go.disabled = false;
      },
    });
    bd.append(
      crumbs,
      code,
      msg,
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn", text: "Apply", onclick: apply }),
        el("button", { class: "btn", text: "Copy", onclick: () => navigator.clipboard.writeText(code.value).then(() => ((msg.className = "sm ok"), (msg.textContent = "Copied."))) }),
        el("button", { class: "btn", text: "＋ Bin", onclick: () => addToBin({ kind: "code", text: inspected.outerHTML.slice(0, 200000), selector: cssPath(inspected), title: `${labelOf(inspected)} · ${document.title}`, ...pageMeta() }) }),
        el("button", { class: "btn", text: "Pick another", onclick: () => (closeCard(), hide(ibox), startPick()) }),
      ),
      promptBox,
      el("div", { class: "row" }, el("span", { class: "sm grow", text: "⌘↵ to run" }), go),
    );
    promptBox.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && go.click());
    fill();
    openCard = card;
    placeCard(card, { anchor: null });
    follow();
  }
  function keyStyles(n) {
    const cs = getComputedStyle(n);
    const keys = ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "border", "border-radius", "box-shadow", "gap", "flex-direction", "justify-content", "align-items", "grid-template-columns", "opacity", "transform"];
    return Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(k)]).filter(([, v]) => v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px"));
  }

  // ---------- Eye mode ----------
  function startEye() {
    if (mode === "eye") return stopEye(true);
    exitMode();
    closeCard();
    mode = "eye";
    hideChips();
    const prevDesign = document.designMode;
    document.designMode = "on";
    const sbox = el("div", { class: "box" });
    sbox.style.display = "none";
    layer.append(sbox);
    let selected = null;
    const mini = el("div", { class: "mini glass", style: "display:none" });
    layer.append(mini);
    const placeMini = () => {
      if (!selected?.isConnected) {
        mini.style.display = "none";
        sbox.style.display = "none";
        return;
      }
      const r = selected.getBoundingClientRect();
      Object.assign(sbox.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px`, display: "block" });
      mini.style.display = "flex";
      const top = r.top > 40 ? r.top - 36 : r.bottom + 6;
      mini.style.top = `${Math.min(innerHeight - 40, top)}px`;
      mini.style.left = `${Math.max(8, Math.min(innerWidth - mini.offsetWidth - 8, r.left))}px`;
    };
    let raf = 0;
    const loop = () => {
      placeMini();
      raf = requestAnimationFrame(loop);
    };
    loop();
    const select = (n) => {
      selected = n && n !== document.body && n !== document.documentElement ? n : null;
      mini.replaceChildren(
        el("button", { text: "↑ Parent", onclick: () => selected?.parentElement && select(selected.parentElement) }),
        el("button", {
          text: "Duplicate",
          onclick: () => {
            if (!selected) return;
            const copy = selected.cloneNode(true);
            selected.after(copy);
            pushUndo("Duplicate", () => copy.remove());
            select(copy);
          },
        }),
        el("button", {
          text: "Remove",
          onclick: () => {
            if (!selected) return;
            const n2 = selected, parent = n2.parentNode, next = n2.nextSibling;
            n2.remove();
            pushUndo("Remove", () => parent.insertBefore(n2, next));
            select(null);
          },
        }),
        el("button", { text: "Code", onclick: () => selected && (stopEye(false), openInspector(selected)) }),
      );
    };
    // Plain click: put the caret there (designMode) and select the element. Alt-drag: move it.
    let drag = null;
    const onDown = (e) => {
      if (ours(e)) return;
      const n = document.elementFromPoint(e.clientX, e.clientY);
      if (!n || n === host) return;
      if (e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const prev = n.style.translate;
        const [px = 0, py = 0] = (prev || "0 0").split(" ").map((v) => parseFloat(v) || 0);
        drag = { n, x: e.clientX, y: e.clientY, px, py, prev };
        select(n);
        return;
      }
      select(n);
    };
    const onMoveDrag = (e) => {
      if (!drag) return;
      e.preventDefault();
      drag.n.style.translate = `${drag.px + e.clientX - drag.x}px ${drag.py + e.clientY - drag.y}px`;
    };
    const onUp = () => {
      if (!drag) return;
      const { n, prev } = drag;
      pushUndo("Move", () => (n.style.translate = prev));
      drag = null;
    };
    const onClickLink = (e) => {
      if (ours(e)) return;
      if (e.target.closest?.("a[href]")) e.preventDefault();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        select(null);
        mini.style.display = "none";
      }
      if ((e.key === "Backspace" || e.key === "Delete") && e.shiftKey && selected) {
        e.preventDefault();
        mini.querySelector("button:nth-child(3)")?.click();
      }
    };
    addEventListener("mousedown", onDown, true);
    addEventListener("mousemove", onMoveDrag, true);
    addEventListener("mouseup", onUp, true);
    addEventListener("click", onClickLink, true);
    addEventListener("keydown", onKey, true);
    const bar = el(
      "div",
      { class: "bar bottom glass" },
      el("span", { class: "badge", text: "EYE MODE" }),
      el("span", { class: "sm", text: "Type anywhere · ⌥-drag to move · click, then Remove" }),
      el("button", { class: "btn", text: "Undo", onclick: () => undoLast() }),
      el("button", { class: "btn", text: "Pick code", onclick: () => (stopEye(false), startPick()) }),
      el("button", { class: "btn", text: "Restore page", onclick: () => location.reload() }),
      el("button", { class: "btn go", text: "Done", onclick: () => stopEye(true) }),
    );
    layer.append(bar);
    modeCleanup = () => {
      document.designMode = prevDesign === "on" ? "on" : "off";
      cancelAnimationFrame(raf);
      removeEventListener("mousedown", onDown, true);
      removeEventListener("mousemove", onMoveDrag, true);
      removeEventListener("mouseup", onUp, true);
      removeEventListener("click", onClickLink, true);
      removeEventListener("keydown", onKey, true);
      hide(bar);
      hide(sbox);
      hide(mini);
    };
    toast("Eye mode on — the whole page is yours to edit.");
  }
  function stopEye(say) {
    if (mode !== "eye") return;
    exitMode();
    if (say) toast("Edits stay until you reload the page.", { label: "Restore now", run: () => location.reload() });
  }
  function undoLast() {
    const u = undo.pop();
    if (!u) {
      // Typing is undone by the browser itself.
      document.execCommand?.("undo");
      return;
    }
    try {
      u.revert();
      toast(`Undid: ${u.label}`);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---------- agent run cards ----------
  const runsBox = el("div", { class: "runs" });
  layer.append(runsBox);
  const runCards = new Map();
  function renderRun(run) {
    let card = runCards.get(run.id);
    if (!card) {
      card = el("div", { class: "run glass" });
      runCards.set(run.id, card);
      runsBox.prepend(card);
    }
    const texts = run.events.filter((e) => e.kind === "text").map((e) => e.text);
    const lastTool = [...run.events].reverse().find((e) => e.kind === "tool" || e.kind === "status");
    const body = run.status === "done" ? run.result || texts.join("\n\n") : run.status === "error" || run.status === "stopped" ? run.error : texts.join("\n\n").trim().slice(-900);
    const live = run.status === "running" || run.status === "starting";
    // (filtered: replaceChildren would print an empty slot as the word "null")
    card.replaceChildren(...[
      el("div", { class: "row", style: "margin:0" }, el("span", { class: `pillst ${run.status}`, text: run.status === "starting" ? "starting" : run.status }), el("span", { class: "p grow", text: run.prompt }), el("button", { class: "x", text: "×", title: "Hide", onclick: () => (hide(card), runCards.delete(run.id)) })),
      body ? el("div", { class: "out", text: body }) : null,
      live && lastTool ? el("div", { class: "act", text: lastTool.kind === "tool" ? `→ ${lastTool.name} ${JSON.stringify(lastTool.input || {}).slice(0, 120)}` : lastTool.text }) : null,
      el(
        "div",
        { class: "row", style: "margin-top:8px" },
        live ? el("button", { class: "btn", text: "Stop", onclick: () => ask({ type: "agent:stop", runId: run.id }) }) : null,
        el("button", { class: "btn", text: "Open in panel", onclick: () => ask({ type: "openPanel", tab: "agents" }) }),
        el("span", { class: "grow" }),
        run.costUsd != null ? el("span", { class: "sm", text: `$${run.costUsd.toFixed(3)}` }) : null,
      ),
    ].filter(Boolean));
    if (!live) setTimeout(() => {
      if (runCards.get(run.id) === card && !card.matches(":hover")) {
        hide(card);
        runCards.delete(run.id);
      }
    }, 60000);
  }

  // ---------- the agent's page tools ----------
  function trimHtml(rootNode, max) {
    const clone = rootNode.cloneNode(true);
    clone.querySelectorAll?.("script, style, noscript").forEach((s) => {
      if ((s.textContent || "").length > 300) s.textContent = `/* ${s.textContent.length} chars */`;
    });
    clone.querySelectorAll?.("svg path").forEach((p) => p.getAttribute("d")?.length > 120 && p.setAttribute("d", "…"));
    clone.querySelectorAll?.("eye-ui").forEach((n) => n.remove());
    const html = clone.outerHTML || "";
    return html.length > max ? html.slice(0, max) + `\n<!-- cut at ${max} of ${html.length} characters -->` : html;
  }
  function pageRead({ part = "text", selector, maxChars }) {
    const max = Math.min(Math.max(Number(maxChars) || 30000, 500), 200000);
    const pick = () => {
      if (!selector) return null;
      const n = document.querySelector(selector);
      if (!n) throw new Error(`Nothing on the page matches ${selector}`);
      return n;
    };
    switch (part) {
      case "html":
        return { text: trimHtml(pick() || document.documentElement, max) };
      case "selection":
        return { text: String(getSelection() || "") || "(nothing is highlighted)" };
      case "element": {
        const n = pick() || inspected;
        if (!n) throw new Error("No element picked — pass a selector.");
        const r = n.getBoundingClientRect();
        return { text: JSON.stringify({ selector: cssPath(n), box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, styles: keyStyles(n), html: trimHtml(n, max) }, null, 1) };
      }
      case "links": {
        const links = [...document.querySelectorAll("a[href]")].slice(0, 400).map((a) => `${(a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 80)} → ${a.href}`);
        return { text: links.join("\n") || "(no links)" };
      }
      default: {
        const n = pick() || document.body;
        const t = (n.innerText || "").replace(/\n{3,}/g, "\n\n");
        return { text: t.length > max ? t.slice(0, max) + `\n… (${t.length} characters in all)` : t };
      }
    }
  }
  function pageEdit({ selector, action, value, attribute, position = "append", all = false }) {
    if (!selector) throw new Error("Give a CSS selector.");
    const nodes = all ? [...document.querySelectorAll(selector)] : [document.querySelector(selector)].filter(Boolean);
    if (!nodes.length) throw new Error(`Nothing on the page matches ${selector}`);
    for (const n of nodes) {
      const parent = n.parentNode, next = n.nextSibling;
      switch (action) {
        case "replace_html": {
          const tpl = document.createElement("template");
          tpl.innerHTML = value ?? "";
          const kids = [...tpl.content.childNodes];
          n.replaceWith(...kids);
          pushUndo("Agent edit", () => (kids.forEach((k) => k.remove()), parent.insertBefore(n, next)));
          break;
        }
        case "set_text": {
          const prev = n.innerHTML;
          n.textContent = value ?? "";
          pushUndo("Agent text", () => (n.innerHTML = prev));
          break;
        }
        case "set_style": {
          const prev = n.getAttribute("style");
          n.style.cssText += ";" + (value ?? "");
          pushUndo("Agent style", () => (prev == null ? n.removeAttribute("style") : n.setAttribute("style", prev)));
          break;
        }
        case "set_attribute": {
          if (!attribute) throw new Error("Say which attribute.");
          const prev = n.getAttribute(attribute);
          if (value == null) n.removeAttribute(attribute);
          else n.setAttribute(attribute, value);
          pushUndo("Agent attribute", () => (prev == null ? n.removeAttribute(attribute) : n.setAttribute(attribute, prev)));
          break;
        }
        case "insert_html": {
          const where = { before: "beforebegin", after: "afterend", prepend: "afterbegin", append: "beforeend" }[position] || "beforeend";
          const tpl = document.createElement("template");
          tpl.innerHTML = value ?? "";
          const kids = [...tpl.content.childNodes];
          if (where === "beforebegin") n.before(...kids);
          else if (where === "afterend") n.after(...kids);
          else if (where === "afterbegin") n.prepend(...kids);
          else n.append(...kids);
          pushUndo("Agent insert", () => kids.forEach((k) => k.remove()));
          break;
        }
        case "remove":
          n.remove();
          pushUndo("Agent remove", () => parent.insertBefore(n, next));
          break;
        case "hide": {
          const prev = n.style.display;
          n.style.display = "none";
          pushUndo("Agent hide", () => (n.style.display = prev));
          break;
        }
        default:
          throw new Error(`Unknown action ${action}`);
      }
    }
    return { text: `Changed ${nodes.length} element${nodes.length === 1 ? "" : "s"} (${action}). It lasts until the page reloads.` };
  }

  function pageContext() {
    const t = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    return { url: location.href, title: document.title, text: t.slice(0, 15000), selection: String(getSelection() || "").slice(0, 5000) || null };
  }

  function mapCollect() {
    const links = new Set();
    document.querySelectorAll("a[href], link[rel=alternate][href], area[href], [data-href], form[action]").forEach((a) => {
      const raw = a.getAttribute("href") || a.getAttribute("data-href") || a.getAttribute("action");
      const u = abs(raw);
      if (u && u.startsWith(location.origin)) links.add(u);
    });
    const scripts = new Set([...document.scripts].map((s) => s.src).filter(Boolean));
    for (const r of performance.getEntriesByType("resource")) {
      if (r.initiatorType === "script" || /\.m?js(\?|$)/.test(r.name)) scripts.add(r.name);
    }
    document.querySelectorAll('link[rel="modulepreload"][href], link[rel="preload"][as="script"][href]').forEach((l) => scripts.add(abs(l.getAttribute("href"))));
    const inline = new Set();
    let budget = 3_000_000;
    for (const s of document.scripts) {
      if (s.src || budget <= 0) continue;
      const t = (s.textContent || "").slice(0, budget);
      budget -= t.length;
      for (const m of t.matchAll(/["'`](\/[A-Za-z0-9_\-./:$[\]{}*@~%+]{1,139})["'`]/g)) inline.add(m[1]);
    }
    return { origin: location.origin, url: location.href, links: [...links].slice(0, 5000), scripts: [...scripts].filter(Boolean), inlineRoutes: [...inline].slice(0, 5000) };
  }

  // ---------- context menu helpers ----------
  function findMedia(srcUrl) {
    if (!srcUrl) return null;
    for (const n of document.querySelectorAll("img, video")) {
      if (n.currentSrc === srcUrl || n.src === srcUrl || n.querySelector?.(`source[src="${CSS.escape(srcUrl)}"]`)) return n;
    }
    return null;
  }
  async function clipFromMenu(info) {
    if (info.selectionText) return selectionClip(info.selectionText);
    if (info.srcUrl && (info.mediaType === "image" || info.mediaType === "video")) {
      const n = findMedia(info.srcUrl);
      if (n) return clipFor(n);
      return info.mediaType === "image" ? { kind: "image", src: info.srcUrl, title: document.title, ...pageMeta() } : { kind: "video", src: info.srcUrl, url: location.href, title: document.title, ...pageMeta() };
    }
    if (info.mediaType === "video") {
      const v = [...document.querySelectorAll("video")].find(bigEnough);
      if (v) return clipFor(v);
    }
    if (info.linkUrl) return { kind: "link", url: info.linkUrl, title: info.linkUrl, ...pageMeta() };
    return pageClip();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    const run = async () => {
      switch (msg?.type) {
        case "ping":
          return { ok: true };
        case "menu": {
          const a = msg.action;
          if (a === "eye-mode") return startEye(), { ok: true };
          if (a === "pick-code") return startPick(), { ok: true };
          if (a === "select-media") return startSelect(), { ok: true };
          const clip = await clipFromMenu(msg.info || {});
          if (a === "bin") await addToBin(clip);
          else if (a === "ask") openComposer({ clips: clip.kind === "page" ? [] : [clip] });
          else if (a === "send") openSend({ clips: [clip] });
          return { ok: true };
        }
        case "tool":
          if (msg.name === "page_read") return pageRead(msg.args || {});
          if (msg.name === "page_edit") return pageEdit(msg.args || {});
          if (msg.name === "notify") {
            toast(String(msg.args?.message || "").slice(0, 300));
            return { text: "Shown to the person." };
          }
          throw new Error(`Unknown page tool ${msg.name}`);
        case "page:context":
          return pageContext();
        case "map:collect":
          return mapCollect();
        case "agent:update":
          renderRun(msg.run);
          return { ok: true };
        case "open-composer":
          openComposer({ itemIds: msg.itemIds || [] });
          return { ok: true };
        default:
          return { ok: false };
      }
    };
    run()
      .then(reply)
      .catch((e) => reply({ error: e?.message || String(e) }));
    return true;
  });
})();
