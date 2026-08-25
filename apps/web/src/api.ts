const TOKEN_KEY = "edutimetable.session";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
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
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
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
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
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
