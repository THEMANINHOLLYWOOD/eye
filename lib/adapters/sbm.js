// Storyboardmore — where clips go. Shared by the Storyboardmore Clipper and Eye.
//
// Everything is written the way the website writes it (src/lib/boards.ts):
// files into the `board-files` bucket under <user>/<board>/<uuid>-<name>,
// cards into `board_items` (kind image / video / embed / link / note),
// storynotes as kind "note" with light-markdown captions and
// metadata.attachments, then the board's updated_at and a board_events line.
// Row-level security applies to the signed-in person, so the extension can
// only ever touch that person's own storyboards.
import { createSupa } from "../supa.js";
import { safeName, hostOf } from "../bg-core.js";

const GAP = 24;

/**
 * @param {{ config: { supabaseUrl: string, anonKey: string, appUrl: string }, auth: any, via?: string }} opts
 * `via` tags each card's metadata so later clips line up in the same inbox column.
 */
export function createSbmAdapter({ config, auth, via = "clipper" }) {
  const VIA = via;
  const db = createSupa({ supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, token: auth.token });

  async function me() {
    const u = await auth.user();
    if (!u?.id) {
      const e = new Error("Sign in to Storyboardmore first.");
      e.code = "SIGNED_OUT";
      throw e;
    }
    return u;
  }

  async function destinations() {
    const user = await auth.user();
    if (!user) return { signedIn: false, user: null, destinations: [], defaultId: null, canCreate: false, signedOutHint: "your boards appear here" };
    const boards = await db.select("boards", "select=id,title,pinned,is_home,updated_at&deleted_at=is.null&order=updated_at.desc&limit=200");
    const regular = boards.filter((b) => !b.is_home);
    const pinned = regular.filter((b) => b.pinned);
    const recent = regular.filter((b) => !b.pinned);
    const home = boards.find((b) => b.is_home);
    const list = [
      ...pinned.map((b) => ({ id: b.id, label: b.title || "Untitled", group: "Pinned" })),
      ...recent.map((b) => ({ id: b.id, label: b.title || "Untitled", group: pinned.length ? "Recent" : "" })),
      ...(home ? [{ id: home.id, label: "Home canvas", group: "Home" }] : []),
    ];
    return { signedIn: true, user, destinations: list, defaultId: (recent[0] || pinned[0] || home)?.id ?? null, canCreate: true };
  }

  async function createDestination(name) {
    const user = await me();
    const [row] = await db.insert("boards", { title: String(name).trim().slice(0, 200) || "Clipped", user_id: user.id });
    return { id: row.id };
  }

  /** Where the next clip sits: an "inbox" column to the right of what's already on the board, filling downward. */
  async function placeOn(boardId, w, h) {
    const items = await db.select(
      "board_items",
      `select=x,y,width,height,z,created_at,via:metadata->>via&board_id=eq.${boardId}&deleted_at=is.null&order=created_at.asc&limit=2000`,
    );
    const z = items.reduce((m, i) => Math.max(m, i.z || 0), 0) + 1;
    if (!items.length) return { x: 80, y: 80, z };
    const clipped = items.filter((i) => i.via === VIA);
    const clashes = (b) => items.some((t) => b.x < t.x + t.width + GAP && b.x + w + GAP > t.x && b.y < t.y + t.height + GAP && b.y + h + GAP > t.y);
    let x, y;
    if (clipped.length) {
      const last = clipped[clipped.length - 1];
      x = last.x;
      y = Math.max(...clipped.filter((c) => Math.abs(c.x - x) < 1).map((c) => c.y + c.height)) + GAP;
    } else {
      x = Math.max(...items.map((i) => i.x + i.width)) + 96;
      y = Math.min(...items.map((i) => i.y));
    }
    for (let n = 0; n < 400 && clashes({ x, y }); n++) y += GAP;
    return { x: Math.round(x), y: Math.round(y), z };
  }

  async function upload(user, boardId, bytes) {
    const path = `${user.id}/${boardId}/${crypto.randomUUID()}-${safeName(bytes.name)}`;
    await db.upload("board-files", path, bytes.blob, bytes.mime);
    return path;
  }

  async function save(clip, rawBytes, opts) {
    const user = await me();
    const boardId = opts.destinationId || (await destinations()).defaultId;
    if (!boardId) throw new Error("Make a storyboard first — pick “+ New storyboard…”.");
    const note = (opts.note || "").trim();
    const source = sourceOf(clip);
    const bytes = rawBytes ? await shrink(rawBytes) : null;
    const d = await dims(clip, bytes);
    const label = clip.title || clip.pageTitle || hostOf(clip.pageUrl);
    const meta = { via: VIA, source, title: (label || "").slice(0, 300) };
    let item;

    // Highlights always become storynotes; everything else follows the card's toggle.
    const asNote = clip.kind === "text" || !!opts.asNote;

    if (asNote) {
      const attachments = [];
      if (bytes) {
        const path = await upload(user, boardId, bytes);
        attachments.push({ id: crypto.randomUUID(), kind: kindFromMime(bytes.mime, bytes.name), storage_path: path, url: null, file_name: bytes.name, mime_type: bytes.mime, file_size: bytes.size });
      } else if (clip.kind === "image" && clip.src && /^https?:/.test(clip.src)) {
        attachments.push({ id: crypto.randomUUID(), kind: "link", storage_path: null, url: clip.src, file_name: null, mime_type: null, file_size: null });
      }
      if (source.url) attachments.push({ id: crypto.randomUUID(), kind: "link", storage_path: null, url: source.url, file_name: null, mime_type: null, file_size: null });

      let caption;
      if (clip.kind === "text") caption = [note, clip.quote === false ? clip.text : quote(clip.text), clip.quote === false ? null : `— ${source.title || source.site}`].filter(Boolean).join("\n\n");
      else if (clip.kind === "link" || clip.kind === "page") caption = [`## ${label}`, clip.description && clip.kind === "page" ? clip.description : null, note].filter(Boolean).join("\n\n");
      else if (clip.kind === "frame") caption = [note || `## ${source.title || "Frame"}`, `Frame at ${fmt(clip.time)}`].join("\n\n");
      else caption = note || `## ${label}`;

      const w = 360, h = attachments.some((a) => a.storage_path) ? 340 : Math.min(520, 200 + Math.ceil(caption.length / 42) * 18);
      const pos = await placeOn(boardId, w, h);
      item = { kind: "note", caption: caption.slice(0, 200000), metadata: { ...meta, attachments }, width: w, height: h, ...pos };
    } else if ((bytes && ["image", "frame", "screenshot"].includes(clip.kind)) || (bytes && bytes.mime.startsWith("image/"))) {
      const box = fitBox(d);
      const path = await upload(user, boardId, bytes);
      const pos = await placeOn(boardId, box.w, box.h);
      item = { kind: "image", storage_path: path, file_name: bytes.name, file_size: bytes.size, mime_type: bytes.mime, caption: note || null, metadata: meta, width: box.w, height: box.h, ...pos };
    } else if (bytes) {
      const kind = kindFromMime(bytes.mime, bytes.name);
      const box = kind === "video" ? fitBox(d, 480, 200, 640) : kind === "audio" ? { w: 360, h: 140 } : { w: 320, h: 220 };
      const path = await upload(user, boardId, bytes);
      const pos = await placeOn(boardId, box.w, box.h);
      item = { kind, storage_path: path, file_name: bytes.name, file_size: bytes.size, mime_type: bytes.mime, caption: note || null, metadata: meta, width: box.w, height: box.h, ...pos };
    } else if (clip.kind === "image" && clip.src && /^https?:/.test(clip.src)) {
      // Couldn't download (hotlink-protected): keep it as a linked picture.
      const box = fitBox(d);
      const pos = await placeOn(boardId, box.w, box.h);
      item = { kind: "image", url: clip.src, caption: note || null, metadata: meta, width: box.w, height: box.h, ...pos };
    } else {
      // Pages, links and streaming videos: a live website card when the site allows embedding, a link card otherwise.
      const url = clip.kind === "video" ? clip.url || clip.pageUrl : clip.url || clip.pageUrl;
      if (!/^https?:/i.test(url || "")) throw new Error("Only web pages can be saved.");
      const embed = clip.kind === "page" || clip.kind === "video" ? isEmbeddable(url) || clip.kind === "page" : isEmbeddable(url);
      const box = embed ? { w: 480, h: clip.kind === "video" ? 270 : 320 } : { w: 280, h: 120 };
      const pos = await placeOn(boardId, box.w, box.h);
      item = { kind: embed ? "embed" : "link", url, caption: note || (label || "").slice(0, 200) || null, metadata: { ...meta, poster: clip.poster || clip.ogImage || null, description: clip.description || null }, width: box.w, height: box.h, ...pos };
    }

    const [row] = await db.insert("board_items", { ...item, board_id: boardId, user_id: user.id });
    // Same bookkeeping the website does after adding a card (best effort).
    db.update("boards", `id=eq.${boardId}`, { updated_at: new Date().toISOString() }).catch(() => {});
    db.insert("board_events", { board_id: boardId, user_id: user.id, item_id: row.id, action: "added", label: (item.file_name || label || "Clip").slice(0, 200), metadata: { kind: item.kind, via: VIA } }, { minimal: true }).catch(() => {});

    const boards = (await destinations()).destinations;
    const name = boards.find((b) => b.id === boardId)?.label || "your storyboard";
    const what = item.kind === "note" ? "Storynote" : { image: "Picture", video: "Video", embed: "Website", link: "Link", audio: "Audio", pdf: "PDF", file: "File" }[item.kind] || "Card";
    return { ok: true, message: `${what} saved to ${name}`, openUrl: `${config.appUrl}/board/${boardId}`, itemId: row.id };
  }

  return { destinations, save, createDestination, me };
}

