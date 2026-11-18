// Eye — side panel: Bin, Agents, Map, Settings.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function ask(msg) {
  const r = await chrome.runtime.sendMessage(msg);
  if (r?.error) throw new Error(r.error);
  return r;
}
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
const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ---------- tabs ----------
let current = "bin";
function showTab(name) {
  current = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${name}`));
  updateActions();
  if (name === "agents") refreshHelper();
  if (name === "map") refreshMapSite();
  if (name === "settings") loadSettings();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
async function takePanelTab() {
  const got = await chrome.storage.session.get("eye.panelTab").catch(() => ({}));
  if (got["eye.panelTab"]) {
    showTab(got["eye.panelTab"]);
    chrome.storage.session.remove("eye.panelTab").catch(() => {});
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["eye.panelTab"]?.newValue) takePanelTab();
});

$$(".quick button").forEach((b) =>
  b.addEventListener("click", async () => {
    try {
      await ask({ type: "startOnTab", action: b.dataset.start });
    } catch (e) {
      flash(e.message);
    }
  }),
);
function flash(text) {
  let t = $("#panelToast");
  if (!t) {
    t = el("div", { id: "panelToast", style: "position:fixed;left:12px;right:12px;bottom:12px;z-index:50;background:#1c1c20;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.5)" });
    document.body.append(t);
  }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (t.hidden = true), 4500);
}

// ---------- bin ----------
let bin = [];
let filter = "all";
const selected = new Set();
const FILTERS = [["all", "All"], ["image", "Images"], ["frame", "Frames"], ["screenshot", "Shots"], ["video", "Video"], ["text", "Text"], ["code", "Code"], ["link", "Links"], ["page", "Pages"]];

function renderFilters() {
  const present = new Set(bin.map((i) => i.kind));
  $("#filters").replaceChildren(
    ...FILTERS.filter(([k]) => k === "all" || present.has(k)).map(([k, label]) =>
      el("button", { class: filter === k ? "on" : "", text: `${label}${k === "all" ? ` · ${bin.length}` : ""}`, onclick: () => ((filter = k), renderBin()) }),
    ),
  );
}

async function loadBin() {
  bin = await ask({ type: "bin:list" });
  for (const id of [...selected]) if (!bin.some((i) => i.id === id)) selected.delete(id);
  $("#binCount").textContent = bin.length ? String(bin.length) : "";
  renderBin();
}

function itemMedia(it) {
  if (it.thumb) return el("img", { src: it.thumb, alt: "" });
  if (it.kind === "image" && it.src) return el("img", { src: it.src, alt: "", referrerpolicy: "no-referrer" });
  if (it.kind === "code") return el("div", { class: "txt code", text: (it.text || "").slice(0, 400) });
  if (it.kind === "text") return el("div", { class: "txt", text: `“${(it.text || "").slice(0, 300)}”` });
  return el("div", { class: "txt", text: it.title || it.url || it.kind });
}

function renderBin() {
  renderFilters();
  const list = filter === "all" ? bin : bin.filter((i) => i.kind === filter);
  $("#binEmpty").hidden = bin.length > 0;
  $("#binGrid").replaceChildren(
    ...list.map((it) => {
      const card = el(
        "div",
        { class: `item${selected.has(it.id) ? " sel" : ""}`, title: it.title },
        el("div", { class: "media" }, itemMedia(it)),
        el("span", { class: "kind", text: it.kind }),
        el("span", { class: "tick" }),
        el(
          "div",
          { class: "tools" },
          it.pageUrl || it.url ? el("button", { title: "Open where it came from", text: "↗", onclick: (e) => (e.stopPropagation(), ask({ type: "openTab", url: it.url || it.pageUrl })) }) : null,
          el("button", { title: "Remove from bin", text: "✕", onclick: (e) => (e.stopPropagation(), ask({ type: "bin:remove", ids: [it.id] })) }),
        ),
        el(
          "div",
          { class: "meta" },
          el("div", { class: "t", text: it.title || "Untitled" }),
          el("div", { class: "s", text: `${it.siteName || host(it.pageUrl)} · ${ago(it.createdAt)}` }),
          it.sentTo?.length ? el("div", { class: "sent", text: `✓ ${it.sentTo[it.sentTo.length - 1].label}` }) : null,
        ),
      );
      card.addEventListener("click", () => {
        if (selected.has(it.id)) selected.delete(it.id);
        else selected.add(it.id);
        card.classList.toggle("sel", selected.has(it.id));
        updateActions();
      });
      return card;
    }),
  );
  updateActions();
}

// ----- footer actions for selected bin items -----
let dests = null;
async function loadDests() {
  dests = await ask({ type: "destinations" });
  const sel = $("#dest");
  const keep = sel.value;
  sel.replaceChildren();
  const groups = new Map();
  for (const d of dests.destinations) {
    if (!groups.has(d.group)) groups.set(d.group, el("optgroup", { label: d.group }));
    groups.get(d.group).append(el("option", { value: d.id, text: d.label }));
  }
  groups.forEach((g) => sel.append(g));
  sel.value = keep && dests.destinations.some((d) => d.id === keep) ? keep : dests.defaultId;
  destChanged();
}
function destChanged() {
  const v = $("#dest").value || "";
  $("#newName").hidden = !v.endsWith(":new");
  $("#asNoteWrap").style.display = v.startsWith("sbm:") ? "flex" : "none";
}
$("#dest").addEventListener("change", destChanged);

function updateActions() {
  const n = selected.size;
  $("#actions").hidden = current !== "bin" || n === 0;
  $("#selCount").textContent = `${n} selected`;
  $("#taskItemsLabel").textContent = n ? `Include ${n} selected bin item${n === 1 ? "" : "s"}` : "Include selected bin items (none selected)";
  $("#taskItems").disabled = !n;
  if (!n) $("#taskItems").checked = false;
  if (n && !dests) loadDests().catch((e) => ($("#actMsg").textContent = e.message));
}
$("#selClear").addEventListener("click", () => {
  selected.clear();
  renderBin();
});
$("#removeSel").addEventListener("click", async () => {
  await ask({ type: "bin:remove", ids: [...selected] });
  selected.clear();
});
$("#sendSel").addEventListener("click", async () => {
  const msg = $("#actMsg");
  const btn = $("#sendSel");
  btn.disabled = true;
  msg.className = "sm";
  msg.textContent = "Sending…";
  try {
    const identity = dests?.identity || undefined;
    const res = await ask({ type: "send", itemIds: [...selected], destination: $("#dest").value, note: $("#sendNote").value, asNote: $("#asNote").checked, newName: $("#newName").value, identity });
    const failed = res.results?.filter((r) => !r.ok) || [];
    msg.className = failed.length ? "sm bad" : "sm ok";
    msg.replaceChildren(document.createTextNode(failed.length ? `${res.message}. ${failed[0].error}` : `✓ ${res.message}  `));
    if (res.openUrl) msg.append(el("button", { class: "link", text: "Open", onclick: () => ask({ type: "openTab", url: res.openUrl }) }));
    if ($("#dest").value.endsWith(":new")) await loadDests();
  } catch (e) {
    msg.className = "sm bad";
    msg.textContent = e.message;
  }
  btn.disabled = false;
});
async function askAgentWith(itemIds, prompt, includePage) {
  await ask({ type: "agent:run", prompt, itemIds, includePage });
  showTab("agents");
}
$("#askSelGo").addEventListener("click", async () => {
  const p = $("#askSel").value.trim();
  if (!p) return $("#askSel").focus();
  try {
    await askAgentWith([...selected], p, false);
    $("#askSel").value = "";
  } catch (e) {
    $("#actMsg").className = "sm bad";
    $("#actMsg").textContent = e.message;
  }
});
$("#askSel").addEventListener("keydown", (e) => e.key === "Enter" && $("#askSelGo").click());

// ---------- agents ----------
let runs = [];
async function refreshHelper() {
  const card = $("#helperCard");
  let h;
  try {
    h = await ask({ type: "helper:status" });
  } catch {
    h = { running: false };
  }
  $("#helperDot").className = `hdot ${h.running ? "on" : "off"}`;
  if (h.running) {
    card.replaceChildren(
      el("div", { class: "row between", style: "margin:0" }, el("b", { text: "Claude on this Mac is ready" }), el("span", { class: "sm", text: h.connected ? "connected" : "reachable" })),
      el("p", { class: "sm", text: `Runs are saved in ${h.health?.runsDir || "~/Eye/runs"}.` }),
    );
  } else {
    card.replaceChildren(
      el("b", { text: "Start the agent helper" }),
      el(
        "ol",
        { class: "helper-steps" },
        el("li", { text: "In Finder, open the “chrome extensions” folder you loaded Eye from." }),
        el("li", {}, "Open ", el("code", { text: "eye-helper" }), " and double-click ", el("code", { text: "start.command" }), ". The first time, macOS may ask — right-click it and choose Open."),
        el("li", { text: "Keep that Terminal window open while you use agents." }),
      ),
      el("div", { class: "row" }, el("span", { class: "grow sm", text: "Nothing leaves your Mac except what Claude Code normally sends." }), el("button", { class: "btn", text: "Check again", onclick: refreshHelper })),
    );
  }
}
async function loadRuns() {
  runs = await ask({ type: "agent:runs" });
  const live = runs.filter((r) => r.status === "running" || r.status === "starting").length;
  $("#runCount").textContent = live ? `· ${live} live` : runs.length ? String(runs.length) : "";
  renderRuns();
}
const openRuns = new Set();
function renderRuns() {
  $("#runList").replaceChildren(
    ...(runs.length
      ? runs.map((r) => {
          const live = r.status === "running" || r.status === "starting";
          const showLog = openRuns.has(r.id) || live;
          const log = el(
            "div",
            { class: "log" },
            r.events.map((e) =>
              e.kind === "text"
                ? el("div", { class: "e", text: e.text })
                : e.kind === "tool"
                  ? el("div", { class: "e tool" }, el("b", { text: `→ ${e.name}` }), document.createTextNode(` ${JSON.stringify(e.input || {}).slice(0, 220)}`))
                  : e.kind === "tool-result"
                    ? el("div", { class: "e tool", text: `${e.ok ? "✓" : "✗"} ${e.summary || ""}` })
                    : el("div", { class: "e tool", text: e.text || "" }),
            ),
          );
          return el(
            "div",
            { class: "run" },
            el("div", { class: "head" }, el("span", { class: `pillst ${r.status}`, text: r.status }), el("span", { class: "p", text: r.prompt })),
            el("div", { class: "sm", text: `${r.pageTitle || host(r.pageUrl) || "No page"} · ${ago(r.startedAt)}${r.costUsd != null ? ` · $${r.costUsd.toFixed(3)}` : ""}${r.element ? ` · ${r.element.label}` : ""}` }),
            r.items?.some((i) => i.thumb) ? el("div", { class: "thumbs" }, r.items.filter((i) => i.thumb).slice(0, 8).map((i) => el("img", { src: i.thumb, alt: "" }))) : null,
            r.result ? el("div", { class: "result", text: r.result }) : null,
            r.error && r.status !== "done" ? el("div", { class: "result bad", text: r.error }) : null,
            showLog && r.events.length ? log : null,
            el(
              "div",
              { class: "row" },
              live ? el("button", { class: "btn", text: "Stop", onclick: () => ask({ type: "agent:stop", runId: r.id }) }) : null,
              !live && r.events.length ? el("button", { class: "link", text: showLog ? "Hide steps" : `Show ${r.events.length} steps`, onclick: () => (openRuns.has(r.id) ? openRuns.delete(r.id) : openRuns.add(r.id), renderRuns()) }) : null,
              el("span", { class: "grow" }),
              r.workdir ? el("button", { class: "link", text: "Copy run folder", title: r.workdir, onclick: () => navigator.clipboard.writeText(r.workdir) }) : null,
            ),
          );
        })
      : [el("p", { class: "sm", text: "No runs yet. Hover any picture and hit Ask, pick a piece of a page, or type a task above." })]),
  );
}
$("#taskRun").addEventListener("click", async () => {
  const prompt = $("#taskPrompt").value.trim();
  if (!prompt) return $("#taskPrompt").focus();
  const msg = $("#taskMsg");
  msg.className = "grow sm";
  msg.textContent = "Starting…";
  try {
    await ask({ type: "agent:run", prompt, itemIds: $("#taskItems").checked ? [...selected] : [], includePage: $("#taskPage").checked });
    $("#taskPrompt").value = "";
    msg.textContent = "";
  } catch (e) {
    msg.className = "grow sm bad";
    msg.textContent = e.message;
    refreshHelper();
  }
});
$("#taskPrompt").addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && $("#taskRun").click());
$("#clearRuns").addEventListener("click", () => ask({ type: "agent:clear" }).then(loadRuns));

// ---------- map ----------
let mapData = null;
let statuses = {};
let spa = false;
let siteOrigin = null;
async function refreshMapSite() {
  const tab = await ask({ type: "activeTab" }).catch(() => null);
  const origin = tab && !tab.restricted ? (() => {
    try {
      return new URL(tab.url).origin;
    } catch {
      return null;
    }
  })() : null;
  $("#mapScan").disabled = !origin;
  if (origin === siteOrigin && mapData) return;
  siteOrigin = origin;
  $("#mapSite").textContent = origin ? host(origin) : "Open a website to map it";
  mapData = origin ? await ask({ type: "map:last", origin }).catch(() => null) : null;
  statuses = {};
  spa = false;
  renderMap();
}
$("#mapScan").addEventListener("click", async () => {
  const b = $("#mapScan");
  b.disabled = true;
  b.textContent = "Scanning…";
  $("#mapNote").textContent = "Reading links, robots.txt, sitemaps and the site's own JavaScript…";
  try {
    mapData = await ask({ type: "map:scan" });
    statuses = {};
    spa = false;
    $("#mapNote").textContent = "";
  } catch (e) {
    $("#mapNote").textContent = e.message;
  }
  b.disabled = false;
  b.textContent = "Scan again";
  renderMap();
});
$("#mapCheck").addEventListener("click", async () => {
  if (!mapData) return;
  const b = $("#mapCheck");
  b.disabled = true;
  b.textContent = "Checking…";
  try {
    const visible = visibleRoutes().filter((r) => !r.dynamic).map((r) => r.path);
    const res = await ask({ type: "map:check", origin: mapData.origin, paths: visible });
    statuses = res.statuses;
    spa = res.spa;
  } catch (e) {
    $("#mapNote").textContent = e.message;
  }
  b.textContent = "Check which open";
  b.disabled = false;
  renderMap();
});
["#mapFilter", "#mapHidden", "#mapApi"].forEach((s) => $(s).addEventListener("input", renderMap));
function visibleRoutes() {
  if (!mapData) return [];
  const q = $("#mapFilter").value.trim().toLowerCase();
  return mapData.routes.filter((r) => (!q || r.path.toLowerCase().includes(q)) && (!$("#mapHidden").checked || r.hidden) && ($("#mapApi").checked || !r.api));
}
function renderMap() {
  const stats = $("#mapStats");
  const list = $("#mapList");
  $("#mapCheck").disabled = !mapData;
  if (!mapData) {
    stats.replaceChildren();
    list.replaceChildren(el("p", { class: "sm", text: siteOrigin ? "Scan to see every page this site exposes — linked ones, ones in its sitemap and robots.txt, and ones that only exist in its code." : "" }));
    return;
  }
  const s = mapData.stats;
  stats.replaceChildren(
    el("span", {}, el("b", { text: String(s.total) }), " pages"),
    el("span", {}, el("b", { text: String(s.linked) }), " linked"),
    el("span", {}, el("b", { text: String(s.sitemap) }), " in sitemap"),
    el("span", {}, el("b", { text: String(s.hidden) }), " hidden"),
    el("span", {}, el("b", { text: String(s.api) }), " API"),
    el("span", { text: `${mapData.scripts} scripts read · ${new Date(mapData.scannedAt).toLocaleTimeString()}` }),
  );
  if (spa) $("#mapNote").textContent = "This site answers every address with its app (a single-page app), so “200” only means the address loads the app — open a page to see what it really shows.";
  const groups = new Map();
  for (const r of visibleRoutes()) {
    const g = r.path === "/" ? "/" : "/" + r.path.split("/")[1];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  list.replaceChildren(
    ...[...groups.entries()].map(([g, rs]) =>
      el(
        "div",
        { class: "group" },
        el("div", { class: "gh" }, el("span", { text: g }), el("span", { text: String(rs.length) })),
        rs.map((r) => {
          const st = statuses[r.path];
          const stCls = typeof st === "number" ? `s${String(st)[0]}` : st || "";
          return el(
            "div",
            {
              class: `route${r.hidden ? " hidden" : ""}`,
              title: r.dynamic ? "Has a placeholder — click to copy" : "Open in a new tab",
              onclick: () => (r.dynamic ? navigator.clipboard.writeText(mapData.origin + r.path) : ask({ type: "openTab", url: mapData.origin + r.path })),
            },
            el("span", { class: "path", text: r.path }),
            r.api ? el("span", { class: "b api", text: "api" }) : null,
            r.sources.map((src) => el("span", { class: `b ${src}`, text: src })),
            st != null ? el("span", { class: `st ${stCls}`, text: String(st) }) : null,
          );
        }),
      ),
    ),
  );
}
chrome.tabs.onActivated.addListener(() => current === "map" && refreshMapSite());
chrome.tabs.onUpdated.addListener((_id, info) => info.url && current === "map" && refreshMapSite());

// ---------- settings ----------
async function loadSettings() {
  const st = await ask({ type: "state" });
  dests = st;
  const acct = (id, app, name, a, extra) =>
    $(id).replaceChildren(
      el("div", { class: "who" }, el("b", { text: name }), el("span", { class: "sm", text: a.signedIn ? `${a.email}${extra || ""}` : app === "brn" ? "Admins sign in for Files" : "Sign in for your boards" })),
      el("button", { class: a.signedIn ? "btn" : "btn go", text: a.signedIn ? "Sign out" : "Sign in", onclick: () => ask({ type: a.signedIn ? "signOut" : "signIn", app }).then(loadSettings).catch((e) => flash(e.message)) }),
    );
  acct("#acctSbm", "sbm", "Storyboardmore", st.accounts.sbm);
  acct("#acctBrn", "brn", "BRN PRODUCTIONS", st.accounts.brn, st.accounts.brn.admin ? " · admin" : "");
  $("#idName").value = st.settings.identity?.name || "";
  $("#idEmail").value = st.settings.identity?.email || "";
  $("#setHover").checked = !!st.settings.hoverChips;
  $("#setPill").checked = !!st.settings.selectionPill;
  $("#setCommands").checked = !!st.settings.allowCommands;
  $("#cmdWarn").hidden = !st.settings.allowCommands;
  $("#setModel").value = st.settings.model || "";
}
$("#idSave").addEventListener("click", async () => {
  await ask({ type: "settings", patch: { identity: { name: $("#idName").value.trim(), email: $("#idEmail").value.trim() } } });
  $("#idMsg").textContent = "Saved.";
});
$("#setHover").addEventListener("change", (e) => ask({ type: "settings", patch: { hoverChips: e.target.checked } }));
$("#setPill").addEventListener("change", (e) => ask({ type: "settings", patch: { selectionPill: e.target.checked } }));
$("#setCommands").addEventListener("change", (e) => {
  $("#cmdWarn").hidden = !e.target.checked;
  ask({ type: "settings", patch: { allowCommands: e.target.checked } });
});
$("#setModel").addEventListener("change", (e) => ask({ type: "settings", patch: { model: e.target.value } }));
$("#openShortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

// ---------- live updates ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bin:changed") loadBin();
  if (msg?.type === "run:changed") {
    clearTimeout(loadRuns.timer);
    loadRuns.timer = setTimeout(loadRuns, 150);
  }
  if (msg?.type === "helper:changed") $("#helperDot").className = `hdot ${msg.connected ? "on" : "off"}`;
});

loadBin();
loadRuns();
refreshHelper();
takePanelTab();
