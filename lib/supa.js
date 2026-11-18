// Tiny Supabase client for the service worker: PostgREST, RPC and Storage over
// fetch, acting as the signed-in person (or the anon role) so the app's own
// row-level security decides what's allowed — exactly like the website.

export function createSupa({ supabaseUrl, anonKey, token }) {
  async function headers(extra = {}) {
    const t = (await token?.()) ?? null;
    return { apikey: anonKey, Authorization: `Bearer ${t ?? anonKey}`, ...extra };
  }

  async function fail(r, what) {
    let msg = `${what} failed (${r.status})`;
    try {
      const b = await r.json();
      msg = b.message || b.msg || b.error_description || b.error || msg;
    } catch {
      /* not JSON */
    }
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }

  /** GET /rest/v1/<table>?<query> */
  async function select(table, query = "") {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, { headers: await headers() });
    if (!r.ok) await fail(r, `Reading ${table}`);
    return r.json();
  }

  /** INSERT; returns the inserted rows unless minimal is asked for (needed when RLS hides the row). */
  async function insert(table, rows, { minimal = false, upsert = false, onConflict } = {}) {
    const prefer = [minimal ? "return=minimal" : "return=representation"];
    if (upsert) prefer.push("resolution=merge-duplicates");
    const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}${q}`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json", Prefer: prefer.join(",") }),
      body: JSON.stringify(rows),
    });
    if (!r.ok) await fail(r, `Saving to ${table}`);
    return minimal ? null : r.json();
  }

  async function update(table, query, patch) {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}?${query}`, {
      method: "PATCH",
      headers: await headers({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(patch),
    });
    if (!r.ok) await fail(r, `Updating ${table}`);
    return r.json();
  }

  async function rpc(fn, args = {}) {
    const r = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: await headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    if (!r.ok) await fail(r, fn);
    return r.json();
  }

  /** Upload bytes to a bucket path. Never overwrites. */
  async function upload(bucket, path, blob, contentType) {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const r = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${enc}`, {
      method: "POST",
      headers: await headers({
        "Content-Type": contentType || blob.type || "application/octet-stream",
        "x-upsert": "false",
        "cache-control": "max-age=3600",
      }),
      body: blob,
    });
    if (!r.ok) await fail(r, "Upload");
    return path;
  }

  return { select, insert, update, rpc, upload };
}
