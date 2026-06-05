import { EXHAUSTION, GHL } from "./config.js";
import {
  GHLContact,
  getMessages,
  searchConversationsForContact,
} from "./ghl.js";

export interface Classification {
  contactId: string;
  touchpoints: number;
  optedOut: boolean;
  /** A lead is exhausted when it opted out OR hit the touchpoint threshold. */
  exhausted: boolean;
}

const COUNT_DIRECTIONS = new Set<string>(EXHAUSTION.countDirections);

/** Opted out = DND flag set, any DND channel active, or an opt-out tag present. */
export function isOptedOut(contact: GHLContact): boolean {
  if (contact.dnd) return true;
  if (contact.dndSettings) {
    for (const ch of Object.values(contact.dndSettings)) {
      if (ch?.status && ch.status !== "active" && ch.status !== "inactive") {
        // GHL marks suppressed channels with statuses like "permanent"/"all".
        return true;
      }
    }
  }
  const tags = (contact.tags || []).map((t) => t.toLowerCase());
  return EXHAUSTION.optOutTags.some((t) => tags.includes(t));
}

/**
 * Read a precomputed touchpoint count from a configured GHL custom field, if any.
 * Returns null when no field is configured or the contact lacks a value, so the
 * caller falls back to counting conversation messages.
 */
function touchpointsFromCustomField(contact: GHLContact): number | null {
  if (!GHL.touchpointFieldId) return null;
  const f = (contact.customFields || []).find((cf) => cf.id === GHL.touchpointFieldId);
  if (!f) return null;
  const n = Number(f.value);
  return Number.isFinite(n) ? n : null;
}

/** Count outbound touchpoints for a contact by walking its conversations. */
async function countTouchpointsLive(contactId: string): Promise<number> {
  const convos = await searchConversationsForContact(contactId);
  let count = 0;
  for (const c of convos) {
    const msgs = await getMessages(c.id);
    for (const m of msgs) {
      if (m.direction && COUNT_DIRECTIONS.has(m.direction)) count++;
    }
  }
  return count;
}

/**
 * Classify one contact as exhausted or not. Opt-out short-circuits (no need to
 * count messages). Otherwise prefer the custom-field fast path, then fall back
 * to live message counting.
 */
export async function classifyContact(contact: GHLContact): Promise<Classification> {
  const optedOut = isOptedOut(contact);
  if (optedOut) {
    return { contactId: contact.id, touchpoints: 0, optedOut: true, exhausted: true };
  }
  const fast = touchpointsFromCustomField(contact);
  const touchpoints = fast ?? (await countTouchpointsLive(contact.id));
  return {
    contactId: contact.id,
    touchpoints,
    optedOut: false,
    exhausted: touchpoints >= EXHAUSTION.exhaustedTouchCount,
  };
}
