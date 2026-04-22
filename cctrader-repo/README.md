# CCTrader — Cookie Clicker Stock Auto-Trader

A needlessly overengineered auto-trader for the Cookie Clicker stock market minigame. Runs a game-accurate Monte Carlo forecast of future prices based on the game's exact per-tick dynamics, then trades on expected value.

- **Language**: vanilla JavaScript, single file, no build step required to use
- **Size**: ~28 KB minified
- **Forecasting**: 200 simulations per stock per tick using the game's documented RNG rules
- **Compute**: ~0.65% CPU at the game's default 1 tick/minute
- **Modes of use**: bookmarklet, userscript (Tampermonkey/Violentmonkey), or paste-into-console

## Install

### Option 1 — Bookmarklet (easiest)

Open [install.html](https://YOUR_USERNAME.github.io/cctrader/) on the hosted GitHub Pages site, then drag the big button to your bookmarks bar. Click it while the Cookie Clicker tab is open.

Or make it yourself:
1. Create a new bookmark in your browser
2. Name it "CCTrader"
3. Paste the contents of [`dist/bookmarklet.txt`](dist/bookmarklet.txt) as the URL

### Option 2 — Userscript

Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox/Safari) or [Violentmonkey](https://violentmonkey.github.io/), then click [`dist/cctrader.user.js`](dist/cctrader.user.js) — your userscript manager should prompt to install.

Userscripts run automatically on every page load, so you don't need to click anything in-game.

### Option 3 — Console paste

Copy [`dist/cctrader.min.js`](dist/cctrader.min.js) and paste into the browser console while on [orteil.dashnet.org/cookieclicker](https://orteil.dashnet.org/cookieclicker/).

## What it does

Once loaded, a floating panel appears in the top-left showing five paper-traded strategies plus the live bot:

| Column | Meaning |
|---|---|
| **RoD/hr** | Return on deployed capital per hour (strategy quality metric — not diluted by idle cash) |
| **P&L** | Total $econds earned |
| **Hrs@wrk** | Hours of cumulative deployed-capital time |
| **S/hr** | Sharpe ratio per hour |
| **Ticks** | Total ticks the strategy has been running |

The live bot ("Sim-EV ★") uses the game-accurate forecast. The others are benchmarks to verify the forecast is actually earning its keep:

- **Heuristic v1** — naive mode-aware thresholds (85%/115% of resting value)
- **Quantile 25/75** — buy below 25th percentile of each stock's history, sell above 75th (Insugar-style)
- **Buy≤$5/Sell≥$100** — the wiki's hand-wavy advice
- **Rise-Rider** — buy when P(Rise mode) > 0.60, sell when < 0.40

Panel header has an **Auto-trade: ON/OFF** toggle — flip off to keep forecasting and paper-trading without actually spending cookies.

## How the forecast works

Cookie Clicker's stock market rules are fully documented on the wiki. Each tick, every stock is updated by:

1. Delta decay (`delta *= 0.97`)
2. Reversion to resting value (`value += (resting - value) × 0.01`)
3. Generic random fluctuations (30% chance ±$5 value, 15% chance ±$1.5, etc.)
4. Mode-specific effects on value and delta (see the [wiki table](https://cookieclicker.fandom.com/wiki/Stock_Market))
5. Velocity application (`value += delta`)
6. Boundary conditions (floor at $1, soft floor at $5, market cap)
7. Mode transitions when duration expires

The trader reads the current `(value, delta, mode, modeAge)` of every stock directly from the game state, then runs 200 forward simulations 40 ticks ahead using these exact rules. Forecast mean = average endpoint price. Forecast std = standard deviation.

Decisions:
- `buyEV = forecast_mean - price × (1 + overhead) - λ × σ`
- `sellEV = price - forecast_mean - λ × σ`
- Buy if `buyEV > $0.10/unit` and there's warehouse room
- Sell if `sellEV > $0.10/unit` and we hold any
- Otherwise hold

Default `λ = 0` (risk-neutral — we only care about expected value, not variance). Bump it up if you want the bot to chicken out on uncertain trades.

## Market panel row colors

Stocks in the in-game market panel get tinted based on the bot's current decision:
- **Green** — the bot would buy this right now
- **Red** — the bot would sell this
- **Uncolored** — hold

If the colors don't appear, run `CCTrader.rowColorDebug()` in the console — it prints a table showing which stocks the DOM probe found and what decision was made. If `domFound: false` shows for every row, [file an issue](../../issues) with the output.

## Console API

Everything is accessible via `window.CCTrader`:

```javascript
// Control
CCTrader.start()                   // resume the tick hook
CCTrader.stop()                    // pause (doesn't uninstall)
CCTrader.toggle()                  // flip start/stop
CCTrader.uninstall()               // remove entirely
CCTrader.runOnce()                 // manually trigger one tick

// Diagnostics
CCTrader.status()                  // current config + stats summary
CCTrader.beliefs()                 // HMM mode beliefs per stock
CCTrader.explain(key)              // full decision breakdown for one stock
CCTrader.benchmarks()              // per-strategy P&L table
CCTrader.portfolioBreakdown()      // current positions + unrealized P&L
CCTrader.evReport()                // per-stock EV + building ROI
CCTrader.tradeLog()                // last 200 executed trades
CCTrader.rowColorDebug()           // DOM + decision diagnostic

// Config
CCTrader.getConfig()
CCTrader.setConfig({ horizon: 40, riskAversion: 0.0, minBuyEdge: 0.10 })
```

See [`src/cctrader.js`](src/cctrader.js) for the full config object with inline documentation of every knob.

## Known limitations

- **Supreme Intellect**: decay rate and mode duration ARE aura-adjusted. Global spike rate, widened fluctuations, and the 50% Chaotic-override on standard mode transitions are NOT yet modeled. Decisions are still reasonable with SI equipped, but forecast σ is slightly understated.
- **Warehouse limit**: the bot doesn't try to level up your Bank or buy Stockbrokers. Do that yourself; brokers especially make a big difference (overhead drops from 20% to 1% at 59 brokers).
- **DOM integration**: the row-coloring DOM probe uses guessed ID patterns. If the game updates its market UI, the colors may stop appearing. `CCTrader.setConfig({ colorizeStockRows: false })` disables cleanly.

## Development

```bash
# Minify
npx terser src/cctrader.js \
  --compress passes=2 \
  --mangle reserved=[Game,CCTrader,window,document,M,console,Math,Object,Array,JSON,Number] \
  --output dist/cctrader.min.js

# Build bookmarklet
node -e "const fs=require('fs'); const m=fs.readFileSync('dist/cctrader.min.js','utf8'); fs.writeFileSync('dist/bookmarklet.txt', 'javascript:'+encodeURIComponent(m));"
```

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

This is a single-player game. Cheating in single-player games is fine. Orteil himself [has said](https://cookieclicker.fandom.com/f/p/4400000000000033731) cheating in single-player games is 100% OK. This mod doesn't cheat — it just automates decisions the wiki tells you to make anyway — but do with that information what you will.
