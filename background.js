// Eye — service worker.
//
// - Bin: everything you grab lands in an IndexedDB "bin" (files kept as Blobs,
//   so a picture survives the page that showed it).
// - Send: to a Storyboardmore board or BRN admin, through the same save code
//   the clippers use (lib/adapters), signed in to each app separately.
// - Agent: talks to eye-helper on this Mac over a local WebSocket. The helper
//   runs Claude Code; when the agent wants to read or change the page, save
//   something or take a screenshot, the helper relays a tool call here.
// - Site map: collects every path a site exposes (links, robots.txt,
//   sitemaps, and route strings inside its own JavaScript).
import "./config.js";
import { createAuth } from "./lib/oauth.js";
import { clipBytes, hostOf, extFromMime } from "./lib/bg-core.js";
import { createSbmAdapter } from "./lib/adapters/sbm.js";
import { createBrnAdapter } from "./lib/adapters/brn.js";

const C = globalThis.EYE_CONFIG;
const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

// ---------- accounts ----------
const auths = {
  sbm: createAuth({ supabaseUrl: C.sbm.supabaseUrl, anonKey: C.sbm.anonKey, clientName: "Eye (Chrome)", storeKey: "eye.auth.sbm" }),
  brn: createAuth({ supabaseUrl: C.brn.supabaseUrl, anonKey: C.brn.anonKey, clientName: "Eye (Chrome)", storeKey: "eye.auth.brn" }),
};

// ---------- settings ----------
const SETTINGS = "eye.settings";
const DEFAULTS = { hoverChips: true, selectionPill: true, allowCommands: false, model: "", identity: null, lastDestination: null };
async function getSettings() {
  return { ...DEFAULTS, ...((await chrome.storage.local.get(SETTINGS))[SETTINGS] ?? {}) };
}
async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS]: next });
  return next;
}

const adapters = {
  sbm: createSbmAdapter({ config: C.sbm, auth: auths.sbm, via: "eye" }),
  brn: createBrnAdapter({
    config: C.brn,
    auth: auths.brn,
    source: "Eye extension",
    toolName: "Eye",
    getIdentity: async () => (await getSettings()).identity,
    saveIdentity: (identity) => setSettings({ identity }),
  }),
};

