// BRN PRODUCTIONS — where clips go. Shared by the BRN Clipper and Eye.
//
// Two routes, both using what the website already has:
//
// 1. Admin Files (signed-in admins). Exactly the website's upload path:
//    bytes into the `epk-files` bucket at <uuid>_<name>, a `file_records` row
//    (display name, who added it), a `file_activity` line, and a
//    `file_comments` entry carrying the note and where it came from — so it
//    shows up in /admin/files with its provenance, like a Frameset library.
//    Optionally added to a shared Files collection. Pages, links and
//    highlights go to Files → Websites (`file_websites`), highlights appended
//    to that page's notes.
//
// 2. Admin inbox (anyone, no account needed). The same intake the site's
//    "Leave us a message" forms use: files into `produce-files` under the
//    submission id, then a `produce_submissions` row tagged with `source`,
//    which lands in /admin/intake.
import { createSupa } from "../supa.js";
import { safeName, hostOf } from "../bg-core.js";

/**
 * @param {{ config: { supabaseUrl: string, anonKey: string, appUrl: string, inboxMaxBytes: number },
 *           auth: any, source?: string, toolName?: string,
 *           getIdentity: () => Promise<{name:string,email:string}|null>, saveIdentity: (id) => Promise<void> }} opts
 */
export function createBrnAdapter({ config, auth, source: SOURCE = "Burning extension · Web clipper", toolName = "the Burning extension", getIdentity, saveIdentity }) {
  const db = createSupa({ supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, token: auth.token });
  const anon = createSupa({ supabaseUrl: config.supabaseUrl, anonKey: config.anonKey, token: async () => null });
  let roleCache = { id: null, admin: false, name: null, at: 0 };

  async function profile(user) {
    if (roleCache.id === user.id && Date.now() - roleCache.at < 5 * 60_000) return roleCache;
    let admin = false;
    let name = null;
    try {
      const roles = await db.select("user_roles", `select=role&user_id=eq.${user.id}&role=eq.admin`);
      admin = roles.length > 0;
    } catch {
      try {
        admin = !!(await db.rpc("has_role", { _user_id: user.id, _role: "admin" }));
      } catch {
        admin = false;
      }
    }
    try {
      const [p] = await db.select("profiles", `select=first_name,last_name&id=eq.${user.id}`);
      name = [p?.first_name, p?.last_name].filter(Boolean).join(" ") || null;
    } catch {
      /* fine */
    }
    roleCache = { id: user.id, admin, name: name || user.name || user.email?.split("@")[0] || "Admin", at: Date.now() };
    return roleCache;
  }

  async function destinations() {
    const user = await auth.user();
    const inbox = { id: "inbox", label: "Admin inbox (Intake)", group: "" };
    if (!user) return { signedIn: false, user: null, destinations: [inbox], defaultId: "inbox", canCreate: false, needsIdentity: true, signedOutHint: "admins unlock Files" };
    const p = await profile(user);
    if (!p.admin) return { signedIn: true, user, admin: false, destinations: [inbox], defaultId: "inbox", canCreate: false, needsIdentity: false };
    let collections = [];
    try {
      collections = await db.select("file_collections", "select=id,name&order=created_at.desc&limit=100");
    } catch {
      /* none */
    }
    return {
      signedIn: true,
      user,
      admin: true,
      destinations: [
        { id: "files", label: "Files · Uploads", group: "Admin Files" },
        ...collections.map((c) => ({ id: `col:${c.id}`, label: c.name, group: "Files collections" })),
        { ...inbox, group: "Inbox" },
      ],
      defaultId: "files",
      canCreate: true,
      needsIdentity: false,
    };
  }

  async function createDestination(name) {
    const [row] = await db.insert("file_collections", { name: String(name).trim().slice(0, 100) || "From the web", file_keys: [] });
    return { id: `col:${row.id}` };
  }

  // ---------- Admin Files ----------
  async function saveToFiles(clip, bytes, opts, user, who) {
    const note = (opts.note || "").trim();
    const source = sourceOf(clip);

    if (!bytes) {
      // Pages, links, highlights and streaming videos become website references; repeat visits add to that page's notes.
      const url = httpsUrl(clip.kind === "text" ? (clip.pageUrl || "").split("#")[0] : source.url);
      if (!url) throw new Error("Only https pages can be saved to Files → Websites.");
      const entry = describe(clip, note, { ...source, url: clip.kind === "text" ? clip.fragmentUrl : null }).trim();
      const title = (clip.kind === "link" ? clip.title || url : source.title || url).slice(0, 200) || hostOf(url);
      const [existing] = await db.select("file_websites", `select=id,notes,deleted_at&url=eq.${encodeURIComponent(url)}`);
      if (existing) {
        const notes = [existing.notes, `— ${new Date().toLocaleDateString()} · ${who.name}\n${entry}`].filter(Boolean).join("\n\n").slice(-10000);
        await db.update("file_websites", `id=eq.${existing.id}`, { notes, deleted_at: null });
      } else {
        await db.insert("file_websites", { url, title, notes: `${who.name}\n${entry}`.slice(0, 10000) }, { minimal: true });
      }
      return { ok: true, message: existing ? "Added to that page's notes in Files → Websites" : "Saved to Files → Websites", openUrl: `${config.appUrl}/admin/files` };
    }

    const path = `${crypto.randomUUID()}_${safeName(bytes.name, "file")}`;
    await db.upload("epk-files", path, bytes.blob, bytes.mime);
    await db.insert("file_records", { path, display_name: bytes.name.slice(0, 200), created_by: user.id }, { minimal: true, upsert: true, onConflict: "path" });
    const tasks = [
      db.insert("file_activity", { file_key: path, user_id: user.id, user_name: who.name, action: "uploaded", detail: `Saved from ${source.site} with ${toolName}` }, { minimal: true }),
      db.insert("file_comments", { file_key: path, user_id: user.id, user_name: who.name, body: describe(clip, note, source).slice(0, 4000) }, { minimal: true }),
    ];
    const size = await imageSize(bytes);
    if (size) tasks.push(db.insert("file_media_metadata", { file_key: path, width: size.w, height: size.h }, { minimal: true, upsert: true, onConflict: "file_key" }));
    await Promise.allSettled(tasks);

    let where = "Files";
    if (opts.destinationId?.startsWith("col:")) {
      const id = opts.destinationId.slice(4);
      const [col] = await db.select("file_collections", `select=name,file_keys&id=eq.${id}`);
      if (col) {
        await db.update("file_collections", `id=eq.${id}`, { file_keys: [...new Set([...(col.file_keys || []), path])] });
        where = `Files · ${col.name}`;
      }
    }
    const what = clip.kind === "frame" ? "Frame" : clip.kind === "screenshot" ? "Screenshot" : bytes.mime.startsWith("video/") ? "Video" : bytes.mime.startsWith("image/") ? "Image" : "File";
    return { ok: true, message: `${what} saved to ${where}`, openUrl: `${config.appUrl}/admin/files`, path };
  }

  // ---------- Admin inbox (anyone) ----------
  async function saveToInbox(clip, bytes, opts, user, who) {
    const note = (opts.note || "").trim();
    const source = sourceOf(clip);
    let identity;
    if (user) identity = { name: who?.name || user.email?.split("@")[0] || "BRN member", email: user.email };
    else {
      identity = opts.identity || (await getIdentity());
      if (!identity?.name || !identity?.email) throw new Error("Add your name and email so the admin knows who sent it.");
      await saveIdentity(identity);
    }
    if (bytes && bytes.size > config.inboxMaxBytes) {
      throw new Error(`The inbox takes files up to ${config.inboxMaxBytes / 1048576} MB — this one is ${(bytes.size / 1048576).toFixed(0)} MB.`);
    }
    const id = crypto.randomUUID();
    const client = user ? db : anon;
    const files = [];
    if (bytes) {
      const path = `${id}/${Date.now()}-${safeName(bytes.name, "file")}`;
      await client.upload("produce-files", path, bytes.blob, bytes.mime);
      files.push({ name: bytes.name, path, size: bytes.size, type: bytes.mime });
    }
    const label = clip.kind === "text" ? `Highlight · ${source.title}` : clip.kind === "frame" ? `Frame · ${source.title}` : `${clip.kind[0].toUpperCase()}${clip.kind.slice(1)} · ${clip.title || source.title}`;
    await client.insert(
      "produce_submissions",
      {
        id,
        kind: "film",
        full_name: identity.name.slice(0, 120),
        email: identity.email.slice(0, 255),
        project_title: `Web clip — ${label}`.slice(0, 200),
        description: describe(clip, note, source).slice(0, 5000),
        details: {
          source: SOURCE,
          link: source.url || null,
          page: source.page && source.page !== source.url ? source.page : null,
          media: !bytes && clip.src && /^https?:/.test(clip.src) ? clip.src : null,
          type: clip.kind,
        },
        files,
      },
      { minimal: true },
    );
    return { ok: true, message: "Sent to the admin inbox", openUrl: who?.admin ? `${config.appUrl}/admin/intake?tab=submissions` : null };
  }

  async function save(clip, bytes, opts) {
    const user = await auth.user();
    const who = user ? await profile(user) : null;
    const dest = opts.destinationId || (who?.admin ? "files" : "inbox");
    if (dest !== "inbox") {
      if (!who?.admin) throw new Error("Only BRN admins can save to Files. Use the admin inbox instead.");
      return saveToFiles(clip, bytes, opts, user, who);
    }
    return saveToInbox(clip, bytes, opts, user, who);
  }

  return { destinations, save, createDestination };
}

