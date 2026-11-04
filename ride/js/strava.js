// Uploads rides to Strava straight from the browser, as Virtual Rides.
//
// Strava's OAuth has no secret-less (PKCE) flow: exchanging the sign-in code and refreshing the
// 6-hour access token both need the API app's Client Secret. With no server, the rider registers
// their own Strava API app and enters its Client ID and Secret here (a password manager can fill
// them in); those and the tokens stay in this browser's storage and are only sent to Strava.

const KEY = 'ride-3d-strava';
const PENDING_KEY = 'ride-3d-strava-pending'; // a ride waiting to upload across the sign-in redirect
const API = 'https://www.strava.com/api/v3';

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage unavailable or full
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pending file's bytes go through localStorage as base64.
const toBase64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.errors?.map((e) => `${e.field} ${e.code}`).join(', ');
    const err = new Error(`Strava: ${body.message ?? res.status}${detail ? ` (${detail})` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export class Strava {
  s = read(KEY) ?? {};

  get clientId() {
    return this.s.clientId ?? '';
  }

  get configured() {
    return Boolean(this.s.clientId && this.s.secret);
  }

  get connected() {
    return Boolean(this.s.refreshToken);
  }

  get athlete() {
    return this.s.athlete;
  }

  #save(patch) {
    this.s = { ...this.s, ...patch };
    write(KEY, this.s);
  }

  setCredentials(clientId, secret) {
    clientId = clientId.trim();
    secret = secret.trim();
    if (clientId !== this.s.clientId || secret !== this.s.secret) {
      // Tokens belong to the old app.
      this.#save({ clientId, secret, accessToken: undefined, refreshToken: undefined, expiresAt: undefined, athlete: undefined });
    }
  }

  /**
   * Sends the browser to Strava's consent page, which comes back to this page with ?code=.
   * `pending` ({ filename, data, dataType, name }) is kept and returned by handleRedirect();
   * false if it didn't fit in storage.
   */
  authorize(pending) {
    const kept = pending ? write(PENDING_KEY, { ...pending, data: toBase64(pending.data) }) : true;
    if (!kept) return false;
    const state = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    this.#save({ state });
    const query = new URLSearchParams({
      client_id: this.s.clientId,
      redirect_uri: location.origin + location.pathname,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: 'activity:write',
      state,
    });
    location.href = `https://www.strava.com/oauth/authorize?${query}`;
    return true;
  }

  /**
   * Finishes the sign-in if this page load is Strava's redirect.
   * @returns {Promise<null | { pending: object | null }>} null when this load isn't one
   */
  async handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('state') || !this.s.state || q.get('state') !== this.s.state) return null;
    history.replaceState(null, '', location.pathname);
    this.#save({ state: undefined });
    const stored = read(PENDING_KEY);
    const pending = stored && { ...stored, data: fromBase64(stored.data) };
    write(PENDING_KEY, undefined);
    if (q.get('error')) throw new Error(`Strava sign-in: ${q.get('error')}`);
    if (!q.get('scope')?.split(',').includes('activity:write')) {
      throw new Error('Strava: permission to upload activities was not granted');
    }
    await this.#token({ grant_type: 'authorization_code', code: q.get('code') });
    return { pending };
  }

  async #token(params) {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.s.clientId, client_secret: this.s.secret, ...params }),
    });
    const t = await json(res);
    const a = t.athlete;
    this.#save({
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: t.expires_at,
      ...(a && { athlete: [a.firstname, a.lastname].filter(Boolean).join(' ') || a.username }),
    });
  }

  async #auth() {
    if (!this.connected) throw new Error('Strava is not connected');
    if (this.s.expiresAt * 1000 - Date.now() < 120000) {
      await this.#token({ grant_type: 'refresh_token', refresh_token: this.s.refreshToken });
    }
    return { Authorization: `Bearer ${this.s.accessToken}` };
  }

  /** Forgets the sign-in (the Client ID and Secret stay) and revokes it on Strava. */
  async disconnect() {
    const token = this.s.accessToken;
    this.#save({ accessToken: undefined, refreshToken: undefined, expiresAt: undefined, athlete: undefined });
    if (token) await fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }

  /**
   * Uploads a ride file (data: bytes, dataType: 'fit') and marks the activity as a Virtual Ride.
   * @returns {Promise<string>} the activity's URL
   */
  async upload({ filename, data, dataType, name }, onStatus = () => {}) {
    let auth = await this.#auth();
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'application/octet-stream' }), filename);
    form.append('data_type', dataType);
    form.append('name', name);
    // No trainer=1: the FIT file's virtual sub-sport already says indoor, and the trainer flag
    // would hide the map.
    form.append('external_id', filename);
    onStatus('Uploading…');
    let up;
    try {
      up = await json(await fetch(`${API}/uploads`, { method: 'POST', headers: auth, body: form }));
    } catch (err) {
      if (err.status === 401) this.#save({ refreshToken: undefined, accessToken: undefined });
      throw err;
    }
    // Strava processes uploads in the background.
    for (let i = 0; !up.activity_id; i++) {
      if (up.error) throw new Error(`Strava: ${up.error}`);
      if (i >= 45) throw new Error('Strava is still processing the upload; it will appear on strava.com shortly');
      onStatus(up.status ?? 'Processing…');
      await sleep(2000);
      auth = await this.#auth();
      up = await json(await fetch(`${API}/uploads/${up.id}`, { headers: auth }));
    }
    onStatus('Marking as a Virtual Ride…');
    await fetch(`${API}/activities/${up.activity_id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sport_type: 'VirtualRide' }),
    }).catch(() => {});
    return `https://www.strava.com/activities/${up.activity_id}`;
  }
}