// ---------- small helpers ----------
const broadcast = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || "application/octet-stream"};base64,${toBase64(buf)}`;
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64, mime) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime || "application/octet-stream" });
}

async function thumbOf(blob) {
  try {
    if (!blob?.type?.startsWith("image/") || /svg/.test(blob.type)) return null;
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 420 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return { thumb: await blobToDataUrl(await c.convertToBlob({ type: "image/jpeg", quality: 0.8 })), ...d };
  } catch {
    return null;
  }
}

async function fetchBlob(url, maxBytes = 25 * 1024 * 1024) {
  if (!/^https?:/i.test(url || "")) return null;
  try {
    const r = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!r.ok) return null;
    const len = Number(r.headers.get("content-length") || 0);
    if (len && len > maxBytes) return null;
    const b = await r.blob();
    if (b.size > maxBytes || /^text\/html/.test(b.type)) return null;
    return b;
  } catch {
    return null;
  }
}

// ---------- bin (IndexedDB) ----------
let dbp = null;
function db() {
  return (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("eye", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("bin", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
const idbReq = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
async function store(mode) {
  return (await db()).transaction("bin", mode).objectStore("bin");
}
const binGet = async (id) => idbReq((await store("readonly")).get(id));
const binPut = async (item) => idbReq((await store("readwrite")).put(item));
const binDelete = async (id) => idbReq((await store("readwrite")).delete(id));
async function binAll() {
  const all = await idbReq((await store("readonly")).getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
/** What the panel and pages see: no Blobs (they can't cross messages). */
function publicItem(it) {
  const { blob, ...rest } = it;
  return { ...rest, hasFile: !!blob, size: blob?.size ?? null, mime: it.mime || blob?.type || null };
}

const FILE_KINDS = new Set(["image", "frame", "screenshot", "video", "file"]);

async function binAdd(clip) {
  const item = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    kind: clip.kind,
    title: (clip.title || clip.pageTitle || clip.text?.slice(0, 80) || hostOf(clip.pageUrl) || "Untitled").slice(0, 300),
    src: clip.src || null,
    url: clip.url || null,
    poster: clip.poster || null,
    text: clip.text || null,
    note: clip.note || null,
    pageUrl: clip.pageUrl || null,
    pageTitle: clip.pageTitle || null,
    siteName: clip.siteName || hostOf(clip.pageUrl) || null,
    fragmentUrl: clip.fragmentUrl || null,
    description: clip.description || null,
    selector: clip.selector || null,
    time: clip.time ?? null,
    width: clip.width || null,
    height: clip.height || null,
    fileName: clip.fileName || null,
    mime: null,
    sentTo: [],
  };
  let blob = null;
  if (clip.dataUrl) blob = await (await fetch(clip.dataUrl)).blob();
  else if (clip.fileBase64) blob = fromBase64(clip.fileBase64, clip.mime);
  else if (clip.kind === "image" && clip.src) blob = await fetchBlob(clip.src);
  if (blob) {
    item.blob = blob;
    item.mime = blob.type || null;
  }
  const t = await thumbOf(blob || (clip.kind === "video" && clip.poster ? await fetchBlob(clip.poster, 8 * 1024 * 1024) : null));
  if (t) {
    item.thumb = t.thumb;
    if (blob) {
      item.width = item.width || t.w;
      item.height = item.height || t.h;
    }
  }
  await binPut(item);
  broadcast({ type: "bin:changed" });
  return publicItem(item);
}

function itemToClip(it) {
  if (it.kind === "code") {
    return { kind: "text", quote: false, text: ["```html", it.text || "", "```"].join("\n"), title: it.title, pageUrl: it.pageUrl, pageTitle: it.pageTitle, siteName: it.siteName };
  }
  return {
    kind: it.kind,
    src: it.src,
    url: it.url,
    poster: it.poster,
    text: it.text,
    title: it.title,
    pageUrl: it.pageUrl,
    pageTitle: it.pageTitle,
    siteName: it.siteName,
    fragmentUrl: it.fragmentUrl,
    description: it.description,
    width: it.width,
    height: it.height,
    time: it.time,
    fileName: it.fileName,
  };
}

function fileNameFor(it, mime) {
  if (it.fileName) return it.fileName;
  const base = (it.title || it.kind || "eye").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "eye";
  return `${base}.${extFromMime(mime) || "bin"}`;
}

// ---------- destinations + send ----------
async function destinations() {
  const [s, b, settings] = await Promise.all([
    adapters.sbm.destinations().catch((e) => ({ signedIn: false, error: e.message, destinations: [] })),
    adapters.brn.destinations().catch((e) => ({ signedIn: false, error: e.message, destinations: [{ id: "inbox", label: "Admin inbox (Intake)" }] })),
    getSettings(),
  ]);
  const list = [];
  for (const d of s.destinations || []) list.push({ id: `sbm:${d.id}`, label: d.label, group: `Storyboardmore${d.group ? " · " + d.group : ""}` });
  if (s.signedIn) list.push({ id: "sbm:new", label: "+ New storyboard…", group: "Storyboardmore" });
  for (const d of b.destinations || []) list.push({ id: `brn:${d.id}`, label: d.label, group: `BRN${d.group ? " · " + d.group : ""}` });
  if (b.canCreate) list.push({ id: "brn:new", label: "+ New Files collection…", group: "BRN" });
  const ids = new Set(list.map((d) => d.id));
  const defaultId = settings.lastDestination && ids.has(settings.lastDestination) && !settings.lastDestination.endsWith(":new")
    ? settings.lastDestination
    : s.defaultId ? `sbm:${s.defaultId}` : `brn:${b.defaultId || "inbox"}`;
  return {
    destinations: list,
    defaultId,
    accounts: {
      sbm: { signedIn: !!s.signedIn, email: s.user?.email || null, error: s.error || null },
      brn: { signedIn: !!b.signedIn, email: b.user?.email || null, admin: !!b.admin, error: b.error || null },
    },
    brnNeedsIdentity: !!b.needsIdentity,
    identity: settings.identity,
  };
}

async function sendOne({ clip, itemId, destination, note, asNote, identity, newName }) {
  if (!destination) throw new Error("Pick where it goes.");
  const [app, ...rest] = destination.split(":");
  let destId = rest.join(":");
  const adapter = adapters[app];
  if (!adapter) throw new Error("Unknown destination.");
  if (destId === "new") {
    if (!newName?.trim()) throw new Error(app === "sbm" ? "Name the new storyboard." : "Name the new collection.");
    destId = (await adapter.createDestination(newName.trim())).id;
    destination = `${app}:${destId}`;
  }
  let bytes = null;
  let it = null;
  if (itemId) {
    it = await binGet(itemId);
    if (!it) throw new Error("That item isn't in your bin any more.");
    clip = itemToClip(it);
    if (it.blob) {
      const mime = it.mime || it.blob.type || "application/octet-stream";
      bytes = { blob: it.blob, mime, size: it.blob.size, name: fileNameFor(it, mime) };
    }
  }
  if (!clip) throw new Error("Nothing to send.");
  const max = C[app].maxUploadBytes;
  if (!bytes && FILE_KINDS.has(clip.kind) && (clip.dataUrl || clip.src)) {
    try {
      bytes = await clipBytes(clip, max);
    } catch (e) {
      // Streams and hotlink-protected files still save, as a link or linked picture.
      if (!(e.code === "TOO_BIG" || e.code === "FETCH_FAILED") || !["video", "image"].includes(clip.kind)) throw e;
    }
  }
  if (bytes && bytes.size > max) throw new Error(`That file is over the ${(max / 1048576).toFixed(0)} MB limit for ${C[app].name}.`);
  const res = await adapter.save(clip, bytes, { destinationId: destId, note, asNote, identity });
  await setSettings({ lastDestination: destination });
  if (it) {
    it.sentTo = [...(it.sentTo || []), { destination, label: res.message, openUrl: res.openUrl || null, at: Date.now() }];
    await binPut(it);
    broadcast({ type: "bin:changed" });
  }
  return { ...res, destination };
}

async function send(msg) {
  if (!msg.itemIds?.length) return sendOne(msg);
  const results = [];
  let destination = msg.destination;
  for (const itemId of msg.itemIds) {
    try {
      const r = await sendOne({ ...msg, itemId, destination });
      destination = r.destination; // "new" becomes the created board for the rest
      results.push({ itemId, ok: true, message: r.message, openUrl: r.openUrl });
    } catch (e) {
      results.push({ itemId, ok: false, error: e.message });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  return { ok: ok > 0, results, message: `${ok} of ${results.length} sent`, openUrl: results.find((r) => r.openUrl)?.openUrl || null };
}

// ---------- talking to pages ----------
async function ensureContent(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    if (pong?.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}
async function askTab(tabId, msg) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("That tab is closed.");
  if (RESTRICTED.test(tab.url || "")) throw new Error("Chrome doesn't let extensions into this kind of page.");
  if (!(await ensureContent(tabId))) throw new Error("Eye can't reach this page.");
  const res = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  if (res?.error) throw new Error(res.error);
  return res;
}
const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

// ---------- agent (eye-helper) ----------
const WS_URL = C.helperUrl.replace(/^http/, "ws") + "/ws";
const RUNS = "eye.runs";
let sock = null;
let sockReady = null;
let pingTimer = 0;
const runs = new Map(); // runId -> run
let runsLoaded = null;

function helperOffError() {
  const e = new Error("Eye's helper isn't running on this Mac. Double-click eye-helper/start.command (in the chrome extensions folder), then try again.");
  e.code = "HELPER_OFF";
  return e;
}

function loadRuns() {
  return (runsLoaded ||= chrome.storage.local.get(RUNS).then((got) => {
    for (const r of got[RUNS] || []) runs.set(r.id, r);
    // Runs that were going when the worker slept: pick their events back up.
    if ([...runs.values()].some((r) => r.status === "running" || r.status === "starting")) connectHelper().catch(() => {});
  }));
}
let saveTimer = 0;
function saveRuns() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
    chrome.storage.local.set({ [RUNS]: list });
  }, 300);
}

function runSummary(r) {
  return r;
}

// Streamed text arrives in many small pieces; tell the panel and page at most ~8 times a second.
const pushTimers = new Map();
function pushRun(r, now = false) {
  saveRuns();
  const send = () => {
    pushTimers.delete(r.id);
    broadcast({ type: "run:changed", run: runSummary(r) });
    if (r.tabId != null) chrome.tabs.sendMessage(r.tabId, { type: "agent:update", run: runSummary(r) }, { frameId: 0 }).catch(() => {});
  };
  if (now) {
    clearTimeout(pushTimers.get(r.id));
    return send();
  }
  if (!pushTimers.has(r.id)) pushTimers.set(r.id, setTimeout(send, 120));
}

function connectHelper() {
  if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(sock);
  if (sock && sock.readyState === WebSocket.CONNECTING && sockReady) return sockReady;
  sockReady = new Promise((resolve, reject) => {
    let s;
    try {
      s = new WebSocket(WS_URL);
    } catch {
      reject(helperOffError());
      return;
    }
    sock = s;
    const timer = setTimeout(() => {
      try {
        s.close();
      } catch {
        /* fine */
      }
      reject(helperOffError());
    }, 5000);
    s.onopen = () => {
      clearTimeout(timer);
      clearInterval(pingTimer);
      // Keeps the socket (and this service worker) alive while runs go.
      pingTimer = setInterval(() => s.readyState === WebSocket.OPEN && s.send(JSON.stringify({ type: "ping" })), 20000);
      broadcast({ type: "helper:changed", connected: true });
      resolve(s);
    };
    s.onerror = () => {};
    s.onclose = () => {
      clearTimeout(timer);
      clearInterval(pingTimer);
      if (sock === s) sock = null;
      broadcast({ type: "helper:changed", connected: false });
      reject(helperOffError());
      const live = [...runs.values()].filter((r) => r.status === "running" || r.status === "starting");
      if (live.length) setTimeout(() => connectHelper().catch(() => {}), 3000);
    };
    s.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      onHelperMessage(m).catch((err) => console.warn("eye helper message", err));
    };
  });
  return sockReady;
}

function sockSend(obj) {
  if (sock?.readyState !== WebSocket.OPEN) return false;
  sock.send(JSON.stringify(obj));
  return true;
}

async function helperHealth() {
  try {
    const r = await fetch(`${C.helperUrl}/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function onHelperMessage(m) {
  await loadRuns();
  if (m.type === "pong") return;
  const r = m.runId ? runs.get(m.runId) : null;
  const finish = (run, d) => {
    run.status = d.ok ? "done" : d.error === "Stopped" ? "stopped" : "error";
    run.result = d.result || null;
    run.error = d.ok ? null : d.error || "The agent stopped without an answer.";
    run.costUsd = d.costUsd ?? null;
    run.durationMs = d.durationMs ?? null;
    run.endedAt = Date.now();
    pushRun(run, true);
  };
  switch (m.type) {
    case "hello": {
      // After a reconnect: settle runs that finished while we were away, keep the live ones.
      const live = new Set((m.runs || []).map((x) => x.runId));
      for (const run of runs.values()) {
        if (run.status !== "running" && run.status !== "starting") continue;
        if (live.has(run.id)) continue;
        const done = (m.recent || []).find((d) => d.runId === run.id);
        finish(run, done || { ok: false, error: "Eye lost track of this run (the helper restarted)." });
      }
      return;
    }
    case "error":
      if (r && (r.status === "running" || r.status === "starting")) finish(r, { ok: false, error: m.error });
      return;
    case "run-started":
      if (r) {
        r.status = "running";
        r.workdir = m.workdir || null;
        pushRun(r, true);
      }
      return;
    case "event": {
      if (!r || !m.event) return;
      // Text streams in pieces (a new block starts with a blank line): join them.
      const last = r.events[r.events.length - 1];
      if (m.event.kind === "text" && last?.kind === "text") last.text += m.event.text || "";
      else r.events.push({ ...m.event, at: Date.now() });
      if (r.events.length > 400) r.events.splice(0, r.events.length - 400);
      pushRun(r);
      return;
    }
    case "run-done":
      if (r) finish(r, m);
      return;
    case "tool-call": {
      const run = r || { id: m.runId, tabId: null };
      let reply;
      try {
        reply = { type: "tool-result", callId: m.callId, ok: true, result: await runTool(run, m.name, m.args || {}) };
      } catch (e) {
        reply = { type: "tool-result", callId: m.callId, ok: false, error: e.message || String(e) };
      }
      sockSend(reply);
      return;
    }
    default:
      return;
  }
}

