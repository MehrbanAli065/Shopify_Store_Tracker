# Sales Curve Audit — Formulas, Variables & Time Periods

**Reference specification for document SCA-2025-1187 (Marigold Studio audit).**
Documents every number in the audit: its formula, time window, data source, and edge cases. Written from the seat of a Shopify category planner — variant-level, stockout-corrected, returns-aware, lead-time-honest. An engineer should be able to build the audit engine from this file alone.

---

## 1 · Standard time periods

Every variable in this document names one of these windows. Defining them once keeps the audit internally consistent.

| Symbol | Window | Length | Purpose |
|---|---|---|---|
| **T₀** | Analysis window | 90 days · Sep 1 – Nov 30, 2025 | The look-back the audit reads |
| **T_w** | Current velocity window | Trailing 28 days inside T₀ | Current rate-of-sale |
| **T_f** | Forward projection window | 90 days · Dec 1 – Feb 28 | Opportunity projection |
| **T_s** | Fashion season | 14 weeks (98 days) | Remaining-season-weeks math |
| **T_l** | Lead time | Per-SKU, per-supplier | Reorder-fit decision |
| **T_r** | Returns recognition window | 30 days post-sale | Net-of-returns adjustment |
| **T_bis** | Waitlist signal window | Rolling 60 days | BIS as forward-demand evidence |
| **T_age** | Age-bucket cutoffs | 30 / 60 / 90 / 120 days in stock | Markdown candidacy |

### Why these windows
- **T_w = 28 days** because 7 captures noise, 90 lags trend changes, 28 is the operator standard for current velocity.
- **T_r = 30 days** because ~91% of fashion returns land within 30 days of delivery; the long tail is accrued as a constant background rate.
- **T_s = 14 weeks** is the typical contemporary brand season. Override per-merchant if their cadence differs (denim runs longer, swim shorter).
- **T_bis = 60 days** because BIS signups older than 60 days re-engage on restock under 18% of the time — beyond that, signal value collapses.

---

## 2 · Data inputs

Sources and refresh cadence. Each formula below names which source(s) it uses.

| Source | Surface | Fields used | Refresh |
|---|---|---|---|
| **Shopify Admin** | GraphQL Admin API | `Product`, `ProductVariant`, `InventoryLevel`, `Order`, `Fulfillment`, `Refund` | Webhook + nightly reconciliation |
| **Shopify Inventory** | REST inventory + locations | `inventory_item_id × location_id` | Webhook |
| **Stocky / Inventory Planner** | Native or partner app | Open POs, expected receipt dates, supplier lead-time history | Daily |
| **Loop Returns** | Loop API | Return reasons, return rate by SKU, return rate by size | Daily |
| **Klaviyo** | Klaviyo API | Back-in-stock list, profile counts per variant | Hourly |
| **Meta Ads** | Marketing API | Spend, impressions, clicks, conversions by product_id × day | Daily |
| **Google Ads / Merchant Center** | Ads + Content API | Spend per product_id × day, feed status | Daily |
| **GA4 / Shopify analytics** | GA4 export or Shopify | Sessions, PDP views, add-to-cart by variant | Daily |

---

## 3 · Universal definitions

Terms used throughout. All variant-level unless explicitly aggregated.

- **Variant** — a unique `(product_id, variant_id, location_id)` tuple. Never aggregate to product unless explicitly stated.
- **AUR** — Average Unit Retail = revenue ÷ units sold over the relevant window, **net of discount and returns**.
- **ROS** — Rate of Sale = net units sold per day, computed over T_w.
- **Net STR** — Net Sell-Through = `(units_sold − units_returned) ÷ units_received_into_inventory` for the period.
- **Cover** — Weeks of stock remaining at current ROS = `on_hand_units ÷ (ROS × 7)`.
- **OOS-day** — Any day at any location where `inventory_level ≤ 0` for the variant.
- **Core size** — For womenswear: S, M, L. For menswear: M, L. For denim: the modal three waists. Configurable per merchant.
- **Broken size** — A style where at least one core size has `OOS-days > 0` while a sibling size remains in stock and selling.
- **Stockout-corrected demand** — Demand inferred from in-stock days only, not raw period sales.
- **Bestseller** — Top decile of styles by net unit sales in T₀, computed at product level for ranking purposes.

