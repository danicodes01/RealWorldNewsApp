# Work Log

Running log of changes and decisions. Newest first. Keep entries terse — the why and the tradeoff, not the diff.

---

## Open / blocked

### Drop Site News: old article re-surfacing with today's date (regression)
**Status:** parked. `dropsitenews` commented out of `.github/workflows/scrape.yml` matrix so it doesn't run in CI until investigated. Manual `npm run scraper:dropsitenews` and `workflow_dispatch` still work for debugging.
**Symptom:** the Feb 18 Epstein/Ehud Barak article (`/p/israeli-government-surveillance-epstein-apartment-66th-street-ehud-barak`) is back at the top of the feed with today's date. This is the *same article* that the original test run correctly logged as `skipped-stale { ageDays: 75, publishedTime: "Feb 18, 2026" }`, so the regex extractor *did* work locally.
**Hypotheses (to test in order):**
1. **Substack serves different HTML to GitHub Actions IPs** — no JS context / different geolocation could make the byline `<div>Feb 18, 2026</div>` selector miss in CI even though it works locally. Then `extractPublishedTime` returns empty → freshness check skipped → Haiku called → Haiku doesn't see the date in the minimal-doc → falls back to today.
2. **Drop Site front-end recycling** — they sometimes pin old "investigation" content to the top. URL hasn't changed, so the slug-based upsert overwrites the existing row with whatever date the new run produces.
**How to debug:** in the next CI run logs (after re-enabling), grep for that exact URL. If it shows `extract-start` (not `skipped-stale`), the date extraction is failing in CI — investigation #1. If `skipped-stale` fires but the article still appears in the feed, it's coming from somewhere else — investigation #2.
**Don't re-enable** in CI until you've reproduced and fixed.