/** Same rule as the website: shrink big JPEG/WebP photos to 2400px before upload; keep PNG/GIF/SVG untouched. */
async function shrink(bytes) {
  const { blob, mime } = bytes;
  if (!/^image\/(jpeg|webp|heic|avif)$/.test(mime) || blob.size < 1.2 * 1024 * 1024) return bytes;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    if (out.size >= blob.size) return bytes;
    return { blob: out, mime: "image/jpeg", size: out.size, name: bytes.name.replace(/\.[^.]+$/, "") + ".jpg" };
  } catch {
    return bytes;
  }
}

async function dims(clip, bytes) {
  if (clip.width && clip.height) return { w: clip.width, h: clip.height };
  if (bytes?.mime?.startsWith("image/") && !/svg/.test(bytes.mime)) {
    try {
      const bmp = await createImageBitmap(bytes.blob);
      const d = { w: bmp.width, h: bmp.height };
      bmp.close?.();
      return d;
    } catch {
      /* unknown */
    }
  }
  return null;
}

function kindFromMime(mime, name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].includes(ext)) return "audio";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  return "file";
}

function fitBox(d, maxW = 320, minH = 120, maxH = 560) {
  if (!d?.w || !d?.h) return { w: maxW, h: Math.round(maxW * 0.66) };
  return { w: maxW, h: Math.max(minH, Math.min(maxH, Math.round((maxW * d.h) / d.w))) };
}

const isEmbeddable = (url) => /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com|figma\.com|open\.spotify\.com|soundcloud\.com|codepen\.io)$/.test(hostOf(url));

function sourceOf(clip) {
  const url = clip.kind === "text" ? clip.fragmentUrl || clip.pageUrl : clip.kind === "frame" || clip.kind === "video" ? clip.url || clip.pageUrl : clip.url || clip.pageUrl;
  return { url, page: clip.pageUrl, title: clip.pageTitle || clip.title || null, site: clip.siteName || hostOf(clip.pageUrl), clipped_at: new Date().toISOString() };
}

const quote = (t) => t.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");

function fmt(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60), sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}