---

## 4 · Section-by-section formulas

The structure below mirrors the audit document exactly.

---

### 4.1 Section 01 — The Headline

#### **Total opportunity — $847K** (`total_opportunity`)
- **Definition**: Aggregate of all recoverable opportunity types over T_f.
- **Formula**: `total_opportunity = broken_size_opportunity + markdown_avoidance + wasted_ad_recapture + reorder_chase_lift`
- **Period**: T_f (forward 90 days), projected from T₀ signals.
- **Notes**: This is the *identified* upper bound. Realistic capture (after execution friction) shown in Section 4.9 trajectory at ~$420K revenue, ~$144K ad efficiency, ~$58K margin saved.

#### **Styles read — 84** (`style_count`)
- **Definition**: Distinct `product_id` with at least one order in T₀.
- **Formula**: `count(distinct product_id where order_count_T0 > 0 and status = 'active')`
- **Period**: T₀.
- **Source**: Shopify Admin.

#### **Variants analysed — 1,247** (`variant_count`)
- **Definition**: Distinct `(product_id, variant_id, location_id)` tuples active in T₀.
- **Formula**: `count(distinct (product_id, variant_id, location_id) where status = 'active' in T0)`
- **Period**: T₀.
- **Source**: Shopify Admin + InventoryLevel.

#### **Net sell-through — 41%** (`net_str_reported`)
- **Definition**: Sell-through as Shopify and Stocky report it — gross of stockout effects.
- **Formula**: `(units_sold_T0 − units_returned_within_T_r) ÷ (opening_inventory_T0 + units_received_T0)`
- **Period**: T₀, with returns matched within T_r post-sale.
- **Source**: Shopify Orders + Refunds, Loop Returns.

#### **Target STR — 60%**
- **Definition**: Merchant's pre-stated period target. Defaults to category benchmark if not provided.
- **Source**: Merchant input, or category benchmark (contemporary basics: 60%; denim: 55%; activewear: 65%).

#### **Bestsellers broken by week 8 — 47%** (`broken_pct_w8`)
- **Definition**: Share of bestsellers where any core size hit OOS by week 8 of T_s.
- **Formula**:
  ```
  bestsellers = top_decile(styles, by = net_units_sold_T0)
  broken_w8   = count(bestsellers where exists core_size with OOS_days_by_week_8 ≥ 3)
  broken_pct  = broken_w8 ÷ count(bestsellers)
  ```
- **Period**: First 8 weeks of T_s.
- **Note**: The 3-day threshold avoids false positives from one-day inventory dips.

---

### 4.2 Section 02 — The Opportunity Stack

#### **Broken size opportunity — $387K** (`broken_size_opportunity`)
- **Definition**: Revenue lost when bestsellers go broken-size, projected forward and made recoverable through reorder + pack-ratio correction.
- **Formula**:
  ```
  For each variant V where:
    (a) parent style is a bestseller (top decile)
    (b) V is a core size
    (c) sibling core sizes still selling at ≥50% pre-OOS velocity
        (proves demand was there, style isn't generally fading)

  lost_units_V    = avg_velocity_pre_OOS_V × OOS_days_V_in_T0
  lost_revenue_V  = lost_units_V × AUR_V

  broken_size_opportunity = Σ_V lost_revenue_V
  ```
- **Period**: Lost calculated over T₀; opportunity expressed against T_f assuming reorder lands.
- **Sources**: Shopify Orders, InventoryLevel, Stocky lead-time data.
- **Notes**: Filter (c) is critical — without it, a generally-slowing style's drop in sibling sizes gets miscredited to broken size.

#### **Markdown avoidance — $216K** (`markdown_avoidance`)
- **Definition**: Margin preserved by walking down identified residuals earlier and shallower than waiting for terminal markdown.
- **Formula**:
  ```
  For each variant V in age bucket ≥ 60 days AND cover ≥ 18 weeks:
    terminal_loss_V     = on_hand_V × AUR_V × d_terminal × (1 − v_terminal)
    recommended_loss_V  = on_hand_V × AUR_V × d_now × (1 − v_now)

    avoided_margin_V    = terminal_loss_V − recommended_loss_V

  markdown_avoidance = Σ_V avoided_margin_V
  ```
  where:
  - `d_terminal` = depth at end-of-season clearance (default 50%)
  - `d_now` = recommended depth now (per Section 3 framework in the planner skill: 20–30% typical)
  - `v_terminal` = velocity capture at terminal depth (typically 0.7–0.85)
  - `v_now` = velocity capture at recommended depth (typically 0.75–0.95)
