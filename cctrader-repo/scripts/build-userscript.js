// Wraps src/cctrader.js in the userscript header + install()/wait-for-Game
// scaffold. Output goes to dist/cctrader.user.js.
const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cctrader.js'), 'utf8');

const header = `// ==UserScript==
// @name         Cookie Clicker Stock Auto-Trader
// @namespace    local.cctrader
// @version      ${VERSION}
// @description  Game-accurate Monte Carlo forecast + auto-trading for the Cookie Clicker stock market minigame.
// @homepage     https://github.com/YOUR_USERNAME/cctrader
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
`;

const footer = '\n}\n';

const outPath = path.join(__dirname, '..', 'dist', 'cctrader.user.js');
fs.writeFileSync(outPath, header + src + footer);
console.log('wrote', outPath);
