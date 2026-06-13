import { GHL } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status codes worth retrying: rate limit + transient upstream/timeout errors. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const GHL_BACKOFFS = [1000, 3000, 8000, 20000, 40000];
/** Per-request ceiling. A hung request is aborted and retried, not left to stall. */
const REQUEST_TIMEOUT_MS = 25_000;
/**
 * Body text marking a transient failure dressed up under a non-retryable status —
 * e.g. a 401 "Command timed out" or a 400 "Failed to fetch details. Please try
 * again later" — both of which succeed on retry.
 */
const TRANSIENT_BODY = /timed out|timeout|etimedout|try again later|failed to fetch|temporarily|rate limit|too many requests/i;

/**
 * Single choke point for every GoHighLevel HTTP call. Applies the inter-request
 * delay, enforces a per-request timeout, then retries transient failures with
 * exponential backoff — honoring `Retry-After` when present. The GHL burst limit
 * (100 req / 10s) is easy to trip when classifying many contacts, and individual
 * conversation reads occasionally time out (sometimes surfaced as a 401 with a
 * "Command timed out" body), so without this a single hiccup would abort the run.
 */
async function ghlFetch(url: string, init: RequestInit, label: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await sleep(GHL.requestDelay);
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // Network error or abort (timeout) — retry until we run out of backoffs.
      if (attempt >= GHL_BACKOFFS.length) throw err;
      await sleep(GHL_BACKOFFS[attempt]);
      continue;
    }
    if (resp.ok) return resp.json();
    const bodyText = await resp.text();
    const retryable = RETRYABLE_STATUS.has(resp.status) || TRANSIENT_BODY.test(bodyText);
    if (retryable && attempt < GHL_BACKOFFS.length) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : GHL_BACKOFFS[attempt];
      await sleep(wait);
      continue;
    }
    throw new Error(`GHL ${label}: ${resp.status} ${bodyText}`);
  }
}

async function apiGet(endpoint: string, params?: Record<string, string | number>): Promise<any> {
  const url = new URL(`${GHL.apiBase}${endpoint}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return ghlFetch(url.toString(), { headers: GHL.headers }, `GET ${endpoint}`);
}

async function apiPost(endpoint: string, data: Record<string, any>): Promise<any> {
  return ghlFetch(
    `${GHL.apiBase}${endpoint}`,
    { method: "POST", headers: GHL.headers, body: JSON.stringify(data) },
    `POST ${endpoint}`,
  );
}

// --- Types ---

export interface GHLContact {
  id: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  assignedTo?: string;
  tags?: string[];
  dnd?: boolean;
  dndSettings?: Record<string, { status?: string }>;
  dateAdded?: string;
  state?: string;
  customFields?: Array<{ id: string; value: string }>;
}

// --- Contacts ---

/**
 * POST /contacts/search — server-side filter by assignedTo. Pages through all
 * contacts currently owned by a given rep (their book of business).
 * https://highlevel.stoplight.io/docs/integrations/dbb0a39b219c0-search-contacts
 */
export async function searchContactsByAssignedTo(userId: string, pageLimit = 500): Promise<GHLContact[]> {
  const all: GHLContact[] = [];
  let page = 1;
  while (true) {
    const data = await ghlFetch(
      `${GHL.apiBase}/contacts/search`,
      {
        method: "POST",
        headers: GHL.headers,
        body: JSON.stringify({
          locationId: GHL.locationId,
          pageLimit,
          page,
          filters: [{ field: "assignedTo", operator: "eq", value: userId }],
        }),
      },
      "search contacts",
    );
    const contacts: GHLContact[] = data.contacts || [];
    if (contacts.length === 0) break;
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
    if (page > 200) break; // safety bound
  }
  return all;
}

/**
 * Find an existing contact by email or phone. Returns the first match (with its
 * assignedTo) or null — used to skip leads already owned by a rep so we never
 * poach an existing contact from one rep to another.
 */
export async function findContactByEmailOrPhone(email?: string, phone?: string): Promise<GHLContact | null> {
  const tryFilter = async (field: string, value: string): Promise<GHLContact | null> => {
    try {
      const data = await ghlFetch(
        `${GHL.apiBase}/contacts/search`,
        {
          method: "POST",
          headers: GHL.headers,
          body: JSON.stringify({
            locationId: GHL.locationId,
            pageLimit: 1,
            page: 1,
            filters: [{ field, operator: "eq", value }],
          }),
        },
        "lookup contact",
      );
      return (data.contacts && data.contacts[0]) || null;
    } catch {
      // Lookup failure shouldn't abort a run — treat as "not found" so the
      // caller proceeds to create the lead rather than crashing.
      return null;
    }
  };
  if (email) {
    const c = await tryFilter("email", email);
    if (c) return c;
  }
  if (phone) {
    const c = await tryFilter("phone", phone);
    if (c) return c;
  }
  return null;
}

export async function upsertContact(payload: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  source?: string;
  assignedTo?: string;
  tags?: string[];
}): Promise<{ contact: GHLContact; new: boolean }> {
  const data = await apiPost("/contacts/upsert", { locationId: GHL.locationId, ...payload });
  return { contact: data.contact || data, new: !!data.new };
}

// --- Conversations (touchpoint counting) ---

export async function searchConversationsForContact(contactId: string): Promise<Array<{ id: string }>> {
  const data = await apiGet("/conversations/search", {
    locationId: GHL.locationId,
    contactId,
  });
  return data.conversations || [];
}

export interface GHLMessage {
  id?: string;
  direction?: "inbound" | "outbound";
  messageType?: string;
}

export async function getMessages(conversationId: string, limit = 100): Promise<GHLMessage[]> {
  const data = await apiGet(`/conversations/${conversationId}/messages`, { limit });
  const mm = data.messages;
  if (mm && typeof mm === "object" && Array.isArray(mm.messages)) return mm.messages;
  return Array.isArray(mm) ? mm : [];
}

/**
 * Add one or more tags to an existing contact. Idempotent on GHL's side — tags
 * already present are left unchanged — but callers should still skip contacts
 * that already carry the tag to avoid needless writes against the rate limit.
 * POST /contacts/{id}/tags  body: { tags: [...] }
 */
export async function addContactTags(contactId: string, tags: string[]): Promise<void> {
  await apiPost(`/contacts/${contactId}/tags`, { tags });
}

// --- Workflow enrollment ---

export async function addContactToWorkflow(contactId: string, workflowId: string): Promise<any> {
  return apiPost(`/contacts/${contactId}/workflow/${workflowId}`, {});
}
