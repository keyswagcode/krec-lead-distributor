import { ELEMENTIX } from "./config.js";

/**
 * Minimal JSON-RPC 2.0 client for the Elementix MCP HTTP server, adapted from
 * the KREC morning-bot. Set ELEMENTIX_BEARER_TOKEN in .env to use live.
 *
 * The server speaks SSE (text/event-stream) for replies and caps tool output at
 * ~40 KB, so list_people must be paged one row at a time.
 */

let nextId = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Transient body-level errors arrive as HTTP 200 with an isError payload. */
const RETRYABLE_BODY = /429|rate limit|too many requests|timeout|ETIMEDOUT|ECONNRESET|temporarily|503|502|504/i;

async function rpcOnce(method: string, params: any): Promise<any> {
  const body = { jsonrpc: "2.0", id: nextId++, method, params };
  const resp = await fetch(ELEMENTIX.mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${ELEMENTIX.bearerToken}`,
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 429 || resp.status >= 500) {
    const e: any = new Error(`Elementix MCP ${method}: HTTP ${resp.status}`);
    e.retryable = true;
    throw e;
  }
  if (!resp.ok) throw new Error(`Elementix MCP ${method}: ${resp.status} ${await resp.text()}`);

  const raw = await resp.text();
  const ct = resp.headers.get("content-type") || "";
  let data: any;
  if (ct.includes("text/event-stream") || /^\s*(event|data):/.test(raw)) {
    const msgs = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    data =
      msgs.find((m: any) => m && (m.result !== undefined || m.error !== undefined)) ??
      msgs[msgs.length - 1];
    if (!data) throw new Error(`Elementix MCP ${method}: unparseable SSE response: ${raw.slice(0, 200)}`);
  } else {
    data = JSON.parse(raw);
  }
  if (data.error) throw new Error(`Elementix MCP ${method} error: ${JSON.stringify(data.error)}`);
  const text = data.result?.content?.[0]?.text;
  if (data.result?.isError && typeof text === "string" && RETRYABLE_BODY.test(text)) {
    const e: any = new Error(`Elementix MCP ${method}: ${text.slice(0, 80)}`);
    e.retryable = true;
    throw e;
  }
  return data.result;
}

async function rpc(method: string, params: any): Promise<any> {
  if (!ELEMENTIX.bearerToken) {
    throw new Error("ELEMENTIX_BEARER_TOKEN not set — cannot call Elementix live");
  }
  const backoffs = [3000, 8000, 20000, 40000, 60000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce(method, params);
    } catch (err: any) {
      const retryable =
        err?.retryable ||
        /fetch failed|ECONNRESET|ETIMEDOUT|network|socket|terminated/i.test(err?.message || "");
      if (!retryable || attempt >= backoffs.length) throw err;
      await sleep(backoffs[attempt]);
    }
  }
}

/** Sentinel for a tool response truncated by the server's ~40 KB output cap. */
const TRUNCATED = { __truncated: true } as const;

async function callTool(name: string, args: Record<string, any>): Promise<any> {
  const result = await rpc("tools/call", { name, arguments: args });
  const content = result?.content?.[0];
  if (content?.type === "text" && content.text) {
    try {
      return JSON.parse(content.text);
    } catch {
      if (content.text.includes("[TRUNCATED") || content.text.length >= 39_000) return TRUNCATED;
      return content.text;
    }
  }
  return result;
}

export interface ElementixPerson {
  uuid: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  [k: string]: any;
}

/** Drop bulky base64 lender-logo blobs that bloat each row to ~30 KB. */
function stripLogos(p: any): void {
  if (!p || typeof p !== "object") return;
  delete p._logoDataUri;
  if (Array.isArray(p.topLenders)) {
    for (const l of p.topLenders) if (l && typeof l === "object") delete l._logoDataUri;
  }
}

/**
 * Pull up to `limit` people from Elementix matching the given filters. Pages one
 * row at a time (server output cap) and skips oversized/truncated rows.
 */
export async function listPeople(args: {
  state?: string;
  countyName?: string[];
  city?: string[];
  loanAmountMin?: number;
  loanAmountMax?: number;
  loansMin?: number;
  isBusinessPurpose?: boolean;
  lenderType?: readonly string[];
  sortBy?: "loanCount" | "totalVolume" | "unlockedAt";
  limit?: number;
}): Promise<ElementixPerson[]> {
  const params: Record<string, any> = {
    scope: "data",
    sortBy: args.sortBy ?? "totalVolume",
    sortOrder: "desc",
  };
  if (args.state) params.state = [args.state];
  if (args.countyName?.length) params.countyName = args.countyName;
  if (args.city?.length) params.city = args.city;
  if (args.loanAmountMin != null) params.amountMin = args.loanAmountMin;
  if (args.loanAmountMax != null) params.amountMax = args.loanAmountMax;
  if (args.loansMin != null && args.loansMin > 0) params.loansMin = args.loansMin;
  if (args.isBusinessPurpose != null) params.isBusinessPurpose = args.isBusinessPurpose;
  if (args.lenderType?.length) params.lenderType = [...args.lenderType];

  const want = args.limit ?? 25;
  const people: ElementixPerson[] = [];
  const seen = new Set<string>();
  const maxPages = want * 5 + 50;
  for (let page = 1, dupeStreak = 0; people.length < want && page <= maxPages; page++) {
    const result = await callTool("list_people", { ...params, perPage: 1, page });
    if (result?.__truncated) continue; // oversized row — skip, keep walking
    const batch: any[] = result?.people || result?.data || result?.items || [];
    if (!batch.length) break; // parseable empty page — territory exhausted
    let added = 0;
    for (const p of batch) {
      const id = p?.id || p?.uuid;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      stripLogos(p);
      people.push(p as ElementixPerson);
      added++;
    }
    if (added === 0) {
      if (++dupeStreak >= 3) break;
    } else {
      dupeStreak = 0;
    }
  }
  return people;
}

async function getContactStatus(personId: string): Promise<{ isUnlocked?: boolean }> {
  return callTool("get_contact_status", { personId });
}
async function submitContactEnrichment(personId: string): Promise<any> {
  return callTool("submit_contact_enrichment", { personId });
}
async function getContactInfo(personId: string): Promise<any> {
  return callTool("get_contact_info", { personId });
}

/**
 * Ensure a person's contact info is unlocked, then return phone + email.
 * Charges Elementix credits only on the first unlock per organization.
 */
export async function ensureUnlockedContact(
  personId: string,
  opts: { maxWaitMs?: number; pollIntervalMs?: number } = {},
): Promise<{ phone?: string; email?: string }> {
  const maxWait = opts.maxWaitMs ?? 90_000;
  const poll = opts.pollIntervalMs ?? 2000;

  const status = await getContactStatus(personId);
  if (!status?.isUnlocked) await submitContactEnrichment(personId);

  const start = Date.now();
  let info: any = null;
  while (Date.now() - start < maxWait) {
    info = await getContactInfo(personId);
    const s = info?.status || info?.job?.status;
    if (s === "COMPLETED") break;
    if (s === "ERROR") throw new Error(`Elementix enrichment ERROR for ${personId}`);
    await sleep(poll);
  }
  return extractContact(info);
}

function extractContact(info: any): { phone?: string; email?: string } {
  if (!info) return {};
  const result = info.job?.result ?? info.result;
  const phone =
    result?.phone?.[0]?.value ||
    result?.phones?.[0]?.value ||
    info.phone ||
    info.contact?.phone ||
    info.phones?.[0]?.value ||
    info.phones?.[0];
  const email =
    result?.email?.[0]?.value ||
    result?.emails?.[0]?.value ||
    info.email ||
    info.contact?.email ||
    info.emails?.[0]?.value ||
    info.emails?.[0];
  return { phone, email };
}
