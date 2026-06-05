import "dotenv/config";

/**
 * GoHighLevel (LeadConnector) REST config. Conventions match the rest of the
 * KREC tooling: a Private Integration token ("pit-…") in GHL_API_TOKEN, the
 * shared KREC location, and the dated API version header.
 */
export const GHL = {
  apiBase: "https://services.leadconnectorhq.com",
  token: process.env.GHL_API_TOKEN || "",
  locationId: process.env.GHL_LOCATION_ID || "dJyVhiOEL3jUzPECFhIe",
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  /** Throttle between calls to stay under the 100-requests / 10s burst limit. */
  requestDelay: 120,
  /** Optional custom-field ID holding a precomputed touchpoint count per contact. */
  touchpointFieldId: process.env.GHL_TOUCHPOINT_FIELD_ID || "",
  /** Optional workflow to enroll newly assigned cold leads into. */
  enrollWorkflowId: process.env.GHL_ENROLL_WORKFLOW_ID || "",
};

/** Elementix MCP (JSON-RPC over HTTP) config. */
export const ELEMENTIX = {
  bearerToken: process.env.ELEMENTIX_BEARER_TOKEN || "",
  mcpUrl: process.env.ELEMENTIX_MCP_URL || "https://app.elementix.ai/api/mcp",
};

/**
 * Lead-exhaustion rules. A lead is "exhausted" — and therefore no longer counts
 * against a rep's active load — when EITHER condition holds:
 *   1. It has accumulated `exhaustedTouchCount` or more outbound touchpoints, OR
 *   2. It has opted out of the workflow (DND set, or carries an opt-out tag).
 */
export const EXHAUSTION = {
  exhaustedTouchCount: 15,
  /** Tags that mark a contact as opted out of outreach. Case-insensitive match. */
  optOutTags: ["opted-out", "opt-out", "unsubscribed", "do-not-contact", "dnc"],
  /** Which message directions count as a touchpoint. We reached out = outbound. */
  countDirections: ["outbound"] as const,
};

/** Distribution behavior. */
export const DISTRIBUTION = {
  /** Hard cap on how many leads to create+assign in a single run. */
  maxPerRun: 200,
  /** Concurrency when classifying a rep's existing contacts (touchpoint counting). */
  classifyConcurrency: 5,
};

/** Tags applied to every lead this bot creates, for traceability. */
export const TAGS = {
  source: "krec-lead-distributor",
  coldLead: "cold-lead",
};
