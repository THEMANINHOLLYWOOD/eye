// The service-worker half every clipper shares: right-click menus, keyboard
// shortcuts, the message router the page UI and popup talk to, and the media
// plumbing (download bytes with the extension's host access, so CORS never
// gets in the way). Each extension plugs in an `adapter` that knows where a
// clip goes (a storyboard, the admin's Files, an inbox...).

const SETTINGS = "clipper.settings";
const DEFAULTS = { hoverButtons: true, selectionPill: true, lastDestination: null, identity: null };

export async function getSettings() {
  const got = (await chrome.storage.local.get(SETTINGS))[SETTINGS] ?? {};
  return { ...DEFAULTS, ...got };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

export function extFromMime(mime = "") {
  const m = mime.split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    "image/svg+xml": "svg", "image/heic": "heic", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg",
    "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md",
  };
  return map[m] || "";
}

export function mimeFromName(name = "") {
  const ext = name.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif",
    svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf",
  };
  return map[ext] || "";
}

export function safeName(name, fallback = "clip") {
  const n = (name || fallback).replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(-80);
  return n || fallback;
}

function nameFromUrl(url, mime, base = "clip") {
  let n = "";
  try {
    const u = new URL(url);
    n = decodeURIComponent(u.pathname.split("/").pop() || "");
  } catch {
    /* data: or junk */
  }
  n = n.replace(/\.(php|aspx?|jsp)$/i, "");
  const ext = extFromMime(mime);
  if (!n || !/\.[a-z0-9]{2,5}$/i.test(n)) n = `${n || base}${ext ? "." + ext : ""}`;
  return n;
}

/** Turn a clip into bytes: a data URL from the page, or a download done here. */
export async function clipBytes(clip, maxBytes) {
  if (clip.dataUrl) {
    const blob = await (await fetch(clip.dataUrl)).blob();
    const mime = blob.type || "image/png";
    return { blob, mime, size: blob.size, name: clip.fileName || `${clip.kind}-${Date.now()}.${extFromMime(mime) || "png"}` };
  }
  const src = clip.src;
  if (!src || !/^https?:/i.test(src)) return null;
  let r = null;
  for (const credentials of ["include", "omit"]) {
    try {
      r = await fetch(src, { credentials, redirect: "follow", cache: "force-cache" });
      if (r.ok) break;
    } catch {
      r = null;
    }
  }
  if (!r || !r.ok) {
    const e = new Error("Couldn't download that file from the site.");
    e.code = "FETCH_FAILED";
    throw e;
  }
  const len = Number(r.headers.get("content-length") || 0);
  if (maxBytes && len > maxBytes) {
    const e = new Error(`That file is ${(len / 1048576).toFixed(0)} MB — over the ${(maxBytes / 1048576).toFixed(0)} MB limit.`);
    e.code = "TOO_BIG";
    throw e;
  }
  const blob = await r.blob();
  if (maxBytes && blob.size > maxBytes) {
    const e = new Error(`That file is over the ${(maxBytes / 1048576).toFixed(0)} MB limit.`);
    e.code = "TOO_BIG";
    throw e;
  }
  let mime = (blob.type || r.headers.get("content-type") || "").split(";")[0];
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") mime = mimeFromName(src) || mime || "application/octet-stream";
  if (/^text\/html/.test(mime) && (clip.kind === "image" || clip.kind === "video")) {
    const e = new Error("The site sent a web page instead of the file.");
    e.code = "FETCH_FAILED";
    throw e;
  }
  return { blob, mime, size: blob.size, name: clip.fileName || nameFromUrl(r.url || src, mime, clip.kind) };
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    if (pong?.ok) return true;
  } catch {
    /* not there yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["config.js", "lib/content.js"] });
    return true;
  } catch {
    return false;
  }
}

async function toTab(tab, msg) {
  if (!tab?.id || RESTRICTED.test(tab.url || "")) return false;
  if (!(await ensureContent(tab.id))) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, msg, { frameId: 0 });
    return true;
  } catch {
    return false;
  }
}

function notify(config, title, message) {
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: title || config.name,
    message: message || "",
    priority: 0,
  });
}

async function flashBadge(ok) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#16a34a" : "#dc2626" });
    await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  } catch {
    /* fine */
  }
}

