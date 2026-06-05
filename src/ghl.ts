import { GHL } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiGet(endpoint: string, params?: Record<string, string | number>): Promise<any> {
  await sleep(GHL.requestDelay);
  const url = new URL(`${GHL.apiBase}${endpoint}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const resp = await fetch(url.toString(), { headers: GHL.headers });
  if (!resp.ok) throw new Error(`GHL GET ${endpoint}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function apiPost(endpoint: string, data: Record<string, any>): Promise<any> {
  await sleep(GHL.requestDelay);
  const resp = await fetch(`${GHL.apiBase}${endpoint}`, {
    method: "POST",
    headers: GHL.headers,
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`GHL POST ${endpoint}: ${resp.status} ${await resp.text()}`);
  return resp.json();
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
    await sleep(GHL.requestDelay);
    const resp = await fetch(`${GHL.apiBase}/contacts/search`, {
      method: "POST",
      headers: GHL.headers,
      body: JSON.stringify({
        locationId: GHL.locationId,
        pageLimit,
        page,
        filters: [{ field: "assignedTo", operator: "eq", value: userId }],
      }),
    });
    if (!resp.ok) throw new Error(`GHL search contacts: ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
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
    await sleep(GHL.requestDelay);
    const resp = await fetch(`${GHL.apiBase}/contacts/search`, {
      method: "POST",
      headers: GHL.headers,
      body: JSON.stringify({
        locationId: GHL.locationId,
        pageLimit: 1,
        page: 1,
        filters: [{ field, operator: "eq", value }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.contacts && data.contacts[0]) || null;
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

// --- Workflow enrollment ---

export async function addContactToWorkflow(contactId: string, workflowId: string): Promise<any> {
  return apiPost(`/contacts/${contactId}/workflow/${workflowId}`, {});
}