/** Gathers what the agent should see: the picked items (with their files) and the page. */
async function startRun({ prompt, clips = [], itemIds = [], element = null, tabId = null, includePage = true }) {
  await loadRuns();
  prompt = String(prompt || "").trim();
  if (!prompt) throw new Error("Tell the agent what you want.");
  await connectHelper();
  const settings = await getSettings();
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
  const items = [];
  const shown = [];
  for (const id of itemIds) {
    const it = await binGet(id);
    if (!it) continue;
    items.push(await agentItem(it, it.blob));
    shown.push({ id: it.id, kind: it.kind, title: it.title, thumb: it.thumb || null });
  }
  for (const clip of clips) {
    let blob = null;
    if (clip.dataUrl) blob = await (await fetch(clip.dataUrl)).blob();
    else if (clip.kind === "image" && clip.src) blob = await fetchBlob(clip.src, 20 * 1024 * 1024);
    const t = blob ? await thumbOf(blob) : null;
    const { dataUrl, ...rest } = clip;
    items.push(await agentItem({ id: crypto.randomUUID(), ...rest }, blob));
    shown.push({ id: null, kind: clip.kind, title: clip.title || clip.text?.slice(0, 60) || clip.kind, thumb: t?.thumb || null });
  }
  let page = null;
  if (tab && !RESTRICTED.test(tab.url || "")) {
    page = { url: tab.url, title: tab.title };
    if (includePage) {
      try {
        page = { ...page, ...(await askTab(tab.id, { type: "page:context" })) };
      } catch {
        /* the URL and title are enough */
      }
    }
  }
  const run = {
    id: crypto.randomUUID(),
    prompt,
    status: "starting",
    tabId: tab?.id ?? null,
    pageUrl: page?.url || null,
    pageTitle: page?.title || null,
    items: shown,
    element: element ? { selector: element.selector, label: element.label || element.selector } : null,
    events: [],
    result: null,
    error: null,
    workdir: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  runs.set(run.id, run);
  const sent = sockSend({
    type: "run",
    runId: run.id,
    prompt,
    context: { page, element },
    items,
    options: { allowCommands: !!settings.allowCommands, model: settings.model || null },
  });
  if (!sent) {
    run.status = "error";
    run.error = helperOffError().message;
  }
  pushRun(run);
  return runSummary(run);
}

async function agentItem(it, blob) {
  const out = {
    id: it.id,
    kind: it.kind === "code" ? "text" : it.kind,
    title: it.title || null,
    url: it.url || null,
    src: it.src || null,
    pageUrl: it.pageUrl || null,
    text: it.kind === "code" ? `HTML of ${it.selector || "an element"}:\n${it.text || ""}` : it.text || null,
    note: it.note || null,
    fileName: null,
    mime: null,
  };
  if (blob && blob.size <= 20 * 1024 * 1024) {
    out.mime = blob.type || "application/octet-stream";
    out.fileName = fileNameFor(it, out.mime);
    out.dataBase64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  }
  return out;
}

async function stopRun(runId) {
  await loadRuns();
  const r = runs.get(runId);
  if (!r) return { ok: false };
  if (!sockSend({ type: "stop", runId })) {
    r.status = "stopped";
    r.error = "Stopped";
    r.endedAt = Date.now();
    pushRun(r);
  }
  return { ok: true };
}

// ----- the tools the agent can use (relayed by eye-helper) -----
async function runTool(run, name, args) {
  const tabId = run.tabId;
  const needTab = () => {
    if (tabId == null) throw new Error("This run has no browser tab to work in.");
    return tabId;
  };
  switch (name) {
    case "page_read":
    case "page_edit":
    case "notify":
      if (name === "notify" && tabId == null) {
        notify("Eye", args.message);
        return { text: "Shown as a notification." };
      }
      return askTab(needTab(), { type: "tool", name, args });
    case "page_css": {
      if (!args.css) throw new Error("No CSS given.");
      await chrome.scripting.insertCSS({ target: { tabId: needTab() }, css: String(args.css) });
      return { text: "CSS added to the page (it lasts until the page reloads)." };
    }
    case "page_script":
      return runPageScript(needTab(), String(args.code || ""));
    case "page_screenshot": {
      const tab = await chrome.tabs.get(needTab());
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await new Promise((r) => setTimeout(r, 400));
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const blob = await (await fetch(dataUrl)).blob();
      const small = await shrinkForAgent(blob);
      return { text: `Screenshot of ${tab.title || tab.url}`, image: { base64: toBase64(new Uint8Array(await small.arrayBuffer())), mime: small.type } };
    }
    case "open_tab": {
      if (!/^https?:\/\//i.test(args.url || "")) throw new Error("Only http(s) addresses can be opened.");
      const t = await chrome.tabs.create({ url: args.url, active: false });
      return { text: `Opened ${args.url} in a background tab (id ${t.id}).` };
    }
    case "list_destinations": {
      const d = await destinations();
      const lines = d.destinations.filter((x) => !x.id.endsWith(":new")).map((x) => `${x.id}  —  ${x.group}: ${x.label}`);
      const acc = `Storyboardmore: ${d.accounts.sbm.signedIn ? "signed in" : "not signed in (boards unavailable)"}. BRN: ${d.accounts.brn.signedIn ? (d.accounts.brn.admin ? "signed in as admin" : "signed in") : "not signed in (admin inbox only)"}.`;
      return { text: `${acc}\nDefault: ${d.defaultId}\n${lines.join("\n") || "(none)"}` };
    }
    case "save_to": {
      const clip = await clipFromTool(run, args);
      const res = await sendOne({ clip, destination: args.destination, note: args.kind === "note" ? "" : args.text || "", asNote: args.kind === "note" });
      return { text: `${res.message}${res.openUrl ? ` — ${res.openUrl}` : ""}` };
    }
    case "bin_add": {
      const clip = await clipFromTool(run, { ...args, kind: args.fileBase64 ? (/^image\//.test(args.mime || "") ? "image" : "file") : args.url ? (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(args.url) ? "image" : "link") : "note" });
      const item = await binAdd({ ...clip, note: args.note || null });
      return { text: `Added “${item.title}” to the bin.` };
    }
    default:
      throw new Error(`Eye doesn't have a tool called ${name}.`);
  }
}

async function clipFromTool(run, args) {
  const base = { title: args.title || null, pageUrl: run.pageUrl || null, pageTitle: run.pageTitle || null, siteName: hostOf(run.pageUrl || "") || null };
  if (args.fileBase64) {
    const mime = args.mime || "application/octet-stream";
    return { ...base, kind: /^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : "file", dataUrl: `data:${mime};base64,${args.fileBase64}`, fileBase64: args.fileBase64, mime, fileName: args.fileName || null, title: args.title || args.fileName || "From Eye's agent" };
  }
  if (args.kind === "image" && args.url) return { ...base, kind: "image", src: args.url };
  if (args.kind === "link" && args.url) return { ...base, kind: "link", url: args.url, title: args.title || args.url };
  if (args.kind === "note" || args.text) return { ...base, kind: "text", quote: false, text: String(args.text || args.title || "").slice(0, 100000), title: args.title || "Note from Eye's agent" };
  if (args.url) return { ...base, kind: "link", url: args.url, title: args.title || args.url };
  throw new Error("Give text, a url or a file to save.");
}

async function shrinkForAgent(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    if (scale === 1) return blob;
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await c.convertToBlob({ type: "image/png" });
  } catch {
    return blob;
  }
}

/**
 * Runs the agent's JavaScript in the page, as the body of an async function
 * (so `return x` sends x back). User scripts skip the site's CSP when Chrome
 * allows them; otherwise plain injection.
 */
async function runPageScript(tabId, body) {
  if (!body.trim()) throw new Error("No code given.");
  const code = `(async () => {\n${body}\n})()`;
  const fmtResult = (v) => {
    if (v === undefined) return "Ran (no result).";
    try {
      return typeof v === "string" ? v.slice(0, 20000) : JSON.stringify(v, null, 1).slice(0, 20000);
    } catch {
      return String(v).slice(0, 20000);
    }
  };
  if (chrome.userScripts?.execute) {
    try {
      const [res] = await chrome.userScripts.execute({ target: { tabId }, js: [{ code }], world: "MAIN" });
      if (res?.error) throw new Error(res.error);
      return { text: fmtResult(res?.result) };
    } catch (e) {
      if (!/user ?scripts|not (allowed|enabled)|permission/i.test(e.message || "")) return { text: `Error: ${e.message}` };
      /* fall through to plain injection */
    }
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (src) => {
      try {
        // eslint-disable-next-line no-eval
        const v = await (0, eval)(src);
        return { ok: true, v: v === undefined ? undefined : typeof v === "object" ? JSON.parse(JSON.stringify(v ?? null)) : v };
      } catch (e) {
        return { ok: false, e: String(e && e.message ? e.message : e) };
      }
    },
    args: [code],
  });
  const out = res?.result;
  if (!out) return { text: "Ran (no result)." };
  if (!out.ok) {
    const csp = /unsafe-eval|Content Security Policy|EvalError/i.test(out.e);
    return { text: `Error: ${out.e}${csp ? " — this site blocks scripts. Turn on “Allow User Scripts” for Eye in chrome://extensions to get past it, or use page_edit / page_css." : ""}` };
  }
  return { text: fmtResult(out.v) };
}

// ---------- site map ----------
const ASSET = /\.(m?js|cjs|ts|tsx|jsx|css|scss|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|json|txt|xml|wasm|pdf|zip|gz|br|lottie|glb|gltf|hdr|webmanifest)$/i;
const NOISE = /^\/(_next|static|assets|_nuxt|build|dist|cdn-cgi|node_modules|webpack|__|@vite|@fs|@id|src\/|favicon|apple-touch|sw\.js|service-worker|manifest|_app|_document|_error|\.well-known\/(?!security))/i;

function normPath(p) {
  if (!p) return null;
  let s = p.trim();
  if (!s.startsWith("/") || s.startsWith("//")) return null;
  s = s.split("#")[0].split("?")[0];
  if (s.length > 140 || s.length < 1) return null;
  if (/[\s<>"'`\\^|(){},;]/.test(s.replace(/\{[A-Za-z_]\w*\}/g, ""))) return null;
  if (ASSET.test(s) || NOISE.test(s)) return null;
  if (/\/\/|\.\.|^\/[^/]*\.[a-z]{2,4}\.[a-z]/i.test(s)) return null;
  // Dynamic segments from common routers → :param
  s = s
    .replace(/\/\$([A-Za-z_]\w*)/g, "/:$1")
    .replace(/\/\$(?=\/|$)/g, "/*")
    .replace(/\/\[\.\.\.([A-Za-z_]\w*)\]/g, "/*$1")
    .replace(/\/\[\[?([A-Za-z_]\w*)\]?\]/g, "/:$1")
    .replace(/\/\{([A-Za-z_]\w*)\}/g, "/:$1");
  if (/[$[\]]/.test(s)) return null;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  // Must look like words, not a date format or a regex fragment.
  if (!/^\/([A-Za-z0-9_\-.~:*@%+]+(\/|$))*$/.test(s)) return null;
  if (/^\/(?:[a-z]{1,2}|\d+)$/i.test(s) && !/^\/(go|me|ai|ui|tv|fm|qa|hr|pr|vr|ar)$/i.test(s)) return null;
  // Date/time formats and similar ("/MM/DD/YYYY", "/HH/mm") aren't pages.
  const segs = s.split("/").filter(Boolean);
  if (segs.length > 1 && segs.every((g) => /^([A-Z]{1,4}|[a-z]|\d{1,4}|[Hhms]{1,2}|y{2,4}|d{1,2})$/.test(g))) return null;
  return s || "/";
}

function extractRoutes(text, limit = 4000) {
  const out = new Set();
  const re = /["'`](\/[A-Za-z0-9_\-./:$[\]{}*@~%+]{0,139})["'`]/g;
  let m;
  const src = text.length > 6_000_000 ? text.slice(0, 6_000_000) : text;
  while ((m = re.exec(src)) && out.size < limit) {
    const p = normPath(m[1]);
    if (p) out.add(p);
  }
  return out;
}

function sameSite(a, b) {
  const ha = hostOf(a), hb = hostOf(b);
  if (!ha || !hb) return false;
  const base = (h) => h.split(".").slice(-2).join(".");
  return base(ha) === base(hb);
}

async function fetchText(url, max = 8 * 1024 * 1024) {
  try {
    const r = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const t = await r.text();
    return t.length > max ? t.slice(0, max) : t;
  } catch {
    return null;
  }
}

async function siteMap(tabId) {
  const page = await askTab(tabId, { type: "map:collect" });
  const origin = page.origin;
  const routes = new Map();
  const add = (raw, source) => {
    let p = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        if (u.origin !== origin) return;
        p = u.pathname;
      } catch {
        return;
      }
    }
    p = normPath(p);
    if (!p) return;
    const r = routes.get(p) || { path: p, sources: [] };
    if (!r.sources.includes(source)) r.sources.push(source);
    routes.set(p, r);
  };
  add("/", "link");
  add(new URL(page.url).pathname, "link");
  page.links.forEach((u) => add(u, "link"));
  page.inlineRoutes.forEach((p) => add(p, "code"));

  // robots.txt: Allow/Disallow lines often name the private corners; Sitemap lines point at the rest.
  const sitemaps = new Set([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]);
  const robots = await fetchText(`${origin}/robots.txt`, 512 * 1024);
  if (robots && !/<html/i.test(robots)) {
    for (const line of robots.split(/\r?\n/)) {
      const m = line.match(/^\s*(allow|disallow)\s*:\s*(\S+)/i);
      if (m) add(m[2].replace(/\*.*$/, "").replace(/\$$/, ""), "robots");
      const s = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (s) sitemaps.add(s[1]);
    }
  }
  // Sitemaps (and sitemap indexes), a few levels deep.
  const queue = [...sitemaps];
  const seen = new Set();
  let locs = 0;
  while (queue.length && seen.size < 12 && locs < 5000) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm, 6 * 1024 * 1024);
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const isIndex = /<sitemapindex/i.test(xml);
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      const u = m[1].replace(/&amp;/g, "&");
      if (isIndex) queue.push(u);
      else {
        add(u, "sitemap");
        locs++;
      }
    }
  }
  // The site's own JavaScript: route tables live there, linked or not.
  const scripts = [...new Set(page.scripts)].filter((u) => /^https?:/.test(u) && (u.startsWith(origin) || sameSite(u, origin))).slice(0, 60);
  let scanned = 0;
  let bytes = 0;
  for (const url of scripts) {
    if (bytes > 30 * 1024 * 1024) break;
    const js = await fetchText(url);
    if (!js) continue;
    scanned++;
    bytes += js.length;
    for (const p of extractRoutes(js)) add(p, "code");
  }
  const list = [...routes.values()].map((r) => ({
    ...r,
    api: /^\/(api|rest|graphql|v\d+|rpc|functions|trpc|auth\/v1|storage\/v1)(\/|$)/i.test(r.path),
    dynamic: /[:*]/.test(r.path),
    hidden: !r.sources.includes("link") && !r.sources.includes("sitemap"),
  }));
  list.sort((a, b) => a.path.localeCompare(b.path));
  const result = {
    origin,
    url: page.url,
    scannedAt: Date.now(),
    scripts: scanned,
    routes: list,
    stats: {
      total: list.length,
      linked: list.filter((r) => r.sources.includes("link")).length,
      sitemap: list.filter((r) => r.sources.includes("sitemap")).length,
      hidden: list.filter((r) => r.hidden).length,
      api: list.filter((r) => r.api).length,
    },
  };
  await chrome.storage.session.set({ [`eye.map.${origin}`]: result }).catch(() => {});
  return result;
}

/** Light check of which pages open for you (your cookies, 3 at a time, max 150). */
async function mapCheck(origin, paths) {
  const probe = await fetch(`${origin}/eye-check-${Math.random().toString(36).slice(2)}`, { credentials: "include", redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
  const spa = probe?.status === 200;
  const todo = paths.filter((p) => !/[:*]/.test(p)).slice(0, 150);
  const out = {};
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const p = todo[i++];
      try {
        const r = await fetch(origin + p, { credentials: "include", redirect: "manual", signal: AbortSignal.timeout(8000) });
        out[p] = r.type === "opaqueredirect" ? "redirect" : r.status;
      } catch {
        out[p] = "error";
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { spa, statuses: out };
}

// ---------- notifications ----------
function notify(title, message) {
  chrome.notifications?.create({ type: "basic", iconUrl: "icons/icon128.png", title: title || "Eye", message: String(message || "").slice(0, 300), priority: 0 });
}

// ---------- menus, shortcuts, panel ----------
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
    add("eye-bin", "Add to Eye bin", ["image", "video", "selection", "link", "page"]);
    add("eye-ask", "Ask Eye's agent about this…", ["image", "video", "selection", "link", "page"]);
    add("eye-send", "Send to Storyboardmore or BRN…", ["image", "video", "selection", "link", "page"]);
    chrome.contextMenus.create({ id: "eye-sep", type: "separator", contexts: ["page", "image", "video", "selection", "link"] });
    add("eye-code", "Pick a piece of this page", ["page", "image", "video", "selection", "link"]);
    add("eye-mode", "Eye mode (edit this page)", ["page"]);
    add("eye-map", "Show every page of this site", ["page"]);
  });
}
chrome.runtime.onInstalled.addListener(() => {
  buildMenus();
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

async function openPanel(tab, tabName) {
  if (tabName) await chrome.storage.session.set({ "eye.panelTab": tabName }).catch(() => {});
  try {
    await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
  } catch {
    /* needs a click; the action button still opens it */
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id === "eye-map") return openPanel(tab, "map");
  const action = { "eye-bin": "bin", "eye-ask": "ask", "eye-send": "send", "eye-code": "pick-code", "eye-mode": "eye-mode" }[id];
  if (!action) return;
  try {
    await askTab(tab.id, { type: "menu", action, info: { srcUrl: info.srcUrl ?? null, linkUrl: info.linkUrl ?? null, selectionText: info.selectionText ?? null, mediaType: info.mediaType ?? null, pageUrl: info.pageUrl ?? tab.url } });
  } catch (e) {
    // Pages Eye can't draw on: drop it straight in the bin.
    if (action === "bin") {
      await binAdd(
        info.srcUrl && info.mediaType === "image"
          ? { kind: "image", src: info.srcUrl, pageUrl: tab.url, pageTitle: tab.title }
          : info.linkUrl
            ? { kind: "link", url: info.linkUrl, title: info.linkUrl, pageUrl: tab.url, pageTitle: tab.title }
            : info.selectionText
              ? { kind: "text", text: info.selectionText, pageUrl: tab.url, pageTitle: tab.title }
              : { kind: "page", url: tab.url, title: tab.title, pageUrl: tab.url, pageTitle: tab.title },
      );
      notify("Eye", "Added to your bin");
    } else notify("Eye", e.message);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab ?? (await activeTab());
  if (!tab) return;
  const type = { "eye-mode": "eye-mode", "pick-code": "pick-code", "select-media": "select-media" }[command];
  if (type) askTab(tab.id, { type: "menu", action: type, info: {} }).catch((e) => notify("Eye", e.message));
});

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg?.type) {
      case "state": {
        const [d, settings, health] = await Promise.all([destinations(), getSettings(), msg.withHelper ? helperHealth() : null]);
        return { ...d, settings, helper: { running: !!health, connected: sock?.readyState === WebSocket.OPEN, health } };
      }
      case "destinations":
        return destinations();
      case "signIn":
        await auths[msg.app].signIn();
        return { ok: true };
      case "signOut":
        await auths[msg.app].signOut();
        return { ok: true };
      case "send":
        return send(msg);
      case "settings":
        return msg.patch ? setSettings(msg.patch) : getSettings();
      case "bin:add":
        return binAdd(msg.clip);
      case "bin:list":
        return (await binAll()).map(publicItem);
      case "bin:remove":
        for (const id of msg.ids || []) await binDelete(id);
        broadcast({ type: "bin:changed" });
        return { ok: true };
      case "bin:update": {
        const it = await binGet(msg.id);
        if (!it) return { ok: false };
        Object.assign(it, msg.patch || {});
        await binPut(it);
        broadcast({ type: "bin:changed" });
        return publicItem(it);
      }
      case "bin:file": {
        // A file from the bin, as a data URL, for previews and downloads in the panel.
        const it = await binGet(msg.id);
        return it?.blob ? { dataUrl: await blobToDataUrl(it.blob) } : { dataUrl: null };
      }
      case "agent:run":
        return startRun({ ...msg, tabId: msg.tabId ?? sender.tab?.id ?? null });
      case "agent:stop":
        return stopRun(msg.runId);
      case "agent:runs":
        await loadRuns();
        return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).map(runSummary);
      case "agent:clear":
        await loadRuns();
        for (const [id, r] of runs) if (!["running", "starting"].includes(r.status)) runs.delete(id);
        saveRuns();
        broadcast({ type: "run:changed" });
        return { ok: true };
      case "helper:status": {
        const health = await helperHealth();
        if (health && sock?.readyState !== WebSocket.OPEN) await connectHelper().catch(() => {});
        return { running: !!health, connected: sock?.readyState === WebSocket.OPEN, health };
      }
      case "map:scan": {
        const tabId = msg.tabId ?? (await activeTab())?.id;
        return siteMap(tabId);
      }
      case "map:last": {
        const got = await chrome.storage.session.get(`eye.map.${msg.origin}`).catch(() => ({}));
        return got[`eye.map.${msg.origin}`] || null;
      }
      case "map:check":
        return mapCheck(msg.origin, msg.paths || []);
      case "captureVisible":
        return { dataUrl: await chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" }) };
      case "openTab":
        await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
        return { ok: true };
      case "openPanel":
        if (sender.tab) await openPanel(sender.tab, msg.tab);
        return { ok: true };
      case "startOnTab": {
        const tab = await activeTab();
        if (!tab) return { ok: false };
        await askTab(tab.id, { type: "menu", action: msg.action, info: {} });
        return { ok: true };
      }
      case "activeTab": {
        const tab = await activeTab();
        return tab ? { id: tab.id, url: tab.url, title: tab.title, restricted: RESTRICTED.test(tab.url || "") } : null;
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

loadRuns();
