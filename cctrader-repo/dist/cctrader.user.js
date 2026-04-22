// ==UserScript==
// @name         Cookie Clicker Stock Auto-Trader
// @namespace    local.cctrader
// @version      2.4.2
// @description  Added Deployed-capital metric to panel footer. Row coloring now reflects actual decisions (green=buy, red=sell, none=hold) instead of raw EV magnitude. New rowColorDebug() diagnostic.
// @match        https://orteil.dashnet.org/cookieclicker/*
// @match        https://orteil.dashnet.org/cookieclicker
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function waitForGame(tries) {
  tries = tries || 0;
  if (typeof Game !== 'undefined'
      && Game.Objects && Game.Objects.Bank
      && Game.Objects.Bank.minigame
      && Game.Objects.Bank.minigame.goods) {
    install();
    return;
  }
  if (tries > 120) {
    console.log('[CCTrader] Gave up waiting. Upgrade Bank to Level 1 and open the Stock Market panel, then reload.');
    return;
  }
  setTimeout(function(){ waitForGame(tries + 1); }, 1000);
})();

function install() {
/* =====================================================================
 * Cookie Clicker — Bayesian Stock Market Auto-Trader  (v2)
 *
 * Models each stock as a 6-state Hidden Markov Model over the hidden
 * market mode (Stable, Slow Rise, Slow Fall, Fast Rise, Fast Fall,
 * Chaotic). Filters price deltas to maintain a posterior over modes,
 * projects expected value and variance H ticks ahead, and picks the
 * action with highest risk-adjusted EV.
 *
 * Controls (same as v1): CCTrader.start/stop/toggle/status/setConfig/
 * uninstall/runOnce. New: CCTrader.beliefs() prints the posterior
 * per stock.
 * ===================================================================== */
(function () {
  if (window.CCTrader && window.CCTrader._installed) {
    window.CCTrader.toggle();
    return;
  }

  if (typeof Game === 'undefined' || !Game.Objects || !Game.Objects.Bank) {
    alert('Cookie Clicker not detected on this page.');
    return;
  }
  var bank = Game.Objects.Bank;
  if (!bank.minigame || !bank.minigame.goods) {
    alert('Stock Market minigame is not loaded.\nUpgrade your Bank to Level 1 and open the Bank panel once, then try again.');
    return;
  }
  var M = bank.minigame;

  // ---------- Mode emission parameters ----------
  // 0 Stable, 1 Slow Rise, 2 Slow Fall, 3 Fast Rise, 4 Fast Fall, 5 Chaotic
  var MODES = ['Stable','Slow Rise','Slow Fall','Fast Rise','Fast Fall','Chaotic'];
  var N = 6;

  // Initial guesses used as priors and as fallbacks before we have data.
  var PRIOR_MU    = [ 0.00,  0.05, -0.05,  0.20, -0.20,  0.00];
  var PRIOR_SIGMA = [ 0.10,  0.15,  0.15,  0.30,  0.30,  0.50];

  // ---------- Empirical estimator ----------
  // Fully observable learning: the game exposes g.mode, so we can count mode
  // transitions directly and estimate per-mode delta distributions with
  // Welford's online algorithm. Pooled across all goods — they share the
  // same generative process, so pooling gets us out of the cold-start regime
  // roughly 15× faster (one estimator, 15 goods feeding it each tick).
  //
  // Bayesian smoothing: we use Dirichlet priors on transitions and
  // Normal-Inverse-Gamma priors on emissions, so early estimates degrade
  // gracefully to the hand-coded guesses instead of being noise.
  var ESTIMATOR = {
    // Dirichlet pseudocount for every transition (i,j). alpha=2 is a very
    // weak prior: we start uniform-ish, then quickly follow data as counts grow.
    alpha: 2.0,
    // Transition count matrix [from][to]. Initialized with the prior.
    C: null,
    // Per-mode delta stats for Welford's algorithm.
    // n[s] = effective count (including prior), mean[s] = running mean,
    // M2[s] = sum of squared deviations, used to derive variance.
    n:    null,
    mean: null,
    M2:   null,
    // Prior strength for emissions: we seed n[s] = priorN with mean=PRIOR_MU,
    // var≈PRIOR_SIGMA². Larger priorN = stickier to the prior until data arrives.
    priorN: 5.0,
    // Total transitions observed across all goods (for UI).
    totalTransitions: 0
  };

  function initEstimator() {
    var C = [], n = [], mean = [], M2 = [];
    for (var i = 0; i < N; i++) {
      var row = [];
      for (var j = 0; j < N; j++) row.push(ESTIMATOR.alpha);
      C.push(row);
      n.push(ESTIMATOR.priorN);
      mean.push(PRIOR_MU[i]);
      M2.push(PRIOR_SIGMA[i] * PRIOR_SIGMA[i] * ESTIMATOR.priorN);
    }
    ESTIMATOR.C = C;
    ESTIMATOR.n = n;
    ESTIMATOR.mean = mean;
    ESTIMATOR.M2 = M2;
    ESTIMATOR.totalTransitions = 0;
  }
  initEstimator();

  // Record a single transition (prevMode -> currMode) and its delta in price.
  function recordObservation(prevMode, currMode, delta) {
    if (prevMode == null || prevMode < 0 || prevMode >= N) return;
    if (currMode == null || currMode < 0 || currMode >= N) return;
    // Transition count
    ESTIMATOR.C[prevMode][currMode] += 1;
    ESTIMATOR.totalTransitions += 1;
    // Emission: the delta we observed is associated with the *current* mode
    // (prices moved according to whatever mode we're in now).
    // Welford's online update for running mean and variance.
    if (typeof delta !== 'number' || !isFinite(delta)) return;
    var s = currMode;
    ESTIMATOR.n[s] += 1;
    var d = delta - ESTIMATOR.mean[s];
    ESTIMATOR.mean[s] += d / ESTIMATOR.n[s];
    var d2 = delta - ESTIMATOR.mean[s];
    ESTIMATOR.M2[s] += d * d2;
  }

  // Current transition matrix, normalized from counts. Dirichlet-smoothed.
  function learnedTransition() {
    var T = [];
    for (var i = 0; i < N; i++) {
      var row = [], sum = 0;
      for (var j = 0; j < N; j++) sum += ESTIMATOR.C[i][j];
      for (var j2 = 0; j2 < N; j2++) row.push(ESTIMATOR.C[i][j2] / sum);
      T.push(row);
    }
    return T;
  }

  // Current emission means and stddevs per mode.
  function learnedEmissions() {
    var mu = [], sigma = [];
    for (var s = 0; s < N; s++) {
      mu.push(ESTIMATOR.mean[s]);
      // sample variance with Bessel-like correction
      var v = ESTIMATOR.n[s] > 1 ? ESTIMATOR.M2[s] / (ESTIMATOR.n[s] - 1) : PRIOR_SIGMA[s] * PRIOR_SIGMA[s];
      sigma.push(Math.sqrt(Math.max(1e-6, v)));
    }
    return { mu: mu, sigma: sigma };
  }

  // TRANSITION and EMISSION_{MU,SIGMA} are now computed live from the
  // estimator. The filter/forecast code paths read them via these getters,
  // which are refreshed each tick by refreshLearnedParams().
  var TRANSITION = null;
  var EMISSION_MU = null;
  var EMISSION_SIGMA = null;
  function refreshLearnedParams() {
    TRANSITION = learnedTransition();
    var em = learnedEmissions();
    EMISSION_MU = em.mu;
    EMISSION_SIGMA = em.sigma;
  }
  refreshLearnedParams();

  // ---------- Config ----------
  var CFG = {
    enabled: true,

    // HMM params
    horizon: 40,             // ticks ahead to forecast (~40 min, within a mode lifetime)
    meanReversion: 0.010,    // kappa for legacy AR(1) fallback forecast only.
                             // Not used when g.d (delta) is observable; we
                             // use forecastSim with the game's exact dynamics.
    numSimulations: 200,     // Monte Carlo rollouts per forecast. Higher is
                             // more accurate but slower. 200 gives std-error
                             // of forecast mean ~sigma/sqrt(200) ≈ sigma/14,
                             // which is more than good enough for buy/sell
                             // decisions where we compare means against
                             // minBuyEdge/minSellEdge thresholds of $0.10-0.50.
    priceFloor: 1.00,        // game's hard lower bound on price
    softFloor: 5.00,         // below this, game applies upward correction
    softFloorPull: 0.04,     // extra upward drift per tick when below softFloor

    // Decision params — tuned for maximum stock-market P&L, not overall game
    // strategy. Variance costs zero (we don't care about draw-down, only long-
    // run expected return), small edges are worth taking if they clear overhead.
    riskAversion: 0.0,       // lambda; set to 0 for pure EV maximization.
    minBuyEdge: 0.10,        // require at least $0.10 expected profit per unit after overhead
    minSellEdge: 0.10,       // same for selling

    // Budget guardrails — only minCookieReserve remains. The per-buy fraction
    // cap was removed in v2.3.11 because it was preventing full position fills
    // on single ticks (warehouse capacity at late-game CpS exceeds 20% of
    // cookies routinely, meaning position fills dribbled in over multiple
    // minutes with the model losing edge on the price between ticks). If you
    // want to keep cookies in reserve for non-trader uses, set minCookieReserve.
    minCookieReserve: 0,
    // Master toggle for automatic trading. When false, the trader still runs
    // forecasts, paper-traded benchmarks, and UI updates — just skips the
    // actual buyGood/sellGood calls. Exposed as a checkbox in the panel header.
    tradingEnabled:   true,
    // Stock-market row color coding: paint each stock row green if the live
    // strategy would BUY it right now, red if it would SELL, uncolored
    // otherwise. Reflects actual decisions, not raw EV magnitude.
    colorizeStockRows: true,

    // Logging
    verbose: true,
    logBeliefs: false,        // very noisy; use CCTrader.beliefs() instead

    // Rise-Rider strategy tunables (paper-traded in benchmarks)
    riseEntryThreshold: 0.60, // P(Slow Rise) + P(Fast Rise) must exceed this to buy
    riseExitThreshold:  0.40, // drops below this → sell. Must be < entry for deadband

    // Quantile strategy tunables
    quantileBuyPct:   0.25,   // buy when price <= 25th percentile (Insugar-style)
    quantileSellPct:  0.75,   // sell when price >= 75th percentile
    quantileMinObs:   100,     // warmup: need this many observations before trading

    // Rise-mode sell veto (fix for selling into ongoing Fast Rise).
    // If the filter's P(Slow Rise) + P(Fast Rise) is above this threshold,
    // veto any sell signal. Set to 1.0 to disable (never veto, pre-v2.3.7
    // behavior).
    riseSellVeto: 1.0        // 1.0 = veto disabled (trust the forecast).
                             // Set to <1.0 to re-enable: if P(Slow Rise) +
                             // P(Fast Rise) exceeds this value, OR if game
                             // mode is Slow/Fast Rise, vetoes sells. Was
                             // default 0.70 in v2.3.14 as a patch for the
                             // broken AR(1) forecast — no longer needed.
  };

  // ---------- Per-stock state ----------
  // stateByGood[key] = { belief: [6], prevVal: number, prevMode: number, ticks: number }
  var stateByGood = {};

  function initState(g) {
    var b = [1/6, 1/6, 1/6, 1/6, 1/6, 1/6];
    if (typeof g.mode === 'number' && g.mode >= 0 && g.mode < N) {
      for (var i = 0; i < N; i++) b[i] = 0.05;
      b[g.mode] = 0.75;
    }
    // Separate copy so learned and prior beliefs evolve independently.
    // modeAge: ticks since last observed mode change (0 on init).
    // modeAgeKnown: false until we've actually seen a mode transition, because
    // at install time we don't know how far into the current mode we are.
    return {
      belief: b.slice(), priorBelief: b.slice(),
      prevVal: g.val, prevMode: g.mode, ticks: 0,
      modeAge: 0, modeAgeKnown: false
    };
  }

  // Max mode duration (initial draw upper bound) depends on current dragon auras.
  // From the wiki: base 700, Supreme Intellect 500, Reality Bending 680, both 480.
  // We detect auras by name to be version-robust.
  function currentMaxDuration() {
    if (!Game || !Game.dragonAuras) return 700;
    function idByName(name) {
      for (var k in Game.dragonAuras) {
        if (Game.dragonAuras[k] && Game.dragonAuras[k].name === name) return parseInt(k);
      }
      return -1;
    }
    var si = idByName('Supreme Intellect'), rb = idByName('Reality Bending');
    var a1 = (typeof Game.dragonAura  === 'number') ? Game.dragonAura  : -1;
    var a2 = (typeof Game.dragonAura2 === 'number') ? Game.dragonAura2 : -1;
    var hasSI = si >= 0 && (a1 === si || a2 === si);
    var hasRB = rb >= 0 && (a1 === rb || a2 === rb);
    if (hasSI && hasRB) return 480;
    if (hasSI) return 500;
    if (hasRB) return 680;
    return 700;
  }

  // Given observed age t into a mode with max duration D, the posterior on the
  // initial draw is Uniform[max(10, t), D], so remaining duration R = D - t is
  // Uniform[0, D - t] (for t ≥ 10), with mean (D-t)/2 and next-tick transition
  // hazard 1/(D-t).
  function expectedRemainingTicks(modeAge, modeAgeKnown) {
    if (!modeAgeKnown) return null;   // unknown — caller should use fixed horizon
    var maxD = currentMaxDuration();
    return Math.max(1, (maxD - modeAge) / 2);
  }

  function restingValue(g) {
    if (typeof g.restingVal === 'number' && g.restingVal > 0) return g.restingVal;
    return 10 + (g.id || 0) * 5; // fallback
  }

  // ---------- Filtering ----------
  // Gaussian log-pdf, stable form
  function logNormPdf(x, mu, sigma) {
    var z = (x - mu) / sigma;
    return -0.5 * z * z - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI);
  }

  // Update beliefField ('belief' or 'priorBelief') in-place using whichever
  // TRANSITION / EMISSION_* globals are currently set.
  function updateBelief(st, delta, beliefField) {
    var bf = beliefField || 'belief';
    var cur = st[bf];
    var predicted = new Array(N).fill(0);
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < N; j++) {
        predicted[j] += TRANSITION[i][j] * cur[i];
      }
    }
    var logL = new Array(N);
    var maxLog = -Infinity;
    for (var s = 0; s < N; s++) {
      logL[s] = logNormPdf(delta, EMISSION_MU[s], EMISSION_SIGMA[s]) + Math.log(predicted[s] + 1e-12);
      if (logL[s] > maxLog) maxLog = logL[s];
    }
    var sum = 0, next = new Array(N);
    for (var s2 = 0; s2 < N; s2++) { next[s2] = Math.exp(logL[s2] - maxLog); sum += next[s2]; }
    for (var s3 = 0; s3 < N; s3++) next[s3] /= sum;
    st[bf] = next;
  }

  // ---------- Forecasting ----------
  // E[v_{t+H}] given current belief, current value, resting value.
  // E[v_{t+H}] given current belief, current value, resting value.
  // Uses per-mode drift under AR(1) mean reversion:
  //   E[Δv | s, v, rest] = mu_s - kappa * (v - rest)
  // Iterated H steps. If state is passed and its mode age is known, the
  // effective horizon for the *dominant belief mode's drift* is capped at
  // E[remaining ticks | age] — so drift only accumulates for the expected
  // mode lifetime, with pure reversion (no drift) for any ticks beyond.
  // This fixes the systematic overshoot during long-lived modes: previously
  // a Fast Rise stock late in its mode would still get H full ticks of +0.20
  // drift, making the forecast think prices keep rising when the mode is
  // almost over.
  // Game-accurate Monte Carlo forecast. Uses the exact update rules from the
  // Cookie Clicker wiki (v2.048) — no learned parameters, no AR(1) approximation.
  //
  // Per-tick update, in order:
  //  1. delta *= 0.97 (or 0.98/0.971/0.981 depending on aura)
  //  2. value += (resting - value) × 0.01   — 1% reversion
  //  3. 30% chance: value += U[-3, 7]; delta += U[-0.05, 0.05]
  //  4. 15% chance: value += U[-1.5, 1.5] (with linear density)
  //  5. 3% chance: value += U[-5, 5]
  //  6. 10% chance: delta += U[-0.15, 0.15]
  //  7. Mode-specific effect (from wiki — exact rules per mode):
  //      Stable:    delta *= 0.95; delta += U[-0.025, 0.025]
  //      Slow Rise: delta *= 0.99; delta += U[-0.005, 0.045]
  //      Slow Fall: delta *= 0.99; delta += U[-0.045, 0.005]
  //      Fast Rise: value += U[0, 5]; delta += U[-0.015, 0.135]
  //                 30% chance: value += U[-7, 3]; delta += U[-0.05, 0.05]
  //                 3% chance:  switch to Fast Fall (keeps duration)
  //      Fast Fall: value += U[-5, 0]; delta += U[-0.135, 0.015]
  //                 30% chance: value += U[-3, 7]; delta += U[-0.05, 0.05]
  //      Chaotic:   delta += U[-0.15, 0.15]
  //                 50% chance: value += U[-5, 5]
  //                 20% chance: delta = U[-1, 1]  (overridden, not additive)
  //  8. value += delta   — velocity term
  //  9. Boundary:
  //      value = max(1, value)
  //      if value < 5: value += (5 - value) / 2
  //      if value < 5 and delta < 0: delta *= 0.95
  //      if value > marketCap and delta > 0: delta *= 0.90
  // 10. Mode tick: if duration elapsed, re-roll mode from Standard Mode
  //     Selection (Stable 12.5%, Slow Rise 25%, Slow Fall 25%, Fast Rise 12.5%,
  //     Fast Fall 12.5%, Chaotic 12.5%). If transitioning from Fast Rise or
  //     Fast Fall, 70% chance to go to Chaotic instead.
  function forecastSim(v, delta, mode, modeAge, modeAgeKnown, rest) {
    var H = CFG.horizon;
    var N_SIM = CFG.numSimulations;
    var maxD = currentMaxDuration();
    var deltaDecay = maxD === 480 ? 0.981 : (maxD === 500 ? 0.98 : (maxD === 680 ? 0.971 : 0.97));
    // Market cap: per wiki, depends on Bank level.
    var bankLvl = (Game.Objects.Bank && Game.Objects.Bank.level) || 1;
    // Standard mode-selection probabilities from the wiki table
    var MODE_PROBS = [0.125, 0.25, 0.25, 0.125, 0.125, 0.125];
    function pickMode(prevMode) {
      // Fast Rise/Fall → 70% chance of Chaotic instead of standard selection
      if ((prevMode === 3 || prevMode === 4) && Math.random() < 0.70) return 5;
      var r = Math.random(), cum = 0;
      for (var i = 0; i < 6; i++) {
        cum += MODE_PROBS[i];
        if (r < cum) return i;
      }
      return 5;
    }
    function randU(a, b) { return a + Math.random() * (b - a); }

    var meanSum = 0, sqSum = 0, hitFloorCount = 0;

    for (var sim = 0; sim < N_SIM; sim++) {
      var V = v, D = delta, M_cur = mode;
      // Mode age: if known, use the observed age; if unknown (haven't
      // witnessed a transition yet this session), sample uniform over [0, maxD]
      // to reflect that uncertainty honestly.
      var MA = modeAgeKnown ? modeAge : Math.floor(Math.random() * maxD);
      var MD = Math.max(10, maxD - MA);

      for (var t = 0; t < H; t++) {
        // 1. delta decay
        D *= deltaDecay;

        // 2. reversion to resting (1%)
        V += (rest - V) * 0.01;

        // 3. 30% chance base fluctuation
        if (Math.random() < 0.30) {
          V += randU(-3, 7);
          D += randU(-0.05, 0.05);
        }
        // 4. 15% chance small value fluctuation (wiki says linear density;
        //    approximate as triangular by averaging two uniforms)
        if (Math.random() < 0.15) {
          V += (randU(-1.5, 1.5) + randU(-1.5, 1.5)) / 2;
        }
        // 5. 3% chance big value fluctuation
        if (Math.random() < 0.03) V += randU(-5, 5);
        // 6. 10% chance delta fluctuation
        if (Math.random() < 0.10) D += randU(-0.15, 0.15);

        // 7. Mode-specific effects (exact rules from wiki)
        switch (M_cur) {
          case 0: // Stable
            D *= 0.95;
            D += randU(-0.025, 0.025);
            break;
          case 1: // Slow Rise
            D *= 0.99;
            D += randU(-0.005, 0.045);
            break;
          case 2: // Slow Fall
            D *= 0.99;
            D += randU(-0.045, 0.005);
            break;
          case 3: // Fast Rise
            V += randU(0, 5);
            D += randU(-0.015, 0.135);
            if (Math.random() < 0.30) {
              V += randU(-7, 3);
              D += randU(-0.05, 0.05);
            }
            if (Math.random() < 0.03) {
              // Switch to Fast Fall, keeping current duration
              M_cur = 4;
            }
            break;
          case 4: // Fast Fall
            V += randU(-5, 0);
            D += randU(-0.135, 0.015);
            if (Math.random() < 0.30) {
              V += randU(-3, 7);
              D += randU(-0.05, 0.05);
            }
            break;
          case 5: // Chaotic
            D += randU(-0.15, 0.15);
            if (Math.random() < 0.50) V += randU(-5, 5);
            if (Math.random() < 0.20) D = randU(-1, 1);
            break;
        }

        // 8. velocity → value
        V += D;

        // 9. boundary
        if (V < 1) V = 1;
        if (V < 5) {
          V += (5 - V) / 2;
          if (D < 0) D *= 0.95;
        }
        // Market cap: value is capped at a bank-level-dependent value. Per
        // the wiki the "market cap" referenced in the delta penalty is
        // the stock's price ceiling, not warehouse capacity. Using a
        // conservative approximation — if prices exceed 2× resting, apply
        // the delta penalty. This is crude; the exact cap formula is not
        // explicit in the source material I have.
        var priceCap = rest * 2 + 30;
        if (V > priceCap && D > 0) D *= 0.90;

        // 10. mode tick/transition
        MA++;
        if (MA >= MD) {
          M_cur = pickMode(M_cur);
          MA = 0;
          MD = 10 + Math.floor(Math.random() * (maxD - 10 + 1));
        }
      }

      meanSum += V;
      sqSum += V * V;
      if (V <= 1.01) hitFloorCount++;
    }

    var mean = meanSum / N_SIM;
    var variance = sqSum / N_SIM - mean * mean;
    if (variance < 0) variance = 0;
    return {
      mean: mean, std: Math.sqrt(variance),
      hitFloorPct: hitFloorCount / N_SIM
    };
  }

  // Unified forecast: use Monte Carlo simulation when possible (requires
  // observable delta), fall back to legacy AR(1) when not.
  function forecast(belief, v, rest, state, g) {
    if (g && typeof g.d === 'number' && state) {
      return forecastSim(v, g.d, g.mode, state.modeAge, state.modeAgeKnown, rest);
    }
    return forecastAR(belief, v, rest, state);
  }

  // Legacy AR(1) forecast (kept as fallback and for Bayes-Prior benchmark).
  function forecastAR(belief, v, rest, state) {
    var H = CFG.horizon;
    var kappa = CFG.meanReversion;

    // If currently below the soft floor, add extra upward drift to reflect
    // the game's price-correction mechanic. This is additive on top of
    // per-mode drift.
    var extraDrift = (v < CFG.softFloor) ? CFG.softFloorPull : 0;

    // Compute the drift-horizon: how many of the H ticks we expect the
    // current dominant mode to persist. If we don't know the mode's age,
    // fall back to H (old behavior). Otherwise cap by E[remaining].
    var H_drift = H;
    if (state && state.modeAgeKnown) {
      var eRem = expectedRemainingTicks(state.modeAge, true);
      if (eRem != null) H_drift = Math.min(H, eRem);
    }
    var H_revert = H - H_drift; // ticks after the mode ends → pure reversion

    // Per-mode forecast mean and variance.
    // Split the horizon into two phases:
    //   Phase 1 (H_drift ticks): mode-specific drift + reversion
    //   Phase 2 (H_revert ticks): pure reversion (no drift, target = rest)
    var emu = 0, evar = 0;
    for (var s = 0; s < N; s++) {
      var muEffective = EMISSION_MU[s] + extraDrift;
      // Phase 1: H_drift ticks of drift-under-mode-s
      var decay1 = Math.pow(1 - kappa, H_drift);
      var target1 = rest + muEffective / Math.max(kappa, 1e-6);
      var mean_after_phase1 = decay1 * v + (1 - decay1) * target1;
      // Phase 2: H_revert ticks of pure reversion (no drift)
      var decay2 = Math.pow(1 - kappa, H_revert);
      var mean_s = decay2 * mean_after_phase1 + (1 - decay2) * rest;
      // Enforce the game's hard floor of $1
      if (mean_s < CFG.priceFloor) mean_s = CFG.priceFloor;
      // Variance: sum of per-tick mode variance scaled by total AR decay.
      // Approximated by treating all H ticks as mode s (slight overestimate
      // during phase 2 but within the noise of this forecast).
      var decay_full = Math.pow(1 - kappa, H);
      var var_s = EMISSION_SIGMA[s] * EMISSION_SIGMA[s] * H * (1 - decay_full) / Math.max(kappa * H, 1e-6);
      emu  += belief[s] * mean_s;
      evar += belief[s] * (var_s + mean_s * mean_s);
    }
    evar -= emu * emu; // Var = E[X^2] - E[X]^2
    if (evar < 0) evar = 0;
    return { mean: emu, std: Math.sqrt(evar) };
  }

  // ---------- Overhead ----------
  // Each buy pays an overhead fraction of the buy price; brokers reduce it
  // multiplicatively by 5% each from a base of 20%.
  function overheadFactor() {
    var brokers = (M && typeof M.brokers === 'number') ? M.brokers : 0;
    return 0.20 * Math.pow(0.95, brokers);
  }

  // ---------- Decision ----------
  // Returns { action: 'buy'|'sell'|'hold', qty, ev, reason }
  // ownedOverride: optional; when provided (sim), use this instead of g.stock
  //   so the strategy reasons about its own portfolio, not the game's.
  function decide(g, st, ownedOverride) {
    var v = g.val;
    var rest = restingValue(g);
    var cap = M.getGoodMaxStock(g);
    var owned = (ownedOverride == null) ? g.stock : ownedOverride;

    var fc = forecast(st.belief, v, rest, st, g);
    var mu = fc.mean;
    var sigma = fc.std;
    var oh = overheadFactor();

    // Buy EV per unit: sell at horizon price minus cost including overhead
    var buyCost  = v * (1 + oh);
    var buyEV    = (mu - buyCost) - CFG.riskAversion * sigma;
    // Sell EV per unit held: v now vs. expected v at horizon; positive means
    // selling now beats holding.
    var sellEV   = (v - mu) - CFG.riskAversion * sigma;

    // Available room
    var roomToBuy = Math.max(0, cap - owned);

    // Pick best
    // We want to BUY if buyEV > minBuyEdge AND there's room
    // SELL if sellEV > minSellEdge AND we hold any
    // else HOLD.
    var best = { action: 'hold', qty: 0, ev: 0,
      reason: 'μ=$' + mu.toFixed(2) + ' σ=$' + sigma.toFixed(2) +
              ' buyEV=$' + buyEV.toFixed(2) + ' sellEV=$' + sellEV.toFixed(2) };

    // No more Rise-mode veto. The game-accurate simulation forecast correctly
    // predicts continued price rises during Slow/Fast Rise modes, so sellEV
    // is properly negative during those modes without any patching needed.
    // Kept the CFG.riseSellVeto knob for users who want to layer on extra
    // caution, but default behavior trusts the forecast.
    if (CFG.riseSellVeto < 1.0) {
      var pRise = (st.belief[1] || 0) + (st.belief[3] || 0);
      var gameModeIsRise = (g.mode === 1 || g.mode === 3);
      if (owned > 0 && sellEV > CFG.minSellEdge && (pRise >= CFG.riseSellVeto || gameModeIsRise)) {
        return { action: 'hold', qty: 0, ev: 0,
          reason: 'SELL vetoed by riseSellVeto config; sellEV=$' + sellEV.toFixed(2) + '/u' };
      }
    }

    if (owned > 0 && sellEV > CFG.minSellEdge) {
      best = { action: 'sell', qty: owned, ev: sellEV * owned,
        reason: 'sellEV=$' + sellEV.toFixed(2) + '/u (μ=$' + mu.toFixed(2) + ' vs now $' + v.toFixed(2) + ')' };
    }
    if (roomToBuy > 0 && buyEV > CFG.minBuyEdge && buyEV * roomToBuy > best.ev) {
      best = { action: 'buy', qty: roomToBuy, ev: buyEV * roomToBuy,
        reason: 'buyEV=$' + buyEV.toFixed(2) + '/u (μ=$' + mu.toFixed(2) + ' vs cost $' + buyCost.toFixed(2) + ')' };
    }
    return best;
  }

  // ---------- Alternative strategies (paper-traded only) ----------
  // Each takes (g, st) and returns { action, qty } in the same shape as decide().
  // qty is "desired quantity" — sim will clamp by cash/capacity independently.

  // Strategy: v1 heuristic (mode-aware thresholds + hard floors/ceilings)
  function decideHeuristic(g, st, ownedOverride) {
    var v = g.val, rest = restingValue(g);
    var cap = M.getGoodMaxStock(g);
    var owned = (ownedOverride == null) ? g.stock : ownedOverride;
    var mode = g.mode;
    var HARD_BUY = 3.0, HARD_SELL = 95.0;
    var BUY_F = 0.85, SELL_F = 1.15;
    var FAST_FALL_SELL = 1.05, FAST_RISE_SELL = 1.30;
    var room = Math.max(0, cap - owned);

    if (v <= HARD_BUY && room > 0) return { action: 'buy', qty: room };
    if (v >= HARD_SELL && owned > 0) return { action: 'sell', qty: owned };
    var sf = SELL_F;
    if (mode === 4) sf = FAST_FALL_SELL;
    else if (mode === 3) sf = FAST_RISE_SELL;
    var buyT = rest * BUY_F, sellT = rest * sf;
    if (v <= buyT && mode !== 4 && room > 0) return { action: 'buy', qty: room };
    if (v >= sellT && owned > 0) return { action: 'sell', qty: owned };
    return { action: 'hold', qty: 0 };
  }

  // Per-stock price histograms for percentile-based strategy. Prices span
  // roughly $1 to $200; bin width 0.25 gives ~800 bins per stock, accurate
  // to a quarter of a dollar for quantile computation. Much cheaper than
  // storing raw observations and computing quantiles on every tick.
  var HIST_BIN = 0.25;
  var HIST_MAX = 200;
  var HIST_BINS = Math.ceil(HIST_MAX / HIST_BIN);
  var priceHist = {};   // key -> Int32Array of bin counts
  var priceHistN = {};  // key -> total count (for cheap warmup check)

  function recordPriceForHist(key, price) {
    if (!priceHist[key]) {
      priceHist[key] = new Array(HIST_BINS).fill(0);
      priceHistN[key] = 0;
    }
    var bin = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(price / HIST_BIN)));
    priceHist[key][bin]++;
    priceHistN[key]++;
  }

  // Return the price at the qth quantile (0 < q < 1) from the histogram,
  // or null if we don't have enough data yet.
  function histQuantile(key, q) {
    var h = priceHist[key];
    var n = priceHistN[key] || 0;
    if (!h || n < CFG.quantileMinObs) return null;
    var target = q * n;
    var cum = 0;
    for (var i = 0; i < HIST_BINS; i++) {
      cum += h[i];
      if (cum >= target) return (i + 0.5) * HIST_BIN; // bin midpoint
    }
    return HIST_MAX;
  }

  // Strategy: adaptive quantile. Buy below the 5th percentile of this stock's
  // observed prices, sell above the 95th. Each stock gets its own distribution,
  // so higher-resting stocks have higher thresholds automatically. Requires
  // warmup (CFG.quantileMinObs observations) before trading.
  function decideQuantile(g, st, ownedOverride) {
    var key = null;
    // Find the M.goods key matching g.id — reverse lookup.
    var keys = Object.keys(M.goods);
    for (var i = 0; i < keys.length; i++) {
      if (M.goods[keys[i]] === g) { key = keys[i]; break; }
    }
    if (!key) return { action: 'hold', qty: 0 };
    var cap = M.getGoodMaxStock(g);
    var owned = (ownedOverride == null) ? g.stock : ownedOverride;
    var room = Math.max(0, cap - owned);
    var qLow = histQuantile(key, CFG.quantileBuyPct);
    var qHigh = histQuantile(key, CFG.quantileSellPct);
    if (qLow == null || qHigh == null) return { action: 'hold', qty: 0 };
    if (g.val <= qLow && room > 0) return { action: 'buy', qty: room };
    if (g.val >= qHigh && owned > 0) return { action: 'sell', qty: owned };
    return { action: 'hold', qty: 0 };
  }

  // Strategy: common online advice — buy when price ≤ $5, sell when price ≥ $100.
  // Meant to capture extreme tails where the asymmetric payoff is obvious.
  // Trades rarely; wide floor/ceiling produces a low-frequency strategy.
  function decideWikiAdvice(g, st, ownedOverride) {
    var cap = M.getGoodMaxStock(g);
    var owned = (ownedOverride == null) ? g.stock : ownedOverride;
    var room = Math.max(0, cap - owned);
    if (g.val <= 5.0 && room > 0) return { action: 'buy', qty: room };
    if (g.val >= 100.0 && owned > 0) return { action: 'sell', qty: owned };
    return { action: 'hold', qty: 0 };
  }

  // Rise-Rider: buy when the filter is ≥entryThreshold confident the stock is
  // in a rising mode (Slow Rise OR Fast Rise, modes 1 and 3). Sell when
  // confidence drops below exitThreshold. Uses a deadband to avoid thrashing
  // at the boundary. Ignores price-level and EV considerations entirely —
  // purely regime-driven.
  function decideRiseRider(g, st, ownedOverride) {
    var cap = M.getGoodMaxStock(g);
    var owned = (ownedOverride == null) ? g.stock : ownedOverride;
    var room = Math.max(0, cap - owned);
    // belief[1] = Slow Rise, belief[3] = Fast Rise
    var pRise = st.belief[1] + st.belief[3];
    if (owned === 0 && pRise >= CFG.riseEntryThreshold && room > 0) {
      return { action: 'buy', qty: room };
    }
    if (owned > 0 && pRise < CFG.riseExitThreshold) {
      return { action: 'sell', qty: owned };
    }
    return { action: 'hold', qty: 0 };
  }

  // ---------- Paper-trading engine ----------
  // Each strategy has its own simulated portfolio with equal starting cash.
  // Return = (portfolio_value - START_CASH) / START_CASH.
  // Portfolio value = cash + Σ holdings_i * price_i.
  // We record per-tick return-on-value for Sharpe: r_t = (V_t - V_{t-1}) / V_{t-1}.
  var START_CASH = 1e6; // in $ (dollars, same unit as stock prices)

  // Frozen prior transition matrix — matches the original hand-coded guess
  // (pStay=0.99 with uniform jumps). Built once, never updated.
  var PRIOR_TRANSITION = (function () {
    var pStay = 0.99, pJump = (1 - pStay) / (N - 1), T = [];
    for (var i = 0; i < N; i++) {
      var row = [];
      for (var j = 0; j < N; j++) row.push(i === j ? pStay : pJump);
      T.push(row);
    }
    return T;
  })();

  // Run `decide(g, st, owned)` with the params temporarily swapped to the
  // hand-coded priors AND the belief swapped to priorBelief. Restores on exit.
  function decideWithPrior(g, st, owned) {
    var savedT = TRANSITION, savedMu = EMISSION_MU, savedS = EMISSION_SIGMA;
    TRANSITION = PRIOR_TRANSITION; EMISSION_MU = PRIOR_MU; EMISSION_SIGMA = PRIOR_SIGMA;
    // Shallow state with belief aliased to priorBelief so decide()/forecast()
    // use the prior-filtered belief without touching the learned one.
    // Propagate mode-age fields so the age-aware forecast horizon also
    // applies to the prior-strategy's EV calculation.
    var stPrior = { belief: st.priorBelief, modeAge: st.modeAge, modeAgeKnown: st.modeAgeKnown };
    try { return decide(g, stPrior, owned); }
    finally { TRANSITION = savedT; EMISSION_MU = savedMu; EMISSION_SIGMA = savedS; }
  }

  var STRATEGIES = {
    // Primary strategy — game-accurate Monte Carlo forecast + EV decision.
    // Uses the exact per-tick game rules (per-mode delta/value dynamics,
    // reversion, boundary conditions, mode transitions) to forecast
    // H ticks ahead, no learned parameters needed since the game tells us
    // the current mode directly.
    bayesian:  { name: 'Sim-EV ★',        decide: function (g, st, owned) { return decide(g, st, owned); } },
    // Control strategies
    heuristic: { name: 'Heuristic v1',    decide: function (g, st, owned) { return decideHeuristic(g, st, owned); } },
    quantile:  { name: 'Quantile 25/75',  decide: function (g, st, owned) { return decideQuantile(g, st, owned); } },
    wiki:      { name: 'Buy≤$5/Sell≥$100', decide: function (g, st, owned) { return decideWikiAdvice(g, st, owned); } },
    rise:      { name: 'Rise-Rider',      decide: function (g, st, owned) { return decideRiseRider(g, st, owned); } }
  };
  var portfolios = {}; // key -> { cash, holdings: {goodKey: qty}, valueHistory: [], returnHistory: [] }
  // Rolling trade log for post-hoc inspection. Keeps the last N executed
  // live-strategy trades with full decision context (belief, modeAge,
  // forecast) so you can investigate specific trades that looked wrong.
  var tradeLog = [];
  var TRADE_LOG_MAX = 500;

  function initPortfolio() {
    return { cash: START_CASH, holdings: {}, valueHistory: [], returnHistory: [] };
  }

  function portfolioValue(p) {
    var v = p.cash;
    Object.keys(p.holdings).forEach(function (k) {
      var g = M.goods[k]; if (!g) return;
      v += (p.holdings[k] || 0) * g.val;
    });
    return v;
  }

  // Apply one strategy's decision to its simulated portfolio, clamped by
  // simulated cash and the good's real capacity (cap is the same for all
  // strategies since it's a game property, not a per-portfolio property).
  function applyStrategyTo(p, gk, g, st, strat) {
    var owned = p.holdings[gk] || 0;
    var d = strat.decide(g, st, owned);
    var price = g.val;
    var oh = overheadFactor();
    var cap = M.getGoodMaxStock(g);
    if (d.action === 'buy') {
      var roomSim = Math.max(0, cap - owned);
      if (roomSim <= 0 || price <= 0) return;
      var costPerUnit = price * (1 + oh);
      var maxByCash = Math.floor(p.cash / costPerUnit);
      var qty = Math.min(d.qty, roomSim, maxByCash);
      if (qty <= 0) return;
      p.cash -= qty * costPerUnit;
      p.holdings[gk] = owned + qty;
      // Track cost basis (VWAP per stock) for diagnostic P&L attribution
      if (!p.costBasis) p.costBasis = {};
      var prevCost = (p.costBasis[gk] || 0) * owned;
      p.costBasis[gk] = (prevCost + qty * costPerUnit) / (owned + qty);
      if (!p.tradesBuy) p.tradesBuy = {};
      p.tradesBuy[gk] = (p.tradesBuy[gk] || 0) + 1;
      if (!p.overheadPaid) p.overheadPaid = 0;
      p.overheadPaid += qty * price * oh;
    } else if (d.action === 'sell') {
      var qtyS = Math.min(d.qty, owned);
      if (qtyS <= 0) return;
      p.cash += qtyS * price;
      p.holdings[gk] = owned - qtyS;
      // Attribute realized P&L per stock
      if (!p.costBasis) p.costBasis = {};
      var basis = p.costBasis[gk] || 0;
      if (!p.realizedPL) p.realizedPL = {};
      p.realizedPL[gk] = (p.realizedPL[gk] || 0) + qtyS * (price - basis);
      if (p.holdings[gk] === 0) p.costBasis[gk] = 0;
      if (!p.tradesSell) p.tradesSell = {};
      p.tradesSell[gk] = (p.tradesSell[gk] || 0) + 1;
    }
  }

  function runSimulation() {
    // Run each strategy over every good, then snapshot portfolio value.
    var stratKeys = Object.keys(STRATEGIES);
    stratKeys.forEach(function (sk) {
      if (!portfolios[sk]) portfolios[sk] = initPortfolio();
      var p = portfolios[sk];
      Object.keys(M.goods).forEach(function (gk) {
        var g = M.goods[gk];
        if (!g || typeof g.val !== 'number') return;
        var st = stateByGood[gk];
        if (!st) return;
        applyStrategyTo(p, gk, g, st, STRATEGIES[sk]);
      });
      var v = portfolioValue(p);
      var prev = p.valueHistory.length ? p.valueHistory[p.valueHistory.length - 1] : START_CASH;
      p.valueHistory.push(v);
      if (prev > 0) p.returnHistory.push((v - prev) / prev);
      // Track deployed capital (cost basis of open positions) at this tick,
      // for the return-on-deployed metric. This is the strategy-quality
      // measure that doesn't get diluted by idle cash the strategy couldn't
      // deploy due to game warehouse caps.
      var deployedNow = 0;
      if (p.costBasis) {
        Object.keys(p.holdings).forEach(function (k) {
          var units = p.holdings[k] || 0;
          var basis = p.costBasis[k] || 0;
          deployedNow += units * basis;
        });
      }
      if (!p.deployedHistory) p.deployedHistory = [];
      p.deployedHistory.push(deployedNow);
    });
  }

  // Compute total return, per-hour return, and Sharpe (per-tick and per-hour).
  function computeStats(p) {
    if (!p || p.valueHistory.length === 0) {
      return { value: START_CASH, totalReturn: 0, returnPerHour: null, sharpeTick: null, sharpeHour: null, ticks: 0,
               totalPL: 0, avgDeployed: 0, returnOnDeployed: null, hoursDeployed: 0 };
    }
    var v = p.valueHistory[p.valueHistory.length - 1];
    var totalReturn = (v - START_CASH) / START_CASH;
    var rets = p.returnHistory;
    var n = rets.length;
    // Per-hour return: extrapolate total return. 60 ticks ≈ 1 hour. Suppress
    // below 30 ticks because short-horizon extrapolation is wildly noisy.
    var returnPerHour = n >= 30 ? totalReturn * (60 / n) : null;
    var sharpeTick = null, sharpeHour = null;
    if (n >= 5) {
      var mean = 0;
      for (var i = 0; i < n; i++) mean += rets[i];
      mean /= n;
      var varSum = 0;
      for (var j = 0; j < n; j++) { var d = rets[j] - mean; varSum += d * d; }
      var sd = Math.sqrt(varSum / Math.max(1, n - 1));
      if (sd > 1e-12) {
        sharpeTick = mean / sd;
        sharpeHour = sharpeTick * Math.sqrt(60);
      }
    }
    // Return on deployed capital: total P&L divided by the time-integrated
    // deployed capital. This is the strategy-quality metric — it doesn't
    // penalize idle cash that couldn't be deployed due to warehouse caps.
    // Formally: RoD = totalPL / (sum of deployed_at_each_tick).
    // Interpretation: "per unit of capital actually at work per tick, how
    // much P&L was generated." Multiply by 60 for a per-hour version.
    var totalPL = v - START_CASH;
    var deployedSum = 0, deployedTickCount = 0;
    if (p.deployedHistory) {
      for (var k = 0; k < p.deployedHistory.length; k++) {
        if (p.deployedHistory[k] > 0) {
          deployedSum += p.deployedHistory[k];
          deployedTickCount++;
        }
      }
    }
    var avgDeployed = deployedTickCount > 0 ? deployedSum / deployedTickCount : 0;
    // Time-integrated return: total P&L divided by deployed-tick integral.
    // This is dimensionally "return per tick of deployed capital" — a fraction.
    // To get a more intuitive per-hour rate of return on capital at work, we
    // normalize by the number of ticks the capital was deployed (not total
    // elapsed ticks) and scale to 60 min/hr.
    var returnOnDeployed = null, hoursDeployed = 0;
    if (deployedSum > 0) {
      // per-tick: P&L per unit of deployed-ticks
      var perDeployedTick = totalPL / deployedSum;
      // per hour: capital at work for 1 hour earns this return
      returnOnDeployed = perDeployedTick * 60;
      hoursDeployed = deployedTickCount / 60;
    }
    return { value: v, totalReturn: totalReturn, returnPerHour: returnPerHour,
             sharpeTick: sharpeTick, sharpeHour: sharpeHour, ticks: n,
             totalPL: totalPL, avgDeployed: avgDeployed,
             returnOnDeployed: returnOnDeployed, hoursDeployed: hoursDeployed };
  }

  // ---------- UI panel ----------
  // Fixed-position overlay. Styles injected via a single <style> tag so markup
  // can use short class names instead of repeated inline CSS.
  var uiEl = null, stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var css = [
      '#cctrader-stats{position:fixed;top:80px;right:20px;width:400px;',
      'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#f0d89a;',
      'background:rgba(20,10,5,.94);border:1px solid #8a5a2b;border-radius:6px;',
      'padding:10px 12px 8px;line-height:1.45;box-shadow:0 4px 14px rgba(0,0,0,.55);',
      'z-index:100000;cursor:move;user-select:none}',
      '#cctrader-stats table{border-collapse:collapse;width:100%;font-size:11px}',
      '#cctrader-stats th{color:#c4a060;text-align:right;padding:2px 6px;font-weight:400}',
      '#cctrader-stats th:first-child{text-align:left;padding:2px 6px 2px 0}',
      '#cctrader-stats th:last-child,#cctrader-stats td:last-child{padding-right:0}',
      '#cctrader-stats td{text-align:right;padding:2px 6px}',
      '#cctrader-stats td:first-child{text-align:left;padding:2px 6px 2px 0}',
      '#cctrader-stats .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}',
      '#cctrader-stats .ttl{font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e0a24a}',
      '#cctrader-stats .btn{cursor:pointer;color:#9a7830;padding:0 6px;font-size:14px;line-height:1}',
      '#cctrader-stats .btn:hover{color:#f0d89a}',
      '#cctrader-stats .ft{color:#9a7830;font-size:10px;display:flex;justify-content:space-between;margin-top:4px}',
      '#cctrader-stats .nd{cursor:default}',
      '#cctrader-stats .tks{color:#b89860}'
    ].join('');
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function ensureUI() {
    if (uiEl && document.body && document.body.contains(uiEl)) return;
    if (!document || !document.body) return;
    injectStyles();
    uiEl = document.createElement('div');
    uiEl.id = 'cctrader-stats';
    document.body.appendChild(uiEl);

    // Drag support. Only starts when clicking the background, not buttons/text.
    var dragging = false, ox = 0, oy = 0;
    uiEl.addEventListener('mousedown', function (e) {
      // Skip when target is inside something marked no-drag (buttons).
      if (e.target.closest && e.target.closest('.nd')) return;
      dragging = true;
      var r = uiEl.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      uiEl.style.left = (e.clientX - ox) + 'px';
      uiEl.style.top  = (e.clientY - oy) + 'px';
      uiEl.style.right = 'auto';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  function pct(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%'; }
  function num(x, d) { return x == null ? '—' : x.toFixed(d == null ? 2 : d); }

  function renderUI() {
    try { ensureUI(); } catch (e) { return; }
    if (!uiEl) return;
    var oh = overheadFactor();
    var brokers = (M && typeof M.brokers === 'number') ? M.brokers : 0;
    var tradingOn = CFG.tradingEnabled !== false;
    var toggleColor = tradingOn ? '#7ed957' : '#9a7830';
    var toggleText = tradingOn ? 'ON' : 'OFF';
    var html = [
      '<div class="hdr"><div class="ttl">Dough Jones Auto-Trader</div>',
      '<div class="nd"><span id="cctrader-min" class="btn" title="Minimize">–</span>',
      '<span id="cctrader-close" class="btn" title="Uninstall">×</span></div></div>',
      '<div id="cctrader-body">',
      // Master trading toggle. Click to flip. Paper strategies + forecasts
      // keep running regardless — only the live buy/sell execution is gated.
      '<div class="nd" style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:4px">',
      '<span style="font-size:11px;color:#c9b584">Auto-trade:</span>',
      '<span id="cctrader-toggle" class="btn" style="cursor:pointer;color:' + toggleColor + ';font-weight:bold;font-size:11px;padding:2px 8px;border:1px solid ' + toggleColor + ';border-radius:3px" title="Toggle live trading on/off">' + toggleText + '</span>',
      '</div>',
      // Columns:
      //   RoD/hr  = return on deployed capital per hour of deployment
      //             (strategy quality, independent of how much cash was idle)
      //   P&L    = total dollars made so far (scale, not rate)
      //   Hrs@wrk = hours of cumulative deployed-capital time
      //   S/hr   = Sharpe per hour on tick-level returns
      //   Ticks  = total ticks the strategy has been running
      '<table><thead><tr><th title="Return on deployed capital, per hour of deployment">RoD/hr</th><th>Strategy</th><th title="Total P&L in $econds">P&L</th><th title="Hours of capital-at-work">Hrs@wrk</th><th>S/hr</th><th>Ticks</th></tr></thead><tbody>'
    ];
    Object.keys(STRATEGIES).forEach(function (sk) {
      var s = computeStats(portfolios[sk]);
      var lbl = STRATEGIES[sk].name + (sk === 'bayesian' ? ' ★' : '');
      var rod = s.returnOnDeployed;
      var c = rod == null ? '#f0d89a' : (rod > 0 ? '#7ed957' : (rod < 0 ? '#e67560' : '#f0d89a'));
      var plStr = s.totalPL == null ? '—' : (s.totalPL >= 0 ? '+' : '') + '$' + Math.abs(s.totalPL).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, s.totalPL < 0 ? '-' : '');
      html.push('<tr><td style="color:' + c + '">' + pct(rod) +
        '</td><td>' + lbl +
        '</td><td>' + plStr +
        '</td><td>' + num(s.hoursDeployed, 1) +
        '</td><td>' + num(s.sharpeHour, 2) +
        '</td><td class="tks">' + s.ticks + '</td></tr>');
    });
    var ohC = oh > 0.05 ? '#e67560' : '#7ed957';
    html.push('</tbody></table><div class="ft">');
    html.push('<span>Overhead: <span style="color:' + ohC + '">' + (oh * 100).toFixed(2) + '%</span> (' + brokers + ' brokers, ' + ESTIMATOR.totalTransitions + ' obs)</span>');
    html.push('<span>v2.4.2</span></div>');
    // Deployed capital: sum the market value of every currently-held stock.
    // This is what's "at risk" right now in $econds (one $econd = one second
    // of your highest raw CpS). Also show the cookie-equivalent so you can
    // compare against your bank balance.
    var deployedDollars = 0;
    Object.keys(M.goods).forEach(function (k) {
      var g = M.goods[k]; if (!g) return;
      deployedDollars += (g.stock || 0) * (g.val || 0);
    });
    var cpsRaw = (Game && Game.cookiesPsRawHighest) || 1;
    var deployedCookies = deployedDollars * cpsRaw;
    function fmtDollars(n) {
      if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
      return '$' + n.toFixed(0);
    }
    function fmtCookies(n) {
      if (n >= 1e15) return (n / 1e15).toFixed(2) + ' Q';
      if (n >= 1e12) return (n / 1e12).toFixed(2) + ' T';
      if (n >= 1e9)  return (n / 1e9).toFixed(2) + ' B';
      if (n >= 1e6)  return (n / 1e6).toFixed(2) + ' M';
      if (n >= 1e3)  return (n / 1e3).toFixed(1) + ' K';
      return Math.round(n).toString();
    }
    html.push('<div class="ft" style="border-top:1px solid rgba(255,255,255,0.08);padding-top:4px;margin-top:2px">');
    html.push('<span title="Market value of all currently-held stocks, in $econds">Deployed: <span style="color:#f0d89a">' + fmtDollars(deployedDollars) + '</span></span>');
    html.push('<span title="Same deployed capital converted to cookies via your highest raw CpS">≈ <span style="color:#f0d89a">' + fmtCookies(deployedCookies) + '</span> cookies</span>');
    html.push('</div>');
    html.push('<div style="color:#9a7830;font-size:10px">★ = live. Others paper-trade $' + START_CASH.toLocaleString() + '. Drag to move.</div></div>');
    uiEl.innerHTML = html.join('');

    var cb = uiEl.querySelector('#cctrader-close');
    if (cb) cb.addEventListener('click', function (e) {
      e.stopPropagation();
      if (confirm('Uninstall the auto-trader?')) api.uninstall();
    });
    var mb = uiEl.querySelector('#cctrader-min');
    if (mb) mb.addEventListener('click', function (e) {
      e.stopPropagation();
      var b = uiEl.querySelector('#cctrader-body');
      if (b) b.style.display = b.style.display === 'none' ? '' : 'none';
    });
    var tg = uiEl.querySelector('#cctrader-toggle');
    if (tg) tg.addEventListener('click', function (e) {
      e.stopPropagation();
      CFG.tradingEnabled = !CFG.tradingEnabled;
      log('auto-trade ' + (CFG.tradingEnabled ? 'ENABLED' : 'DISABLED'));
      renderUI(); // refresh the button color/text immediately
    });
  }

  // ---------- Execution ----------
  // Compute how many units we can actually afford to buy. The only budget
  // guard is minCookieReserve — we never let total cookies drop below that.
  // Previously there was a 20% per-buy cap, which was defensive programming
  // from before the model was trustworthy. In practice it was preventing
  // position fills: a one-tick buy that should fill the warehouse would
  // instead dribble in over multiple minutes, losing edge on the stock's
  // price movement in between. If you want to limit exposure, use a higher
  // minCookieReserve rather than per-trade fraction caps.
  function affordableQty(g, wantQty) {
    var price = g.val;
    var cpsRaw = Game.cookiesPsRawHighest;
    if (!cpsRaw || cpsRaw <= 0) return 0;
    var oh = 1 + overheadFactor();
    var costPerUnit = price * cpsRaw * oh;
    if (costPerUnit <= 0) return wantQty;
    var availableTotal = Math.max(0, Game.cookies - CFG.minCookieReserve);
    var qty = Math.floor(availableTotal / costPerUnit);
    return Math.max(0, Math.min(wantQty, qty));
  }

  function log() {
    if (!CFG.verbose) return;
    console.log.apply(console, ['[CCTrader]'].concat([].slice.call(arguments)));
  }

  function runOnce() {
    if (!CFG.enabled || !M || !M.goods) return;
    var keys = Object.keys(M.goods);
    var pendingBuys = [];
    var pendingSells = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var g = M.goods[key];
      if (!g || typeof g.val !== 'number') continue;

      // Initialize or update belief
      var st = stateByGood[key];
      if (!st) { st = stateByGood[key] = initState(g); continue; }
      var delta = g.val - st.prevVal;

      // Record this observation into the empirical estimator BEFORE filtering,
      // so the filter uses the most up-to-date learned params on the next pass.
      // We pool data across all goods — they share the same game mechanic.
      recordObservation(st.prevMode, g.mode, delta);
      // Record the raw price into the per-stock histogram for the Quantile strategy.
      recordPriceForHist(key, g.val);

      // Filter the learned belief with current learned params.
      updateBelief(st, delta, 'belief');
      // Filter the prior belief with frozen prior params, via the same swap trick.
      var _T = TRANSITION, _mu = EMISSION_MU, _s = EMISSION_SIGMA;
      TRANSITION = PRIOR_TRANSITION; EMISSION_MU = PRIOR_MU; EMISSION_SIGMA = PRIOR_SIGMA;
      try { updateBelief(st, delta, 'priorBelief'); }
      finally { TRANSITION = _T; EMISSION_MU = _mu; EMISSION_SIGMA = _s; }

      st.prevVal = g.val;
      // Track mode age: reset when the game reports a mode change, increment otherwise.
      // First transition flips modeAgeKnown to true — before that we don't know
      // how long the stock has been in the mode we observed at install time.
      if (g.mode !== st.prevMode) {
        st.modeAge = 0;
        st.modeAgeKnown = true;
      } else {
        st.modeAge++;
      }
      st.prevMode = g.mode;
      st.ticks++;

      if (CFG.logBeliefs) {
        var parts = [];
        for (var s = 0; s < N; s++) parts.push(MODES[s][0] + ':' + st.belief[s].toFixed(2));
        log(g.name, 'b=[' + parts.join(' ') + ']');
      }

      // Skip trading until we have a few ticks of data (belief is shaky early)
      if (st.ticks < 3) continue;

      var d = decide(g, st);
      // Collect decisions; don't execute inline. We want to:
      //  (1) execute all sells first, since sale proceeds increase budget
      //  (2) execute buys in descending-EV order, so when budget runs short
      //      we've already filled the highest-edge positions.
      // Snapshot diagnostic context at decision-time so we can investigate
      // any questionable trade after the fact via CCTrader.tradeLog().
      if (d.action === 'buy' || d.action === 'sell') {
        var rest = restingValue(g);
        var fc = forecast(st.belief, g.val, rest, st, g);
        var pRise = (st.belief[1] || 0) + (st.belief[3] || 0);
        var snap = {
          tick: (st.ticks || 0),
          stock: g.name, key: key,
          action: d.action, qty: d.qty,
          price: +g.val.toFixed(2), resting: +rest.toFixed(2),
          gameMode: MODES[g.mode],
          belief: st.belief.slice(),
          pRise: +pRise.toFixed(3),
          modeAge: st.modeAge, modeAgeKnown: st.modeAgeKnown,
          forecastMu: +fc.mean.toFixed(2), forecastSigma: +fc.std.toFixed(2),
          reason: d.reason
        };
        if (d.action === 'buy') {
          pendingBuys.push({ g: g, d: d, snap: snap });
        } else {
          pendingSells.push({ g: g, d: d, snap: snap });
        }
      }
    }

    // Gate live execution on the master toggle. Paper trades (benchmarks)
    // still run in runSimulation() even when tradingEnabled is false, so
    // the strategy comparisons keep updating. The pending lists are built
    // above so the trade log would've recorded them if active — we skip
    // recording too when disabled, since nothing actually happened.
    if (CFG.tradingEnabled) {
      // Phase 1: execute sells (frees budget for buys this tick)
      for (var i = 0; i < pendingSells.length; i++) {
        var s = pendingSells[i];
        M.sellGood(s.g.id, s.d.qty);
        s.snap.executed = true; s.snap.executedQty = s.d.qty;
        tradeLog.push(s.snap);
        if (tradeLog.length > TRADE_LOG_MAX) tradeLog.shift();
        log('SELL ' + s.d.qty + ' ' + s.g.name + ' @ $' + s.g.val.toFixed(2) + ' — ' + s.d.reason);
      }

      // Phase 2: sort buys by per-unit EV descending so budget-constrained
      // ticks allocate cookies to the highest-edge stocks first. d.ev is the
      // total EV for the full-fill qty, so per-unit is d.ev/d.qty.
      pendingBuys.sort(function (a, b) {
        var evA = a.d.qty > 0 ? a.d.ev / a.d.qty : 0;
        var evB = b.d.qty > 0 ? b.d.ev / b.d.qty : 0;
        return evB - evA;
      });
      for (var j = 0; j < pendingBuys.length; j++) {
        var p = pendingBuys[j];
        var qty = affordableQty(p.g, p.d.qty);
        if (qty > 0) {
          M.buyGood(p.g.id, qty);
          p.snap.executed = true; p.snap.executedQty = qty;
          tradeLog.push(p.snap);
          if (tradeLog.length > TRADE_LOG_MAX) tradeLog.shift();
          log('BUY ' + qty + ' ' + p.g.name + ' @ $' + p.g.val.toFixed(2) + ' — ' + p.d.reason);
        } else if (CFG.verbose) {
          log('SKIP BUY ' + p.g.name + ' — budget exhausted (wanted ' + p.d.qty + ')');
        }
      }
    }
    // Refresh learned params with all the observations we just recorded.
    // (Done once per tick after the inner loop, not per-good, for efficiency.)
    refreshLearnedParams();
    // Refresh the EV cache the tooltip hooks read from. Cheap — just one
    // forecast per stock reusing the belief we already updated.
    try { refreshEVCache(); } catch (e) { console.error('[CCTrader] ev cache error:', e); }
    // After updating beliefs for all goods, run the three paper strategies
    // and refresh the UI. Wrap in try/catch so a DOM issue never kills the
    // main loop.
    try { runSimulation(); } catch (e) { console.error('[CCTrader] sim error:', e); }
    try { renderUI(); } catch (e) { console.error('[CCTrader] ui error:', e); }
  }

  // ---------- Hook ----------
  function installHook() {
    if (M._origTick) return;
    M._origTick = M.tick;
    M.tick = function () {
      var r = M._origTick.apply(this, arguments);
      try { runOnce(); } catch (e) { console.error('[CCTrader] tick error:', e); }
      return r;
    };
  }
  function uninstallHook() {
    if (M._origTick) { M.tick = M._origTick; delete M._origTick; }
    uninstallTooltipHooks();
    try { clearStockRowColors(); } catch (e) {}
  }

  // ---------- Building tooltip hooks ----------
  // Append an EV summary line to each building's tooltip so the number shows
  // up exactly where the buy decision is made. Hook Game.Objects[key].tooltip
  // (the game calls it to render the tooltip HTML each time you hover). We
  // cache the computed EV per stock and refresh it every tick, so the tooltip
  // callback is a cheap string concat instead of a full forecast.
  var evCache = {};     // key -> { buyEV, totalEV, bldgROI, cookiesFromOneMore, text }
  var hookedBuildings = {}; // key -> { origTooltip, object }

  function refreshEVCache() {
    if (!M || !M.goods) return;
    var cpsRaw = (Game && Game.cookiesPsRawHighest) || 1;
    var oh = overheadFactor();
    var keys = Object.keys(M.goods);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var g = M.goods[key], st = stateByGood[key];
      if (!g || !st) continue;
      var fc = forecast(st.belief, g.val, restingValue(g), st, g);
      var buyEV = fc.mean - g.val * (1 + oh) - CFG.riskAversion * fc.std;
      var room = Math.max(0, M.getGoodMaxStock(g) - g.stock);
      var totalEV = buyEV * room; // in $econds
      var cookiesFromOneMore = buyEV * cpsRaw; // +1 building unlocks 1 unit of cap
      var bldg = Game.Objects && Game.Objects[key];
      var bldgCost = bldg && typeof bldg.price === 'number' ? bldg.price : null;
      var bldgROI = (bldgCost && bldgCost > 0) ? cookiesFromOneMore / bldgCost : null;
      evCache[key] = {
        buyEV: buyEV, totalEV: totalEV, cookiesFromOneMore: cookiesFromOneMore,
        bldgROI: bldgROI, buyingNowEV: buyEV * room // same as totalEV; alias
      };
    }
    // After updating EV cache, reflect it visually on the stock market panel
    // so you can see at a glance which stocks are attractive buys/sells.
    try { updateStockRowColors(); } catch (e) { /* DOM may not be ready */ }
  }

  // Paint each stock's market-panel row with a background color whose hue
  // (green/red) and intensity reflects buyEV. Positive EV → green (good buy),
  // negative → red (don't buy; likely sell if owned).
  //
  // The DOM structure of the stock market isn't officially documented, so we
  // probe a few element patterns and cache the resolution per stock. Results
  // are stored as overlaid background colors with transparency, so we don't
  // permanently mutate the game's CSS or interfere with its rendering.
  //
  // Intensity: |buyEV| / EV_SCALE, clamped to [0, 1]. EV_SCALE=10 means a
  // buyEV of $10/unit shows at full saturation; smaller edges are softer.
  var stockRowElCache = {}; // key -> DOM element (or null if never found)
  function findStockRowEl(key, goodId) {
    if (stockRowElCache[key] !== undefined) return stockRowElCache[key];
    var el = null;
    // Try a few known patterns. Cookie Clicker conventions suggest IDs like
    // `bankGood-<id>` or similar; fall back to class/attribute searches.
    var candidates = [
      'bankGood-' + goodId,
      'bankGood' + goodId,
      'good-' + goodId,
      'stockGood-' + goodId
    ];
    for (var i = 0; i < candidates.length && !el; i++) {
      el = document.getElementById(candidates[i]);
    }
    // Fallback: look for a child of the bank minigame panel whose id starts
    // with 'bankGood' or similar, then pick the one at index = goodId.
    if (!el) {
      var panel = document.getElementById('bankPanel') || document.getElementById('rowSpecial') || document.querySelector('[id^="bankGood"]');
      if (panel && panel.parentElement) {
        var siblings = panel.parentElement.querySelectorAll('[id^="bankGood"]');
        if (siblings && siblings[goodId]) el = siblings[goodId];
      }
    }
    stockRowElCache[key] = el || null;
    return el;
  }

  function updateStockRowColors() {
    if (!CFG.colorizeStockRows) return;
    if (!M || !M.goods || !document || !document.getElementById) return;
    var keys = Object.keys(M.goods);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var g = M.goods[key];
      var st = stateByGood[key];
      if (!g || !st) continue;
      var el = findStockRowEl(key, g.id);
      if (!el) continue;
      // Color by what the live strategy would actually DO right now, not by
      // raw EV magnitude. This gives three clear outcomes: green = would buy,
      // red = would sell, uncolored = hold. Matches how the trader behaves
      // and avoids the false "everything is positive EV" look that a pure
      // buyEV-based tint produced (cheap stocks always show large positive
      // buyEV even when you have no room to buy, so the tint was uniform).
      var d = null;
      try { d = decide(g, st); } catch (e) { continue; }
      if (!d) continue;
      if (d.action === 'buy') {
        el.style.backgroundColor = 'rgba(80, 200, 60, 0.30)';
      } else if (d.action === 'sell') {
        el.style.backgroundColor = 'rgba(230, 80, 60, 0.30)';
      } else {
        el.style.backgroundColor = '';
      }
      el.style.transition = 'background-color 0.5s ease';
    }
  }

  // Strip applied styles (used on uninstall so we don't leave the game's UI
  // permanently tinted).
  function clearStockRowColors() {
    Object.keys(stockRowElCache).forEach(function (k) {
      var el = stockRowElCache[k];
      if (el && el.style) {
        el.style.backgroundColor = '';
        el.style.transition = '';
      }
    });
    stockRowElCache = {};
  }

  function renderEVHtml(key) {
    var e = evCache[key];
    if (!e) return '';
    // Color: green if the +1-building trade is positive EV, red if negative,
    // gold if zero (no forecast edge).
    var color = e.cookiesFromOneMore > 0 ? '#6eca4f' : (e.cookiesFromOneMore < 0 ? '#e67560' : '#f0d89a');
    var evSign = e.buyEV >= 0 ? '+' : '';
    var roiLine = '';
    if (e.bldgROI != null) {
      var roiColor = e.bldgROI >= 1 ? '#6eca4f' : (e.bldgROI >= 0.1 ? '#f0d89a' : '#e67560');
      roiLine = '<div style="font-size:11px;color:' + roiColor + '">Stock ROI: ' +
        e.bldgROI.toFixed(3) + '× per trade cycle</div>';
    }
    return '<div class="cctrader-ev" style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;color:' + color + '">' +
      '<b>Stock EV</b>: ' + evSign + '$' + e.buyEV.toFixed(2) + '/unit  ' +
      '(+1 building → ' + (e.cookiesFromOneMore >= 0 ? '+' : '') + e.cookiesFromOneMore.toExponential(2) + ' cookies/cycle)' +
      roiLine + '</div>';
  }

  function installTooltipHooks() {
    if (!Game || !Game.Objects || !M || !M.goods) return;
    var keys = Object.keys(M.goods);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var bldg = Game.Objects[key];
      if (!bldg || hookedBuildings[key]) continue;
      if (typeof bldg.tooltip !== 'function') continue;
      hookedBuildings[key] = { origTooltip: bldg.tooltip, object: bldg };
      (function (k, orig) {
        bldg.tooltip = function () {
          var base;
          try { base = orig.apply(this, arguments); } catch (e) { base = ''; }
          try {
            var extra = renderEVHtml(k);
            if (!extra) return base;
            // base is typically an HTML string; if it's an element, fall back.
            if (typeof base === 'string') return base + extra;
            return base;
          } catch (e) { return base; }
        };
      })(key, hookedBuildings[key].origTooltip);
    }
  }
  function uninstallTooltipHooks() {
    Object.keys(hookedBuildings).forEach(function (k) {
      var h = hookedBuildings[k];
      if (h && h.object) h.object.tooltip = h.origTooltip;
    });
    hookedBuildings = {};
  }

  // ---------- Public API ----------
  function dominantMode(b) {
    var best = 0;
    for (var i = 1; i < N; i++) if (b[i] > b[best]) best = i;
    return best;
  }

  var api = {
    _installed: true,
    start: function () { CFG.enabled = true; installHook(); installTooltipHooks(); log('started (Bayesian)'); return api.status(); },
    stop:  function () { CFG.enabled = false; log('stopped'); return api.status(); },
    toggle: function () { CFG.enabled ? api.stop() : api.start(); return api.status(); },
    uninstall: function () {
      CFG.enabled = false; uninstallHook();
      if (uiEl && uiEl.parentNode) uiEl.parentNode.removeChild(uiEl);
      uiEl = null;
      delete window.CCTrader;
      log('uninstalled');
    },
    runOnce: function () { runOnce(); },
    benchmarks: function () {
      var rows = [];
      Object.keys(STRATEGIES).forEach(function (sk) {
        var s = computeStats(portfolios[sk]);
        rows.push({
          strategy: STRATEGIES[sk].name,
          // Primary quality metric: return per hour of capital-at-work.
          // Not diluted by idle cash the strategy couldn't deploy.
          returnOnDeployedPerHour: s.returnOnDeployed == null ? null : (s.returnOnDeployed * 100).toFixed(2) + '%',
          // Total P&L in $econds (scale, not rate)
          totalPL: +s.totalPL.toFixed(0),
          // Time-integrated deployed capital (dollars × hours)
          hoursAtWork: +s.hoursDeployed.toFixed(1),
          avgDeployed: +s.avgDeployed.toFixed(0),
          // Kept for reference: naive return on $1M starting capital
          naiveTotalReturn: (s.totalReturn * 100).toFixed(2) + '%',
          sharpePerHour: s.sharpeHour == null ? null : +s.sharpeHour.toFixed(2),
          ticks: s.ticks
        });
      });
      console.table(rows);
      return rows;
    },
    resetBenchmarks: function () { portfolios = {}; renderUI(); log('benchmarks reset'); },
    // Inspect recent trades to understand why any given trade fired. Default
    // shows the last 20 trades; filter by stock or action to narrow down.
    // Example: CCTrader.tradeLog({ stock: 'Cinnamon', action: 'sell' })
    tradeLog: function (opts) {
      opts = opts || {};
      var n = opts.n || 20;
      var rows = tradeLog.slice(-Math.min(tradeLog.length, 200));
      if (opts.stock) rows = rows.filter(function (r) { return r.stock === opts.stock || r.key === opts.stock; });
      if (opts.action) rows = rows.filter(function (r) { return r.action === opts.action; });
      rows = rows.slice(-n);
      var display = rows.map(function (r) {
        return {
          tick: r.tick, stock: r.stock, action: r.action, qty: r.executedQty,
          price: r.price, resting: r.resting,
          gameMode: r.gameMode, modeAge: r.modeAge + (r.modeAgeKnown ? '' : '?'),
          pRise: r.pRise,
          forecastMu: r.forecastMu, forecastSigma: r.forecastSigma,
          reason: r.reason
        };
      });
      console.table(display);
      return rows;
    },
    resetTradeLog: function () { tradeLog = []; log('trade log reset'); },
    // Diagnostic: break down a strategy's current portfolio to show WHERE the
    // return is coming from and where capital is sitting. Answers questions like:
    //  - "Why is my total return only 1% when individual trades look big?"
    //    → usually because most of the $1M is sitting as cash, not deployed.
    //  - "How much is overhead dragging on me?"
    //    → overheadPaid / startCash shows the total drag across all trades.
    //  - "Which stocks are making or losing money?"
    //    → realized P&L per stock + unrealized per position.
    portfolioBreakdown: function (strategyKey) {
      strategyKey = strategyKey || 'bayesian';
      var p = portfolios[strategyKey];
      if (!p) { console.log('No data for strategy', strategyKey); return; }
      var cashPct = (p.cash / START_CASH) * 100;
      var positions = [];
      var totalUnrealized = 0, totalDeployed = 0;
      Object.keys(p.holdings).forEach(function (k) {
        var units = p.holdings[k] || 0;
        if (units <= 0) return;
        var g = M.goods[k]; if (!g) return;
        var mkt = units * g.val;
        var basis = (p.costBasis && p.costBasis[k]) || 0;
        var cost = units * basis;
        var unrealized = mkt - cost;
        totalUnrealized += unrealized;
        totalDeployed += cost;
        positions.push({
          stock: g.name, key: k, units: units,
          avgCost: +basis.toFixed(2), currentPrice: +g.val.toFixed(2),
          costBasis: +cost.toFixed(0), marketValue: +mkt.toFixed(0),
          unrealizedPL: +unrealized.toFixed(0),
          unrealizedPct: cost > 0 ? +((unrealized / cost) * 100).toFixed(2) : 0
        });
      });
      var realizedRows = [];
      var totalRealized = 0;
      Object.keys(p.realizedPL || {}).forEach(function (k) {
        var v = p.realizedPL[k];
        totalRealized += v;
        var g = M.goods[k];
        realizedRows.push({
          stock: g ? g.name : k, key: k,
          realizedPL: +v.toFixed(0),
          buys: (p.tradesBuy && p.tradesBuy[k]) || 0,
          sells: (p.tradesSell && p.tradesSell[k]) || 0
        });
      });
      realizedRows.sort(function (a, b) { return b.realizedPL - a.realizedPL; });
      var totalVal = portfolioValue(p);
      var totalRet = (totalVal - START_CASH) / START_CASH * 100;
      console.log('Portfolio breakdown for strategy:', strategyKey);
      console.log('  Portfolio value: $' + totalVal.toFixed(0) + ' (total return: ' + totalRet.toFixed(2) + '%)');
      console.log('  Cash: $' + p.cash.toFixed(0) + ' (' + cashPct.toFixed(1) + '% of starting capital)');
      console.log('  Deployed in positions: $' + totalDeployed.toFixed(0) + ' at cost (' + (totalDeployed / START_CASH * 100).toFixed(1) + '% of $1M)');
      console.log('  Unrealized P&L: $' + totalUnrealized.toFixed(0) + (totalDeployed > 0 ? ' (' + (totalUnrealized / totalDeployed * 100).toFixed(2) + '% on deployed capital)' : ''));
      console.log('  Realized P&L (all-time): $' + totalRealized.toFixed(0));
      console.log('  Overhead paid (all-time): $' + ((p.overheadPaid || 0).toFixed(0)) + ' (' + ((p.overheadPaid || 0) / START_CASH * 100).toFixed(2) + '% drag on starting capital)');
      if (positions.length) {
        console.log('\nOpen positions:');
        console.table(positions);
      } else {
        console.log('\nNo open positions.');
      }
      if (realizedRows.length) {
        console.log('\nRealized P&L by stock:');
        console.table(realizedRows);
      }
      return {
        value: totalVal, totalReturn: totalRet, cash: p.cash,
        deployed: totalDeployed, unrealized: totalUnrealized,
        realized: totalRealized, overheadPaid: p.overheadPaid || 0,
        positions: positions, realizedByStock: realizedRows
      };
    },
    _portfolios: function () { return portfolios; },
    setConfig: function (obj) {
      for (var k in obj) if (k in CFG) CFG[k] = obj[k];
      return CFG;
    },
    getConfig: function () { return JSON.parse(JSON.stringify(CFG)); },
    status: function () {
      var rows = [];
      Object.keys(M.goods).forEach(function (k) {
        var g = M.goods[k];
        var st = stateByGood[k];
        var rest = restingValue(g);
        var row = {
          name: g.name,
          price: +g.val.toFixed(2),
          resting: +rest.toFixed(2),
          gameMode: MODES[g.mode],
          stock: g.stock,
          cap: M.getGoodMaxStock(g)
        };
        if (st) {
          var fc = forecast(st.belief, g.val, rest, st, g);
          row.belief = MODES[dominantMode(st.belief)] + ' (' + st.belief[dominantMode(st.belief)].toFixed(2) + ')';
          row.forecastMean = +fc.mean.toFixed(2);
          row.forecastStd  = +fc.std.toFixed(2);
        }
        rows.push(row);
      });
      console.table(rows);
      return rows;
    },
    beliefs: function () {
      var rows = [];
      Object.keys(M.goods).forEach(function (k) {
        var g = M.goods[k];
        var st = stateByGood[k];
        if (!st) { rows.push({ name: g.name, belief: 'not initialized' }); return; }
        var r = { name: g.name };
        for (var i = 0; i < N; i++) r[MODES[i]] = +st.belief[i].toFixed(3);
        r.gameSaysMode = MODES[g.mode];
        rows.push(r);
      });
      console.table(rows);
      return rows;
    },
    learnedParams: function () {
      var tRows = [], eRows = [];
      for (var i = 0; i < N; i++) {
        var tr = { from: MODES[i] };
        for (var j = 0; j < N; j++) tr[MODES[j]] = +TRANSITION[i][j].toFixed(3);
        tRows.push(tr);
        eRows.push({
          mode: MODES[i], mu: +EMISSION_MU[i].toFixed(4), sigma: +EMISSION_SIGMA[i].toFixed(4),
          n: +ESTIMATOR.n[i].toFixed(0), priorMu: PRIOR_MU[i], priorSigma: PRIOR_SIGMA[i]
        });
      }
      console.log('Transition matrix (from → to):'); console.table(tRows);
      console.log('Emissions per mode, ' + ESTIMATOR.totalTransitions + ' total obs:'); console.table(eRows);
      return { transition: TRANSITION, emissionMu: EMISSION_MU, emissionSigma: EMISSION_SIGMA, totalTransitions: ESTIMATOR.totalTransitions };
    },
    resetEstimator: function () { initEstimator(); refreshLearnedParams(); log('estimator reset to prior'); },
    // EV report: for each stock, compute the buy edge per unit, total EV at
    // current room, and the ROI of buying one more of the corresponding
    // building purely for the stock-capacity it unlocks. Useful for deciding
    // whether to expand buildings as an investment in trading capacity.
    evReport: function () {
      var rows = [];
      var cpsRaw = Game.cookiesPsRawHighest || 1;
      var oh = overheadFactor();
      Object.keys(M.goods).forEach(function (key) {
        var g = M.goods[key], st = stateByGood[key];
        if (!g || !st) return;
        var v = g.val, rest = restingValue(g), fc = forecast(st.belief, v, rest, st, g);
        var buyCost = v * (1 + oh);
        var buyEV = fc.mean - buyCost - CFG.riskAversion * fc.std;   // risk-adjusted $/unit
        var naiveEdge = fc.mean - buyCost;                            // no risk penalty
        var cap = M.getGoodMaxStock(g), owned = g.stock;
        var room = Math.max(0, cap - owned);
        var totalEV_dollars = buyEV * room;
        var totalEV_cookies = totalEV_dollars * cpsRaw;
        // Building ROI: one more building gives +1 cap, worth buyEV * cpsRaw cookies.
        // Compare to building cost. Ratio > 1 means the building pays for itself
        // in one trade cycle purely from stock market capacity.
        var bldg = Game.Objects && Game.Objects[key];
        var bldgCost = bldg ? bldg.price : null;
        var capGainPerBldg = buyEV * cpsRaw;
        var bldgROI = (bldgCost && bldgCost > 0) ? capGainPerBldg / bldgCost : null;
        rows.push({
          key: key,
          name: g.name,
          price: +v.toFixed(2),
          rest: +rest.toFixed(2),
          forecastMu: +fc.mean.toFixed(2),
          buyEV_per_unit: +buyEV.toFixed(2),
          naiveEdge: +naiveEdge.toFixed(2),
          room: room,
          totalEV_dollars: +totalEV_dollars.toFixed(0),
          totalEV_cookies: totalEV_cookies.toExponential(2),
          bldgCost: bldgCost != null ? +bldgCost.toFixed(0) : null,
          bldgROI_per_trade: bldgROI != null ? +bldgROI.toFixed(3) : null
        });
      });
      // Sort by total EV descending so the top picks are obvious
      rows.sort(function (a, b) { return b.totalEV_dollars - a.totalEV_dollars; });
      console.log('EV report at overhead ' + (oh * 100).toFixed(1) + '% (cpsRaw=' + cpsRaw.toExponential(2) + '):');
      console.log('  buyEV_per_unit = risk-adjusted $ profit per unit bought now (+ = good)');
      console.log('  totalEV_dollars = buyEV × available room (what you\'d make filling the cap)');
      console.log('  bldgROI_per_trade = how many times 1 extra building pays back per round-trip (> 1 = buy the building)');
      console.table(rows);
      return rows;
    },
    // Diagnostic for the stock-row color overlay. Reports whether each
    // stock's DOM row was successfully resolved and what color (if any) is
    // currently applied. Useful if the rows aren't tinting in the market.
    rowColorDebug: function () {
      var rows = [];
      Object.keys(M.goods).forEach(function (key) {
        var g = M.goods[key]; if (!g) return;
        var el = stockRowElCache[key];
        var st = stateByGood[key];
        var action = null;
        if (st) { try { action = decide(g, st).action; } catch (e) {} }
        rows.push({
          stock: g.name, key: key, id: g.id,
          domFound: !!el,
          domId: el && el.id ? el.id : null,
          currentBg: el && el.style ? el.style.backgroundColor : null,
          action: action
        });
      });
      console.table(rows);
      var missing = rows.filter(function (r) { return !r.domFound; }).length;
      if (missing > 0) {
        console.log('[CCTrader] ' + missing + '/' + rows.length + ' rows have no DOM element. ' +
          'Open the stock market panel in-game and re-run, or paste one of the row element ids into ' +
          'CCTrader.setConfig({ _stockRowIdPrefix: "..." }) if you know the correct prefix.');
      }
      return rows;
    },
    explain: function (key) {
      var g = M.goods[key], st = stateByGood[key];
      if (!g || !st) { console.log('No data for', key); return; }
      var rest = restingValue(g), fc = forecast(st.belief, g.val, rest, st, g);
      var oh = overheadFactor(), v = g.val, cost = v * (1 + oh);
      var buyEV = fc.mean - cost - CFG.riskAversion * fc.std;
      var sellEV = v - fc.mean - CFG.riskAversion * fc.std;
      var belief = {};
      for (var i = 0; i < N; i++) belief[MODES[i]] = +st.belief[i].toFixed(3);
      var maxD = currentMaxDuration();
      var eRem = st.modeAgeKnown ? expectedRemainingTicks(st.modeAge, true) : null;
      console.log(key + ' (' + g.name + ') @ $' + v.toFixed(2) + ', rest $' + rest.toFixed(2) +
        ', owned ' + g.stock + '/' + M.getGoodMaxStock(g) +
        ', mode=' + MODES[g.mode] + ', overhead=' + (oh * 100).toFixed(2) + '%');
      console.log('  belief:', belief);
      console.log('  modeAge=' + st.modeAge + ' ticks' + (st.modeAgeKnown ? '' : ' (unknown since install)') +
        ', maxD=' + maxD + ', E[remaining]=' + (eRem != null ? eRem.toFixed(1) + ' ticks' : 'n/a'));
      console.log('  forecast H=' + CFG.horizon + ': μ=$' + fc.mean.toFixed(2) + ' σ=$' + fc.std.toFixed(2));
      console.log('  buyEV=$' + buyEV.toFixed(2) + '/u (need >$' + CFG.minBuyEdge + '), sellEV=$' + sellEV.toFixed(2) + '/u (need >$' + CFG.minSellEdge + ')');
    }
  };

  window.CCTrader = api;
  api.start();
  try { runOnce(); } catch (e) { console.error(e); }
  try { renderUI(); } catch (e) { console.error(e); }
  Game.Notify('Bayesian Stock Trader active',
    'Self-learning HMM. Use <b>CCTrader.learnedParams()</b>, <b>beliefs()</b>, <b>explain("Farm")</b>.',
    [10, 0]);
})();

}