### Anthropic billing sync issue — scrapers blocked
**Status:** waiting on human escalation from Anthropic support (email sent to `support@anthropic.com` on 2026-05-02 with full request_id history).
**Symptom:** every API call returns HTTP 400 `invalid_request_error` "Your credit balance is too low" despite $30 visible balance, Tier 2 active, payment cleared, and $0/$500 monthly spend.
**Account context:**
- Org: `distort-apps`
- Workspace: `dsny` (`wrkspc_016VaQkEJskNt9JBmDZk2MRB`)
- API key: `distort-scrapers` (`sk-ant-api03-hw0...gAAA`)
- Key auth ✓ (rejection is `invalid_request_error`, not `authentication_error`) — the bug is at Anthropic's billing-balance check layer, not auth.
**Ruled out:** cross-org routing (the user also has an `Exclaim Recovery` org but credits + key are confirmed both in `distort-apps`); spend cap; tier limits; stale state (additional purchase didn't trigger resync); application-side bug (reproduces with plain curl).
**Workaround in place:** `.github/workflows/scrape.yml` cron now Mon–Fri only — saves wasted credits/runs over weekends while we wait. Revert the day-of-week field from `1-5` to `*` once Anthropic resyncs the balance.
**Failed request_ids (for support):** `req_011CacePDFmSLMsWCsHSZbpm`, `req_011CacePKDwkGxhwEwzvjekJ`, `req_011CacePRsJAF8kwoG81Tzib`, `req_011Cacej3wVMGj3JSFKBYngT`, `req_011CacejA8JyPXcZZWbfdWp7`, `req_011Cacfrq1wzd98TDfRxZt34`, `req_011CacpY15TVjHJt5XrDeF47`, `req_011CaeMG8y8fTkxt1WXrHR9t`.

---

## In progress

_Nothing in progress. Freshness-skip rollout completed 2026-05-06 (see Shipped). Drop Site parked pending regression investigation (see Open/blocked)._

---

## Decisions

### 2026-05-01 — Date extraction: deterministic in TS over Haiku-extracted
**Why:** two wins from one move. (1) Knowing the date before calling Haiku lets us skip-if-older-than-3-days and save the API call. (2) Removes ambiguity between `article:published_time` and `article:modified_time` — Haiku was nondeterministic about which it picked.
**Tradeoff:** failure mode shifts from "Haiku occasionally gets a date wrong" (graceful, scattered) to "selector breaks when source redesigns" (sudden, source-wide). Mitigation: per-source article-count summary log so a drop to zero is obvious in CI.

### 2026-05-01 — Skip prompt caching for now
**Why:** Haiku 4.5's minimum cacheable block is 1024 tokens. The current system prompt + `extract_article` tool schema is ~350 tokens combined. Adding `cache_control` would be inert. Revisit if the prompt grows or if we batch multiple articles per call.

### 2026-05-01 — Freshness rule: hard 3 days, no slop buffer
**Why:** simpler to reason about; user-stated rule is 3 days. If timezone edge cases drop a borderline article occasionally, that's acceptable. Easy to widen later if needed.

### 2026-05-01 — Keep "empty payloads → keep existing rows" rule
**Why:** I briefly tried to clear when scrape worked but no fresh payloads (to handle the "all stale" edge case). First test run hit a real Anthropic credit outage — every Haiku call 400'd, payloads were empty, and 8 Drop Site rows got wiped. Confirmed the original "keep on empty" rule is load-bearing for transient API failures (credits, rate limits, network), which are *much* more common than the all-stale edge case it would have addressed.
**How to apply:** if `payloads.length === 0`, never clear. Old rows are eventually replaced by the next successful run; "all stale" is acceptable temporary state because it'll resolve on the next run anyway.

---

## Shipped

### 2026-05-06 — Drop Site: disabled in CI matrix pending bug investigation
**File:** `.github/workflows/scrape.yml`
**What:** `- dropsitenews` commented out of the strategy matrix with a note pointing at the regression. Scheduled crons skip it; manual runs still work.
**Why:** old article re-surfacing with today's date in production. See the open/blocked entry for hypotheses.

### 2026-05-05/06 — Freshness-skip rollout completed (7 sources)
**Files:** `scrapers/sources/{aljazeera,bbc,borderlandbeat,courthousenews,democracynow,intercept,jacobin,npr}.ts`
**What:** applied the dropsite pattern to all remaining scrapers — `extractPublishedTime` + `toISO` helpers, pre-Haiku stale skip, `skippedStale / skippedOther` counters, end-of-run `summary` log line, and `toISO(publishedTime || data.date)` for ingest.
**Per-source notes:**
- **bbc, courthousenews, npr** — major outlets with all-fresh homepages; freshness skip didn't fire on test runs but the deterministic date is still the win.
- **aljazeera** — caught a 65-day "live tracker" recycled article on first run. Working as designed.
- **borderlandbeat, intercept, jacobin** — biggest cost wins (7/8/9 stale skipped on test runs); these sources publish less frequently so the homepage carries older content.
- **democracynow** — first selector attempt was wrong: page has ~11 `span.date` elements (sidebar / headlines / related stories), `.first()` matched a sidebar. Fixed by scoping to `#story_content span.date`.
**Cost picture:** test runs across all 9 sources skipped 45 of 133 candidate articles (~34%) before any Haiku call. At 3 daily runs × 5 weekdays that's roughly 675 saved Haiku calls per week from the freshness skip alone. Compounding gains across the long-running schedule.

### 2026-05-04 — Haiku: max_tokens + timeout for long-form articles
**File:** `scrapers/lib/haiku.ts`
**What:** `max_tokens 4096 → 16384`, `REQUEST_TIMEOUT_MS 75_000 → 180_000`, `REQUEST_MAX_RETRIES 3 → 2`.
**Symptom found during dropsite test run:** long Drop Site investigations (25k–76k char minimal-doc inputs) failed in two distinct ways. First with `body=false` validation errors — Haiku's tool_use response was truncated by the 4096-token cap mid-body, so `headline` parsed but `body` came back empty. After bumping `max_tokens`, Haiku now had room to finish the body but generation took 70–152s, blowing past the 75s timeout. Three retries × 75s = ~5 min wasted per failure.
**Why those numbers:** 16384 ≈ enough for a long-form body (no API cost change — you only pay for tokens generated, not the cap). 180s comfortably fits the slowest observed generation (152s). Retries reduced to 2 (Anthropic SDK default) caps worst-case wall time at ~9 min instead of ~12 while keeping resilience to transient 5xx/rate-limit errors.
**Affects:** every scraper using `extractArticle` — this is shared infrastructure. Long articles from any source were silently being lost before this.

### 2026-05-04 — Drop Site: forward TS-extracted date into Haiku prompt
**File:** `scrapers/sources/dropsitenews.ts`
**What:** `buildMinimalDoc` now accepts the TS-side ISO date and uses it as the `<time datetime="...">` fallback when `meta[article:published_time]` is missing.
**Why:** Drop Site has no `article:published_time` meta — Haiku saw no date in the prompt and either hallucinated "today" or returned `date=false`. We already have the date from the regex fallback (`extractPublishedTime`) for the freshness skip, so just forward it.

### 2026-05-06 — GitHub Actions: weekday-only is now a standing preference
**File:** `.github/workflows/scrape.yml`
**What:** cron remains `1-5` (Mon–Fri) after the merge with main. Main had switched to daily `*` with a `:07` stagger + DN-broadcast comment; we kept main's stagger/comment and re-applied weekday-only on top. `workflow_dispatch` still works for manual weekend runs.
**Why:** weekday-only was *originally* a workaround for the Anthropic billing issue. Billing is resolved, but the user wants weekday-only kept indefinitely — no weekend runs even when budget allows. Treat this as a standing schedule decision, not a workaround to revert.

### 2026-05-02 — Drop Site: pre-Haiku freshness skip + summary log
**File:** `scrapers/sources/dropsitenews.ts`
**What:** before calling `extractArticle`, check the deterministically-extracted `publishedTime`; if older than `MAX_AGE_DAYS` (3), skip the Haiku call entirely and log `skipped-stale { ageDays, publishedTime }`. Added `skippedStale / skippedPaywalled / skippedOther` counters and a `summary` log line at end of run for ops eyeballing.
**Why:** primary cost-reduction lever — every old-article Haiku call we skip is a directly avoided token charge. Also enforces the freshness rule at the cheapest point.

### 2026-05-02 — Ingest endpoint: 3-day freshness floor
**File:** `app/api/articles/route.ts`
**What:** rejects POSTs whose `date` is older than 3 days with HTTP 422 "Article older than 3-day freshness floor." Mirrors the existing future-date guard.
**Why:** defense-in-depth. Even if a future scraper forgets the pre-Haiku skip, old articles can't pollute the DB.

### 2026-05-01 — Drop Site News date extraction fix
**File:** `scrapers/sources/dropsitenews.ts`
**Symptom:** an old Drop Site article kept floating to the top of the feed with today's date.
**Root cause:** Drop Site renders dates as `<div>May 01, 2026</div>` — no `<time>` element, no datetime attr, no `article:published_time` meta. `extractPublishedTime` returned empty, fell through to Haiku, which never saw the date because `buildMinimalDoc` didn't forward that `<div>`. Then `toISO('')` returned `new Date()` — stamping every affected article with right now, sending it to the top of `date desc` order.
**Fix:** strict-regex full-match fallback (`^Month DD, YYYY$`, anchored, case-insensitive) over div/span/p/h2-4 elements. Anchors prevent V8's permissive `Date` parser from interpreting bylines as dates.