function sourceOf(clip) {
  const url = clip.kind === "text" ? clip.fragmentUrl || clip.pageUrl : clip.kind === "frame" || clip.kind === "video" ? clip.url || clip.pageUrl : clip.url || clip.pageUrl;
  return { url, page: clip.pageUrl, title: clip.pageTitle || clip.title || hostOf(clip.pageUrl), site: clip.siteName || hostOf(clip.pageUrl) };
}

const fmt = (s) => {
  s = Math.floor(s || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function describe(clip, note, source) {
  const parts = [];
  if (note) parts.push(note);
  if (clip.kind === "text") parts.push(clip.quote === false ? clip.text : `“${clip.text}”`);
  if (clip.kind === "frame") parts.push(`Frame at ${fmt(clip.time)} — ${clip.width}×${clip.height}`);
  if (clip.kind === "video" && clip.time) parts.push(`Video at ${fmt(clip.time)}`);
  parts.push(`From: ${source.title}${source.url ? `\n${source.url}` : ""}`);
  return parts.join("\n\n");
}

const httpsUrl = (u) => {
  try {
    const url = new URL(u);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/** Real pixel size, read from the file itself (what Files shows next to each picture). */
async function imageSize(bytes) {
  if (!bytes.mime.startsWith("image/") || /svg/.test(bytes.mime)) return null;
  try {
    const bmp = await createImageBitmap(bytes.blob);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return d.w > 0 && d.h > 0 ? d : null;
  } catch {
    return null;
  }
}