- **Period**: Decision made on T₀ state; impact realised in T_f.
- **Sources**: Shopify Inventory, Orders, historical elasticity by category if available.

#### **Wasted ad spend — $144K** (`wasted_ad_spend`)
- **Definition**: Paid traffic from Meta + Google that landed on a PDP already OOS at the visitor's primary demand size.
- **Formula**:
  ```
  For each ad spend record (day, product, dollars):
    visitors      = clicks(day, product)
    likely_size_distribution = P(size | visitor, product)
    OOS_size_share(day, product) = Σ_size P(size) × indicator(variant_OOS_at(day, product, size))

    wasted_dollars = dollars × OOS_size_share

  wasted_ad_spend = Σ wasted_dollars over T0
  ```
- **Period**: T₀, joined daily.
- **Sources**: Meta Marketing API, Google Ads, Shopify InventoryLevel snapshot per day.
- **Notes on `P(size | visitor, product)`**:
  - Returning customer with past purchase → past size at 70% weight + population mode at 30%
  - Cold visitor → population mode for the category (e.g., M for womenswear basics)
  - For 2D matrices (denim waist × inseam), `P` is a joint distribution

#### **Reorder chase lift — $100K** (`reorder_chase_lift`)
- **Definition**: Contribution recoverable on variants where lead time still fits remaining season weeks, net of airfreight.
- **Formula**:
  ```
  For each variant V where:
    remaining_season_weeks − lead_time_weeks_V ≥ 3

  chase_units_V    = min(
    velocity_T_w_V × remaining_sellable_weeks_V × (1 + safety_buffer),
    MOQ_V,
    cash_headroom_units_V
  )

  contribution_V = chase_units_V × projected_STR_V × (AUR_V × GM%_V − airfreight_per_unit_V)

  reorder_chase_lift = Σ_V contribution_V
  ```
- **Period**: T_f.
- **Sources**: Stocky lead-time history, supplier MOQs, freight quotes.
- **Notes**: `safety_buffer` = 15% default; tighter (8–10%) for fashion variants, looser (20%) for NOOS basics.

---

### 4.3 Section 03a — Buy curve vs Sell curve (Tops)

#### **Planned pack ratio — [20, 20, 20, 20, 20]** (`planned_pack[size]`)
- **Definition**: Distribution of units across sizes as actually purchased on the relevant PO.
- **Formula**: `planned_pack[size] = units_ordered[size] ÷ Σ_size units_ordered`
- **Period**: The PO covering the T₀ category buy (typically placed 60–120 days before T₀ start).
- **Source**: Stocky / Inventory Planner PO history.

#### **Actual sell-through — [14, 28, 32, 18, 8]** (`actual_str[size]`)
- **Definition**: Share of net units sold by size, for the category, over T₀.
- **Formula**: `actual_str[size] = net_units_sold[size, category] ÷ Σ_size net_units_sold[size, category]`
- **Period**: T₀.
- **Source**: Shopify Orders + Refunds.
- **Notes**: Aggregated to category (tops, bottoms, dresses, knitwear). Computed per-category, not store-wide — different categories have legitimately different curves.

#### **62% of XL residuals will terminal-markdown** (`xl_residual_risk`)
- **Definition**: Share of XL on-hand inventory that will reach terminal markdown at end of T_s without correction.
- **Formula**:
  ```
  for each style with XL on hand:
    forecast_XL_velocity = ROS_XL × historical_decay_factor_w10_to_w14
    projected_units_sold_remaining = forecast_XL_velocity × remaining_season_weeks
    projected_residual = max(0, on_hand_XL − projected_units_sold_remaining)

  xl_residual_risk = Σ projected_residual ÷ Σ on_hand_XL
  ```
