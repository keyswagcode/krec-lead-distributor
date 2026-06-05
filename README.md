# KeyRealEstateCapital — Lead Distributor

A scheduled Node + TypeScript bot that pulls cold leads from **Elementix** and
distributes them across Key Real Estate Capital's **Account Executives (AE)** and
**Associate Account Executives (AAE)** in **GoHighLevel**, balancing each rep's
workload by their count of *non-exhausted* leads.

## How it decides who gets a lead

Every new lead is cold, so routing is **capacity-balanced**, not territory-first:
each new lead goes to the rep currently carrying the **fewest non-exhausted leads**,
never exceeding that rep's configured capacity.

A lead is considered **exhausted** (and therefore no longer counts against a rep's
active load) when **either**:

1. It has accumulated **15+ outbound touchpoints**, or
2. It has **opted out** of the workflow — the GoHighLevel `dnd` flag is set, a DND
   channel is suppressed, or it carries an opt-out tag (`opted-out`, `unsubscribed`,
   `do-not-contact`, …).

Thresholds and opt-out tags live in [`src/config.ts`](src/config.ts) (`EXHAUSTION`).

## Flow each run

1. Load the rep roster from [`config/roster.json`](config/roster.json).
2. For each active rep, pull their assigned contacts from GHL and classify every
   one as active or exhausted → compute `active` count and `headroom` (capacity − active).
3. Pull that many cold leads from Elementix (business-purpose investors).
4. For each lead: unlock contact info, skip if it already exists in GHL, then assign
   it to the rep with the lowest projected active load (respecting capacity and any
   optional territory restriction).
5. Create the contact in GHL with `assignedTo`, source tags, and optional workflow
   enrollment.

## Setup

```bash
npm install
cp .env.example .env   # fill in GHL_API_TOKEN and ELEMENTIX_BEARER_TOKEN
```

Then edit [`config/roster.json`](config/roster.json) — one entry per rep with their
**GoHighLevel user ID** (the value contacts are `assignedTo`), role, and capacity.
See [`config/roster.schema.json`](config/roster.schema.json) for the full shape.

> **Finding a rep's GHL user ID:** open the rep in GoHighLevel → the user ID is the
> last path segment of the URL, or read it off any contact already assigned to them.

## Usage

```bash
npm run report     # measure current load per rep — no leads pulled or written
npm run dry-run    # full plan incl. who would get which lead — nothing written
npm start          # live: pull, assign, and create leads in GoHighLevel
npm start -- --limit=25          # cap how many leads to place this run
npm start -- --state=CA          # restrict the Elementix pull to one state
npm run typecheck  # tsc --noEmit
```

## Scheduling

The included [GitHub Actions workflow](.github/workflows/distribute.yml) runs on a
weekday-morning cron and supports manual dispatch (dry-run / report-only / live).
Add these **repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Required | Notes |
| --- | --- | --- |
| `GHL_API_TOKEN` | ✅ | GoHighLevel Private Integration token (`pit-…`) |
| `ELEMENTIX_BEARER_TOKEN` | ✅ | Elementix MCP bearer token |
| `GHL_LOCATION_ID` | optional | Defaults to the KREC location |
| `GHL_ENROLL_WORKFLOW_ID` | optional | Workflow to enroll new cold leads into |
| `GHL_TOUCHPOINT_FIELD_ID` | optional | Custom-field ID with a precomputed touchpoint count (faster than live counting) |

## Security

This is a **public repository**. No credentials are committed — all tokens come from
`.env` (git-ignored) locally or from GitHub Actions secrets in CI. `.env.example`
contains placeholders only.

## Project layout

```
config/roster.json        # the AE / AAE roster (edit this)
config/roster.schema.json # JSON schema for the roster
src/config.ts             # env + exhaustion/distribution constants
src/roster.ts             # roster load + validation
src/ghl.ts                # GoHighLevel REST client
src/elementix.ts          # Elementix MCP (JSON-RPC) client
src/touchpoints.ts        # exhausted-lead classification
src/distribute.ts         # load measurement + balancing allocator
src/index.ts              # CLI entrypoint / orchestration
```
