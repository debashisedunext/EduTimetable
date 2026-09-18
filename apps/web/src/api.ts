import { clearOffered } from "./onboarding/offered";

const TOKEN_KEY = "edutimetable.session";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
/**
 * Store a session token — the one place a session into a school begins.
 *
 * Sign-in, the SSO callback, entering a school, creating one and switching all
 * arrive here, which is why the welcome screen's "already offered this sitting"
 * flag is cleared here too (§24.1a) rather than at five call sites, one of which
 * would eventually be added without it.
 */
export const setToken = (t: string) => {
  localStorage.setItem(TOKEN_KEY, t);
  clearOffered();
};
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/";
    throw new Error("Session expired");
  }
  if (!res.ok) throw await asError(res);
  return res.json() as Promise<T>;
}

/**
 * The server's own sentence, not its wire format.
 *
 * This used to throw `new Error("400: " + the raw body)`, which meant every
 * screen that rendered `e.message` printed a line of JSON at the reader —
 * `400: {"message":"Edunext School is locked, …","error":"Bad Request"}`. Some
 * screens unwrapped it with `asMessage`; most did not, so the same refusal read
 * as a considered sentence on one page and as a stack trace on the next.
 *
 * Unwrapped HERE rather than at the call sites, for §10.6's reason: thirty
 * screens each remembering to decode a transport detail is thirty chances to
 * forget, and the ones that forgot were exactly the ones nobody had seen fail.
 * `asMessage` stays and is now a no-op on these — its regex finds no prefix and
 * its `JSON.parse` fails, so it returns the string untouched.
 *
 * The status stays reachable as a property for the few places that branch on
 * it; it is off the message because a person reading "400" learns nothing.
 */
export interface ApiError extends Error {
  status: number;
  /** The raw body, for the rare case something needs more than the sentence. */
  body: string;
}

async function asError(res: Response): Promise<ApiError> {
  const body = await res.text();
  let message = body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message === "string") message = parsed.message;
    // Nest sends `message` as an ARRAY for a failed class-validator pipe. Joined
    // rather than `[object Object]`, which is what `String()` would have made of
    // it on the one screen that hit it.
    else if (Array.isArray(parsed?.message)) message = parsed.message.join(". ");
    else if (typeof parsed?.error === "string") message = parsed.error;
  } catch {
    // Not JSON — a proxy error page or an empty body. The status is all there
    // is to say, and saying nothing at all would be worse.
    if (!message.trim()) message = `Request failed (${res.status})`;
  }
  const err = new Error(message) as ApiError;
  err.status = res.status;
  err.body = body;
  return err;
}

/** Multipart upload — the browser must set its own boundary, so this helper
 *  deliberately does NOT send a Content-Type header (§16 import). */
export async function apiUpload<T>(path: string, file: File, field = "file"): Promise<T> {
  const body = new FormData();
  body.append(field, file);
  const res = await fetch(`/api${path}`, {
    method: "POST",
    body,
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/";
    throw new Error("Session expired");
  }
  if (!res.ok) throw await asError(res);
  return res.json() as Promise<T>;
}

/** Download a file from an authenticated endpoint (a plain <a href> cannot
 *  carry the bearer token), optionally posting a file up in the same call. */
export async function apiDownload(path: string, fallbackName: string, file?: File): Promise<void> {
  const init: RequestInit = { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} };
  if (file) {
    const body = new FormData();
    body.append("file", file);
    init.method = "POST";
    init.body = body;
  }
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) throw await asError(res);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const named = /filename="?([^"]+)"?/.exec(disposition)?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = named || fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Switch the session to another of the user's schools (§17.4).
 *
 * The server re-issues the session token — it does not mutate the current one —
 * so everything downstream keeps reading the school from exactly one place.
 * The caller reloads afterwards: `me`, the timetable list, the readiness score
 * and every cached view belong to the school that was active when they were
 * fetched, and a full reload is the honest way to replace all of them at once.
 */
export async function switchSchool(target: {
  tenantId?: number | null;
  id: number;
}): Promise<void> {
  const { sessionToken } = await api<{ sessionToken: string }>("/auth/switch-school", {
    method: "POST",
    // Prefer the tenant id: it is unique across databases, while a school id is
    // only unique within one (§17.5). Deployments with no registry have no
    // tenant ids and fall back to the school id, which is unambiguous there.
    body: JSON.stringify(
      target.tenantId != null ? { tenantId: target.tenantId } : { schoolId: target.id },
    ),
  });
  setToken(sessionToken);
}