- **Period**: From now to end of T_s.
- **Sources**: Historical category-level decay curves (24-month look-back), current inventory.

---

### 4.4 Section 03b — Stockout-corrected demand

#### **Shopify-reported STR — 41%** (`net_str_reported`)
- See Section 4.1. This is the raw figure visible in Shopify/Stocky.

#### **Stockout-corrected STR — 58%** (`net_str_corrected`)
- **Definition**: Demand-side STR — what STR would have been if every variant had been fully in-stock the whole period.
- **Formula**:
  ```
  in_stock_variant_days = Σ_V days_in_stock_V in T0
  baseline_velocity_per_in_stock_day = (units_sold + bis_signups − returns) ÷ in_stock_variant_days

  projected_full_period_demand = baseline_velocity_per_in_stock_day × total_variant_days_in_T0
  
  net_str_corrected = projected_full_period_demand ÷ (opening_inventory + receipts)
  ```
- **Period**: T₀.
- **Sources**: Shopify Orders + Refunds, InventoryLevel daily snapshots, Klaviyo BIS.
- **Notes**: This number is the single biggest "WOW" of the audit. It tells the operator what they could have sold if they hadn't been broken. The math must be defensible — show the 3 inputs in any deep-dive view.

#### **Latent demand gap — +17 pts** (`latent_demand_gap`)
- **Formula**: `latent_demand_gap = net_str_corrected − net_str_reported`

#### **Variant-days OOS — 312** (`oos_variant_days`)
- **Formula**: `Σ_V count(day ∈ T0 : inventory_level_V(day) ≤ 0)`
- **Period**: T₀.
- **Source**: Shopify InventoryLevel daily snapshot.

#### **BIS signups — 1,840** (`bis_signups`)
- **Formula**: `count(distinct (customer_email, variant_id) signups in T_bis where variant was OOS at time of signup)`
- **Period**: T_bis (rolling 60 days).
- **Source**: Klaviyo.

---

### 4.5 Section 03c — Broken size timeline

#### **Week each SKU broke** (`week_broken_S`)
- **Definition**: First week in T_s where the style lost at least one core size.
- **Formula**:
  ```
  for each style S in top_7:
    week_broken_S = min(w ∈ [1..14] :
      exists core_size c such that inventory_level(S, c, day_3_of_week_w) ≤ 0
      AND OOS persists ≥ 3 consecutive days
    )
  ```
- **Period**: T_s for the relevant season.
- **Source**: Shopify InventoryLevel daily snapshot.

#### **Loss per SKU** (`loss_per_sku`)
- **Definition**: Revenue lost from the week the style broke until end of T₀ (or end of T_s if shorter).
- **Formula**:
  ```
  for each style S:
    loss_per_sku_S = Σ_(core sizes c that broke) [
      avg_velocity_pre_OOS_S_c × OOS_days_c_after_week_broken × AUR_S_c
    ]
  ```
- **Period**: From `week_broken_S` to end of T₀.
- **Sources**: Shopify Orders, InventoryLevel.

#### **Top 7 selection**
- **Definition**: Top 7 styles by net unit sales in T₀, regardless of broken-size status.
- **Formula**: `top_7 = arg_top_7(styles, by = net_units_sold_T0)`
- **Note**: Selected by sales, not by loss — this is "of your top sellers, here's how many broke." Selecting by loss would bias toward styles that broke worst, which is interesting but a different question.

---

### 4.6 Section 03d — Wasted ad spend

#### **Spend on OOS-at-size PDPs — $144K** — see Section 4.2.

#### **Share of total paid spend — 11.4%** (`waste_share`)
- **Formula**: `waste_share = wasted_ad_spend ÷ total_paid_spend_T0`
- **Period**: T₀.

#### **Sessions hit "Out of stock" — 31,800** (`oos_sessions`)
- **Definition**: Sessions where the user attempted to select an OOS size (PDP size-selector interaction OR add-to-cart attempt that failed).
- **Formula**: `count(distinct session_id where any OOS size-select or failed-ATC event occurred)`
- **Period**: T₀.
- **Source**: GA4 events + Shopify analytics.

