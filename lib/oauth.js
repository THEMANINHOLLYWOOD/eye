// Sign-in for the extension, through the app's own Supabase OAuth 2.1 server.
//
// Both apps (Storyboardmore and BRN) already run Supabase's OAuth server for
// their MCP connectors, with dynamic client registration and PKCE. So the
// extension registers itself once as a public client, sends the person to the
// app's consent page (where their normal web session is already signed in),
// and gets its OWN access + refresh token pair. It never touches the web app's
// session, so signing in or out here can't log the website out.

const DEFAULT_STORE = "clipper.auth";

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 48) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export function decodeJwt(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(part)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** `storeKey` keeps sessions apart when one extension signs in to several apps (Eye). */
export function createAuth({ supabaseUrl, anonKey, clientName, scope = "openid email profile", presetClient = null, storeKey = DEFAULT_STORE }) {
  const STORE = storeKey;
  const issuer = `${supabaseUrl}/auth/v1`;
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  let refreshing = null;

  const read = async () => (await chrome.storage.local.get(STORE))[STORE] ?? {};
  const write = async (patch) => {
    const next = { ...(await read()), ...patch };
    await chrome.storage.local.set({ [STORE]: next });
    return next;
  };

  async function metadata() {
    const r = await fetch(`${supabaseUrl}/.well-known/oauth-authorization-server/auth/v1`);
    if (!r.ok) throw new Error("The sign-in server isn't answering right now.");
    return r.json();
  }

  async function clientId(meta) {
    const saved = await read();
    if (saved.clientId && saved.redirectUri === redirectUri) return saved.clientId;
    // A client already registered for this exact extension id (the dev key build) — reuse it.
    if (presetClient?.id && presetClient.extensionId === chrome.runtime.id && !saved.presetFailed) {
      await write({ clientId: presetClient.id, redirectUri, preset: true });
      return presetClient.id;
    }
    const r = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.client_id) {
      throw new Error(body.error_description || body.msg || body.error || `Couldn't register the extension (${r.status}).`);
    }
    await write({ clientId: body.client_id, redirectUri });
    return body.client_id;
  }

  async function exchange(meta, params) {
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apikey: anonKey },
      body: new URLSearchParams(params),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) {
      const err = new Error(body.error_description || body.msg || body.error || `Sign-in failed (${r.status}).`);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  async function store(tokens) {
    const claims = decodeJwt(tokens.access_token) ?? {};
    const user = {
      id: claims.sub,
      email: claims.email ?? null,
      name: claims.user_metadata?.full_name ?? claims.user_metadata?.name ?? null,
    };
    await write({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? (await read()).refreshToken ?? null,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      user,
    });
    return user;
  }

  async function signIn() {
    const meta = await metadata();
    const id = await clientId(meta);
    const verifier = randomString(48);
    const challenge = b64url(await sha256(verifier));
    const state = randomString(16);
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope,
    }).toString();

    let returned;
    try {
      returned = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    } catch (e) {
      // A client the server forgot (deleted, or registered against another
      // extension id) shows up as a failed flow: register again next time.
      const was = await read();
      await write({ clientId: null, presetFailed: was.preset ? true : was.presetFailed ?? false, preset: false });
      throw new Error(e?.message?.includes("did not approve") ? "Sign-in was cancelled." : e?.message || "Sign-in was cancelled.");
    }
    const back = new URL(returned);
    const err = back.searchParams.get("error");
    if (err) throw new Error(back.searchParams.get("error_description") || err);
    if (back.searchParams.get("state") !== state) throw new Error("Sign-in answer didn't match. Try again.");
    const code = back.searchParams.get("code");
    if (!code) throw new Error("No sign-in code came back.");
    const tokens = await exchange(meta, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      code_verifier: verifier,
    });
    return store(tokens);
  }

  async function refresh() {
    const saved = await read();
    if (!saved.refreshToken || !saved.clientId) throw new Error("Signed out");
    const meta = await metadata();
    try {
      const tokens = await exchange(meta, {
        grant_type: "refresh_token",
        refresh_token: saved.refreshToken,
        client_id: saved.clientId,
      });
      await store(tokens);
      return tokens.access_token;
    } catch (e) {
      if (e.status && e.status < 500) await write({ accessToken: null, refreshToken: null, user: null });
      throw e;
    }
  }

  /** A valid access token, refreshed when it's within a minute of expiring; null when signed out. */
  async function token() {
    const saved = await read();
    if (!saved.accessToken) return null;
    if (saved.expiresAt - Date.now() > 60_000) return saved.accessToken;
    if (!refreshing) refreshing = refresh().finally(() => (refreshing = null));
    try {
      return await refreshing;
    } catch {
      return null;
    }
  }

  async function user() {
    const t = await token();
    if (!t) return null;
    return (await read()).user ?? null;
  }

  async function signOut() {
    await write({ accessToken: null, refreshToken: null, expiresAt: 0, user: null });
  }

  return { signIn, signOut, token, user, redirectUri };
}
