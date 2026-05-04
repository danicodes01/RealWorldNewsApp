# Work Log

Running log of changes and decisions. Newest first. Keep entries terse — the why and the tradeoff, not the diff.

---

## Open / blocked

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

### Freshness floor + scraper cost reduction — 8 scrapers remaining
**Plan:** option (b) — infra first (done), then per-scraper date hoist + pre-Haiku stale-skip, one source per PR so regressions are easy to attribute.
**Done:** `dropsitenews` (was already deterministic after the May 1 date fix, so it was the cheapest first conversion).
**Remaining (in any order):** `aljazeera`, `bbc`, `borderlandbeat`, `courthousenews`, `democracynow`, `intercept`, `jacobin`, `npr`.
**Per-source pattern:** read `meta[property="article:published_time"]` (and `<time datetime>`) directly in TS → if older than `MAX_AGE_DAYS` skip Haiku entirely → otherwise pass to Haiku as today. Also add the `skippedStale / skippedPaywalled / skippedOther` counters + `summary` log line.
**Don't start until** the Anthropic billing issue is resolved, otherwise we can't verify each conversion end-to-end.

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

### 2026-05-02 — GitHub Actions: weekdays only
**File:** `.github/workflows/scrape.yml`
**What:** cron day-of-week field changed from `*` to `1-5` on all three schedules (11:00 / 15:00 / 21:00 UTC). `workflow_dispatch` still works for manual weekend runs.
**Why:** while the Anthropic billing issue is unresolved, every scheduled run wastes a CI minute and (once unblocked) would burn API calls without delivering value over the weekend. Revert to `*` once unblocked.

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