#### **47 distinct variants** (`oos_during_active_ad`)
- **Definition**: Variants that were OOS while an active ad set was bidding to send traffic to them.
- **Formula**: `count(distinct variant_id where exists day d ∈ T0 : OOS(d) AND ad_active(d, variant_id))`
- **Source**: Shopify InventoryLevel × Meta/Google ad-status feed.

#### **CR 0.4% on OOS sessions vs 3.1% site-wide** (`cr_oos`, `cr_site`)
- **Formula**: `cr = orders ÷ sessions`
- **Period**: T₀.
- **Sources**: GA4 / Shopify.

---

### 4.7 Section 04 — The Three Plays

The plays are explicit *captures* of the opportunities surfaced in Sections 02 and 03 — discounted for realistic execution.

#### **Play 01 — Reorder lift — +$324K** (`play_01_lift`)
- **Formula**:
  ```
  play_01_lift = Σ_(7 recipe variants) [
    reorder_qty_V × projected_STR_V × (AUR_V × GM%_V − airfreight_V) × execution_capture
  ]
  ```
- **Period**: T_f, applied as reorders land (typically weeks 3–7 depending on lead time).
- **Notes**: `execution_capture` defaults to 0.70 — accounts for partial PO landing, supplier slip, possible cancellation.
- **Reconciliation**: $324K is a subset of the $387K broken-size opportunity in Section 02 because (a) execution capture < 1, and (b) Section 02 includes the long tail beyond the top 7 reorder candidates.

#### **Play 02 — Ad spend recapture — +$144K** (`play_02_recapture`)
- **Formula**: `play_02_recapture = wasted_ad_spend × pause_capture_rate`
- **Pause capture rate**: 1.00 in the simple case (Meta/Google feed rules can pause OOS variants automatically and immediately). Use 0.85 if the merchant has manual feed management.
- **Period**: T₀ data, applied to T_f spend.

#### **Play 03 — Markdown avoidance — +$216K** (`play_03_avoided`)
- **Formula**: Equals `markdown_avoidance` from Section 4.2, applied to the 4 specific markdown variants in the recipe.
- **Period**: Action now; impact realised over weeks 6–14 of T_f.

---

### 4.8 Section 05 — The Recipe

Variant-level table. Each row is generated by the same formulas applied to that specific variant.

#### Reorder columns

| Column | Formula | Period | Sources |
|---|---|---|---|
| **Reorder Qty** | `min(velocity_T_w × (remaining_season_weeks − lead_time_weeks) × (1 + safety_buffer), MOQ, cash_headroom_units)` | Forward from now | Shopify Orders, Stocky |
| **Lead time** | Median of last 6 PO→receipt cycles for this supplier × SKU. Falls back to merchant-entered field if no history. | Trailing 12 months | Stocky PO history |
| **Waitlist** | `count(BIS signups in T_bis for this variant)` | T_bis | Klaviyo |
| **Projected STR** | `(velocity_T_w × sellable_weeks_after_landing) ÷ reorder_qty`, capped at 100% | T_f | Computed |
| **Δ Contribution** | `reorder_qty × projected_STR × (AUR × GM% − airfreight_per_unit − storage_per_unit)` | T_f | Computed |
| **Confidence** | High / Medium dot based on Section 6 framework | — | Computed |

#### Markdown columns

| Column | Formula | Period | Sources |
|---|---|---|---|
| **Units on hand** | `Σ_locations inventory_level` snapshot | Today | Shopify InventoryLevel |
| **Days in stock** | `days since first receipt of current cohort` | Today | Stocky receipt history |
| **Suggested depth** | Per planner skill Decision Framework 3: soft (10–20%), mid (25–40%), deep (50%+) based on age × cover × ROS-vs-plan | — | Computed |
| **Mechanic** | Compare-at (true markdown into Sale collection), Auto-discount (time-boxed promo), Code (targeted segment) — per skill Framework 3 | — | Decision rules |
| **Margin saved** | `on_hand × AUR × (terminal_depth − suggested_depth_now)` simplified; full formula in Section 4.2 | T_f | Computed |
| **Confidence** | Per Section 6 framework | — | Computed |

---

### 4.9 Section 06 — The Trajectory