export function startClipper({ config, adapter, auth }) {
  const L = config.labels;

  function buildMenus() {
    chrome.contextMenus.removeAll(() => {
      const add = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
      add("clip-image", L.menuImage, ["image"]);
      add("clip-video", L.menuVideo, ["video"]);
      add("clip-frame", L.menuFrame, ["video"]);
      add("clip-audio", L.menuAudio, ["audio"]);
      add("clip-selection", L.menuSelection, ["selection"]);
      add("clip-link", L.menuLink, ["link"]);
      add("clip-page", L.menuPage, ["page"]);
      chrome.contextMenus.create({ id: "sep", type: "separator", contexts: ["page", "image", "video", "selection", "link"] });
      add("clip-area", L.menuArea, ["page", "image", "video", "selection", "link"]);
      add("clip-grab", L.menuGrab, ["page", "image"]);
    });
  }

  chrome.runtime.onInstalled.addListener(buildMenus);
  chrome.runtime.onStartup.addListener(buildMenus);

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const action = String(info.menuItemId).replace(/^clip-/, "");
    const sent = await toTab(tab, {
      type: "menu",
      action,
      info: {
        srcUrl: info.srcUrl ?? null,
        linkUrl: info.linkUrl ?? null,
        selectionText: info.selectionText ?? null,
        pageUrl: info.pageUrl ?? tab?.url ?? null,
        frameUrl: info.frameUrl ?? null,
        mediaType: info.mediaType ?? null,
        inFrame: (info.frameId ?? 0) !== 0,
      },
    });
    if (sent) return;
    // Pages we can't draw on (chrome://, the Web Store): save straight away.
    try {
      const clip =
        action === "image" && info.srcUrl
          ? { kind: "image", src: info.srcUrl, pageUrl: tab?.url, pageTitle: tab?.title }
          : action === "link" && info.linkUrl
            ? { kind: "link", url: info.linkUrl, title: info.linkUrl, pageUrl: tab?.url, pageTitle: tab?.title }
            : action === "selection" && info.selectionText
              ? { kind: "text", text: info.selectionText, pageUrl: tab?.url, pageTitle: tab?.title }
              : { kind: "page", url: tab?.url, title: tab?.title, pageUrl: tab?.url, pageTitle: tab?.title };
      const res = await saveClip(clip, {});
      notify(config, L.saved, res.message);
      flashBadge(true);
    } catch (e) {
      notify(config, L.failed, e.message);
      flashBadge(false);
    }
  });

  chrome.commands.onCommand.addListener(async (command, tab) => {
    tab = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const action = { "clip-selection": "selection-or-page", "capture-frame": "frame", "screenshot-area": "area" }[command];
    if (action) await toTab(tab, { type: "menu", action, info: { pageUrl: tab?.url, fromShortcut: true } });
  });

  async function saveClip(clip, opts) {
    let bytes = null;
    const needsBytes = ["image", "video", "audio", "frame", "screenshot", "file"].includes(clip.kind);
    if (needsBytes && (clip.dataUrl || clip.src)) {
      try {
        bytes = await clipBytes(clip, config.maxUploadBytes);
      } catch (e) {
        // Videos that can't be downloaded (streams, huge files) still save as a link to where they play.
        if (clip.kind === "video" && (e.code === "TOO_BIG" || e.code === "FETCH_FAILED")) bytes = null;
        else throw e;
      }
    }
    const res = await adapter.save(clip, bytes, opts);
    if (opts.destinationId) await setSettings({ lastDestination: opts.destinationId });
    flashBadge(true);
    return res;
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const run = async () => {
      switch (msg?.type) {
        case "state": {
          const [state, settings] = await Promise.all([adapter.destinations(), getSettings()]);
          return { ...state, settings, brand: { name: config.name, appUrl: config.appUrl } };
        }
        case "signIn":
          await auth.signIn();
          return { ok: true };
        case "signOut":
          await auth.signOut();
          return { ok: true };
        case "save":
          return await saveClip(msg.clip, msg.opts ?? {});
        case "createDestination":
          return await adapter.createDestination(msg.name);
        case "settings":
          return msg.patch ? await setSettings(msg.patch) : await getSettings();
        case "captureVisible": {
          const windowId = sender.tab?.windowId;
          const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
          return { dataUrl };
        }
        case "openTab":
          await chrome.tabs.create({ url: msg.url });
          return { ok: true };
        case "startOnTab": {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const ok = await toTab(tab, { type: "menu", action: msg.action, info: { pageUrl: tab?.url } });
          return { ok, restricted: !ok };
        }
        default:
          return { error: "unknown message" };
      }
    };
    run()
      .then((r) => reply(r))
      .catch((e) => reply({ error: e?.message || String(e), code: e?.code ?? null }));
    return true;
  });

  return { saveClip };
}
