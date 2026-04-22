# Changelog

All notable changes to CCTrader.

## [2.4.2] — 2026-04-22

### Added
- **Deployed-capital metric** in the panel footer. Shows the total $econd value of currently-held stocks plus the cookie-equivalent via your raw CpS.
- **`rowColorDebug()`** diagnostic: prints per-stock DOM-resolution + decision info so broken row-color rendering can be triaged quickly.

### Changed
- **Row coloring is now action-based**, not EV-magnitude-based. Green = would buy, red = would sell, uncolored = hold. Matches the bot's actual behavior and avoids the previous "everything tinted at full saturation" look on stocks with large absolute EV that couldn't actually be traded (warehouse full, etc.).
- Removed unused `evColorScale` config knob.

## [2.4.1] — 2026-04-22

### Added
- **Auto-trade toggle** in the panel header (green ON / gray OFF). Flip off to keep forecasting and paper-trading without actually spending cookies. Exposed as `CFG.tradingEnabled`.
- **EV-intensity row coloring** on the stock market panel (superseded by action-based coloring in v2.4.2).

### Changed
- **Quantile strategy now uses 25/75 percentiles** (Insugar-style) instead of 5/95. More active; more representative of actual quantile trading.

## [2.4.0] — 2026-04-22

### Changed
- **Replaced AR(1) forecast with game-accurate Monte Carlo simulation.** The forecast now encodes the exact per-tick update rules from the Cookie Clicker wiki: delta decay, 1% reversion, 30%/15%/3%/10% fluctuation gates, per-mode value/delta effects, boundary conditions, and mode transitions with the Fast Rise/Fall → 70% Chaotic rule. 200 rollouts 40 ticks ahead per stock per tick.
- **Rise-mode sell veto disabled by default** (`riseSellVeto: 1.0`). The new forecast correctly predicts continued rises in Slow/Fast Rise modes without patching.
- **Dropped Bayes-Prior benchmark**. Under the game-accurate forecast it produced identical decisions to Bayes-Learned (forecast no longer depends on learned emission params).
- Renamed **Bayes-Learned → Sim-EV** to reflect what the strategy actually is.

## [2.3.14] — earlier

### Added
- `tradeLog()` API: records every executed trade with full decision context.

### Changed
- Lowered HMM reversion `κ` from 0.025 to 0.010 to reduce AR(1) overshoot during long-lived Rise modes.
- Added game-mode-based Rise-sell veto as a patch for AR(1) failures.

## [2.3.13] — earlier

### Added
- **RoD/hr** metric (Return on Deployed capital per hour) — strategy-quality metric that isn't diluted by idle cash.

## [2.3.9 – 2.3.12] — earlier

- EV-prioritized execution: sells first to free budget, buys sorted by per-unit EV descending.
- Fixed affordability edge case: always allow ≥1 unit if the buyer can afford it.
- Dropped the 20%-per-buy fraction cap (was defensive programming from a pre-trustworthy model).
- Added `portfolioBreakdown()` diagnostic.

## [2.3.1 – 2.3.8] — earlier

- Per-building EV tooltips via `Game.Objects[key].tooltip` hooks.
- Mode-age-aware forecasts.
- Mark-to-market P&L fix.
- Overhead computation fix.
- UI panel added.

## [2.1.x – 2.3.0] — earlier

- Original HMM + AR(1) implementation.
- Bookmarklet minification fixes.