#### **Current trajectory — $1.92M cumulative GMV** (`gmv_no_action[w]`)
- **Definition**: Forecast cumulative GMV by week assuming no intervention.
- **Formula**:
  ```
  For each week w in T_f:
    weekly_revenue_no_action[w] = Σ_V (
      forecast_velocity_V[w] ×
      indicator(V in stock at week w | current OOS evolution) ×
      AUR_V
    )

  gmv_no_action[w_end] = Σ_(w=1..13) weekly_revenue_no_action[w]
  ```
- **Period**: T_f (next 90 days, ~13 weeks).
- **Inputs to forecast velocity**:
  - Current ROS from T_w
  - Category-level seasonality multiplier per week
  - Markdown ramp toward terminal (driven by aged-stock bucket evolution)
  - No reorder lands; no ad reallocation; no early markdown

#### **Recommended trajectory — $2.34M cumulative GMV** (`gmv_with_plays[w]`)
- **Definition**: Same forecast with all three plays executed.
- **Formula**:
  ```
  weekly_revenue_with_plays[w] = weekly_revenue_no_action[w]
    + play_01_lift_per_week[w]      // begins week 3–7 as reorders land
    + play_02_recapture_per_week[w] // begins week 1 (ad feed rule)
    + play_03_margin_per_week[w]    // weeks 4–12 (earlier walk-downs sell faster)
  ```
- **Period**: T_f.

#### **+$420K revenue (+22%)** (`revenue_delta`)
- **Formula**: `revenue_delta = gmv_with_plays[w_end] − gmv_no_action[w_end]`
- **Note**: Less than $847K identified because (a) Play 02's $144K is ad efficiency, not revenue; (b) Play 03's $216K is margin saved, not revenue; (c) execution capture < 1 on Play 01.

#### **+600 bps gross margin** (`gm_delta`)
- **Formula**: `gm_delta = GM%_with_plays − GM%_no_action`, both computed over T_f.
- **Drivers**: Avoided terminal markdowns; full-margin reorder units replacing markdown units in the sales mix.

#### **−$58K markdown spend (−40%)** (`markdown_spend_delta`)
- **Formula**: `markdown_spend_delta = markdown_spend_with_plays − markdown_spend_no_action`
- **Period**: T_f.

---

### 4.10 Section 07 — Methodology footnote numbers

| Number | Formula | Period | Source |
|---|---|---|---|
| **1,247 variants** | `count(distinct (product_id, variant_id, location_id))` | T₀ | Shopify Admin |
| **312 variant-days OOS** | `Σ_V days at inventory ≤ 0` | T₀ | Shopify InventoryLevel |
| **1,840 BIS signups** | `count(distinct (email, variant) where signup in T_bis AND variant was OOS at signup)` | T_bis | Klaviyo |
| **−14% net-of-returns** | `mean over variants of (refund_units_within_T_r ÷ gross_units_sold)` | T₀ × T_r | Shopify Refunds, Loop |
| **90 days ad-spend overlay** | All Meta + Google records joined daily to InventoryLevel snapshot | T₀ | Meta API, Google Ads API, Shopify |
| **&lt;15% spread = High confidence** | See Section 6 below | — | Computed |

---

## 5 · Confidence framework

Every projected number carries an interval. Confidence dots in the recipe table use this framework.

### Confidence interval construction

For any forecast variable `Y` (e.g., reorder Δ Contribution):

```
σ_Y = sqrt(
    σ_velocity² × ∂Y/∂velocity² 
  + σ_lead_time² × ∂Y/∂lead_time²
  + σ_AUR² × ∂Y/∂AUR²
  + σ_returns² × ∂Y/∂returns²
)

CI_width = 2 × 1.96 × σ_Y     // 95% CI
relative_spread = CI_width ÷ |Y|
```

### Dot mapping

| Dot | Threshold | What it means |
|---|---|---|
| **High (green)** | `relative_spread < 0.15` | Strong signal; merchant should execute |
| **Medium (orange)** | `0.15 ≤ relative_spread < 0.30` | Directionally right; consider trial size |
| **Low (not shown)** | `relative_spread ≥ 0.30` | Suppressed from audit; flagged in deep-dive only |

### Why this matters
Per the planner skill: hiding uncertainty teaches merchants to either over-trust or distrust the model. Showing it in the deliverable demonstrates discipline. The Low bucket is suppressed because audit-as-marketing-asset shouldn't surface noise — but it must be inspectable in the internal tool.

---

## 6 · Sanity-check rules

Before the audit is delivered, the engine runs these checks. Any failure raises a flag for human review.

1. **Sum-check**: `total_opportunity = Σ component opportunities` to the dollar.
2. **Sign-check**: `revenue_delta > 0` and `markdown_spend_delta ≤ 0`. Either failing means the model misclassified an action.
3. **Capture-rate ceiling**: `play_01_lift / broken_size_opportunity ≤ 0.95`. If higher, execution capture assumption is too optimistic.
4. **Variant-day continuity**: `Σ in_stock_days + Σ oos_days = variant_count × 90` exactly. Off-by-one means a date join is wrong.
5. **Returns lag**: `returns matched within T_r should be ≥ 85% of all returns in trailing 6 months`. If lower, T_r is wrong for this merchant.
6. **Ad attribution sanity**: `wasted_ad_spend ≤ total_paid_spend_T0 × 0.40`. Above 40% suggests an inventory-feed mismatch — pause and inspect.
7. **Confidence floor**: at least 3 reorder candidates must be High confidence; if not, audit is downgraded from "act on this" tone to "investigate this" tone.

---

## 7 · Edge cases

The Shopify data model has known potholes. Each one breaks naïve formulas.

### Multi-location inventory
- **Edge case**: A variant has 0 at location A and 50 at location B. Is it "OOS"?
- **Rule**: OOS = the variant is unavailable to the customer at the location that fulfils their region. If a 3PL serves all orders, sum across locations. If retail + DC are split, treat per-channel.

### Returns lag
- **Edge case**: A sale in late T₀ won't see its returns until after T₀ closes.
- **Rule**: Accrue an expected return rate on the last 30 days of T₀ using the trailing 90-day return rate. Note this in the methodology block.

### Variant explosion
- **Edge case**: Denim with waist × inseam = 30 variants per wash.
- **Rule**: 2D pack ratio (joint distribution). Size curve viz becomes a heatmap not a bar chart. Confidence intervals widen proportionally because each cell has thinner data.

### Cold-start (new SKUs)
- **Edge case**: A style launched 14 days into T₀ has only 76 days of history, much of it ramp.
- **Rule**: Use look-alike forecasting from similar-attribute styles (same category + price band + season) for the first 21 days post-launch. Mark these forecasts "Medium" confidence at best.

### Discontinued vs. seasonal-end
- **Edge case**: A style with high cover at week 12 — is it overstock or end-of-life?
- **Rule**: If the merchant flagged it discontinued in Shopify metafields, treat as terminal-markdown candidate. Otherwise treat as overstock with normal markdown ladder.

### BIS signups during long OOS
- **Edge case**: A variant OOS for 70 days accumulates 200 signups. Are they all real demand?
- **Rule**: Apply a decay function: a signup older than 30 days has 0.7× weight; older than 45 days has 0.5×; older than 60 days drops out of T_bis entirely.

### Bundles
- **Edge case**: A bundle sale generates units across multiple variants at a blended price.
- **Rule**: Allocate revenue across component variants proportional to their individual AUR. Allocate units 1:1 per component.

### Currency
- **Edge case**: Multi-currency merchants.
- **Rule**: All dollars in the audit are reported in the merchant's home currency. Conversion done at sale-day rate, not period-end rate.

---

## 8 · Engineering notes

- All daily snapshots are taken at 00:00 in the merchant's primary timezone.
- Webhook-driven updates supplemented by a nightly reconciliation job — never trust webhooks alone for inventory truth.
- GraphQL bulk operations used for any catalogue-wide read; never loop product-by-product (rate-limit hit guaranteed at any real merchant scale).
- All formulas are deterministic given the same inputs; the audit must be reproducible from a frozen data snapshot for client trust.
- Lead-time learning runs continuously: every PO close updates the supplier × SKU lead-time history feeding the next audit.

---

*End of specification. Document version 1.0. Maintained by the Relo product engineering team.*
