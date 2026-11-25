#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALL_V6_ASSETS,
  hasExchangeCredentials,
  loadConfig,
  normalizeRiskTier,
  redactConfig,
  scrubSecrets,
} from './config.mjs';
import {
  computeRegimeTelemetry,
  computeV8MacroRegimeRadar,
  createExchangeClient,
  evaluateStrategy,
  getAllVersionsMatrixPreview,
  loadOfflineOrDbDataset,
  loadRuntimeSpecs,
  normalizeAssetSymbol,
  runFrontierPortfolio,
  StandaloneTradingDaemon,
} from './engine_runtime.mjs';
import { isEquitySymbol, YahooEquitiesClient } from './market_equities.mjs';
import { CommercialPlatformEngine } from './commercial_engine.mjs';
import { CommercialStore } from './commercial_store.mjs';
import { issueLicenseKey, resolveLicenseSigningSecret } from './license_issuer.mjs';
import { resolveRouterMode } from './order_router.mjs';
import { createStandaloneServer } from './server.mjs';
import { StandaloneStore } from './store_sqlite.mjs';

function parseCliArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'doctor';
  const flags = {};
  for (let i = cmd === args[0] ? 1 : 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    }
  }
  return { cmd, flags };
}

export async function runDoctor({ config } = {}) {
  const cfg = config || loadConfig();
  const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
  const nodeMajor = Number(process.versions.node.split('.')[0]);

  let sqliteOk = false;
  let sqliteJournalMode = '';
  let sqliteError = null;
  try {
    const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
    sqliteJournalMode = store.getJournalMode();
    sqliteOk = sqliteJournalMode === 'wal';
    store.close();
  } catch (err) {
    sqliteError = err.message;
  }

  const okxClient = createExchangeClient(cfg, 'OKX');
  const binanceClient = createExchangeClient(cfg, 'BINANCE');
  const yahooClient = new YahooEquitiesClient();

  let okxPublic = { ok: false };
  try {
    const ticker = await okxClient.getOrderbookTicker('BTCUSDT.P');
    okxPublic = { ok: true, instId: ticker.instId, last: ticker.last };
  } catch (err) {
    okxPublic = { ok: false, error: scrubSecrets(err.message, cfg) };
  }

  let binancePublic = { ok: false };
  try {
    const ticker = await binanceClient.getOrderbookTicker('BTCUSDT.P');
    binancePublic = { ok: true, symbol: ticker.symbol, bid: ticker.bidPrice, ask: ticker.askPrice };
  } catch (err) {
    binancePublic = { ok: false, error: scrubSecrets(err.message, cfg) };
  }

  let yahooMacro = { ok: false };
  try {
    const macro = await yahooClient.getMacroSnapshot({ range: '1mo' });
    yahooMacro = { ok: true, vix: macro.vix, tnx: macro.tnx };
  } catch (err) {
    yahooMacro = { ok: false, error: scrubSecrets(err.message, cfg) };
  }

  let activeAccountHealth = { configured: hasExchangeCredentials(cfg), connected: false, mode: 'PAPER_NO_KEYS' };
  if (hasExchangeCredentials(cfg)) {
    try {
      const client = createExchangeClient(cfg);
      activeAccountHealth = await client.getAccountHealth();
    } catch (err) {
      activeAccountHealth = {
        configured: true,
        connected: false,
        error: scrubSecrets(err.message, cfg),
      };
    }
  }

  return {
    ok: nodeMajor >= 22 && sqliteOk && Boolean(runtimeSpecs.lock1h && runtimeSpecs.lock15m),
    nodeVersion: process.version,
    nodeMajorOk: nodeMajor >= 22,
    sqlite: { ok: sqliteOk, journalMode: sqliteJournalMode, path: path.relative(cfg.repoRoot, cfg.sqlitePath), error: sqliteError },
    supportedAssets: ALL_V6_ASSETS.map(a => a.symbol),
    models: {
      v41Lock1h: Boolean(runtimeSpecs.lock1h),
      v41Lock15m: Boolean(runtimeSpecs.lock15m),
      v5Engine: runtimeSpecs.hasV5Engine,
      v5MlReady: runtimeSpecs.hasV5Ml,
      v6Engine: runtimeSpecs.hasV6Engine,
      v6CryptoModelsReady: runtimeSpecs.hasV6CryptoModels,
      v6StockModelsReady: runtimeSpecs.hasV6StockModels,
      v7Engine: runtimeSpecs.hasV7Engine,
      v7ModelsReady: runtimeSpecs.hasV7Models,
      v7FrontierReady: runtimeSpecs.hasV7Frontier,
      v8RegimeEngine: runtimeSpecs.hasV8RegimeEngine,
      v8ModelsReady: runtimeSpecs.hasV8Models,
      v8FrontierReady: runtimeSpecs.hasV8Frontier,
      v9Engine: runtimeSpecs.hasV9Engine,
      v9ModelsReady: runtimeSpecs.hasV9Models,
      v9FrontierReady: runtimeSpecs.hasV9Frontier,
      allVersionsMatrixReady: runtimeSpecs.hasAllVersionsMatrix,
      v10CommercialReady: true,
      btcV5ModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v5/ml_models_btc_v5.json')),
      altV5ModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v5/ml_models_alt_v5.json')),
      v6BtcBnbModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v6/models_btc_bnb_5y.json')),
      v6EthSolModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v6/models_eth_sol_5y.json')),
      v6StocksModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v6/models_stocks_v6.json')),
      v7BtcBnbModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v7/models_v7_btc_bnb.json')),
      v7EthSolModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v7/models_v7_eth_sol.json')),
      v7FrontierFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v7/frontier_75wr_30mo_summary.json')),
      v8RegimeEngineFile: fs.existsSync(path.join(cfg.repoRoot, 'research/regime_engine_v8.mjs')),
      v8BtcBnbModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v8/models_v8_btc_bnb.json')),
      v8EthSolModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v8/models_v8_eth_sol.json')),
      v8FrontierFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v8/maximized_v8_summary.json')),
      v9EnsembleFile: fs.existsSync(path.join(cfg.repoRoot, 'research/ensemble_v9_walkforward.mjs')),
      v9ModelsFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v9/models_v9_crypto.json')),
      v9FrontierFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v9/ensemble_v9_crypto_5y.json')),
      allVersionsMatrixFile: fs.existsSync(path.join(cfg.repoRoot, 'research/results_v9/all_versions_comparison_matrix.json')),
      v10VaultFile: fs.existsSync(path.join(cfg.repoRoot, 'standalone/crypto_vault.mjs')),
      v10SpecsFile: fs.existsSync(path.join(cfg.repoRoot, 'standalone/instrument_specs.mjs')),
      v10LicenseFile: fs.existsSync(path.join(cfg.repoRoot, 'standalone/license_issuer.mjs')),
      v10CommercialStoreFile: fs.existsSync(path.join(cfg.repoRoot, 'standalone/commercial_store.mjs')),
      v10CommercialEngineFile: fs.existsSync(path.join(cfg.repoRoot, 'standalone/commercial_engine.mjs')),
    },
    routerMode: resolveRouterMode(cfg),
    connectivity: {
      okxPublic,
      binancePublic,
      yahooMacro,
    },
    accountHealth: activeAccountHealth,
    configRedacted: redactConfig(cfg),
  };
}

export async function runSync(flags, cfg) {
  const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
  try {
    const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
    const daemon = new StandaloneTradingDaemon({ config: cfg, store, runtimeSpecs });
    const symbols = flags.symbol ? [normalizeAssetSymbol(flags.symbol)] : cfg.symbols.map(normalizeAssetSymbol);
    const bars = Math.max(100, Math.min(2000, Number(flags.bars || 600)));
    const results = [];
    for (const symbol of symbols) {
      const tfs = flags.timeframe
        ? [String(flags.timeframe).toLowerCase()]
        : (isEquitySymbol(symbol) ? ['1d'] : (symbol === 'BTCUSDT.P' ? ['1h', '15m'] : ['1h']));
      for (const timeframe of tfs) {
        const res = await daemon.syncMarketData({ symbol, timeframe, bars });
        results.push(res);
      }
    }
    return results;
  } finally {
    store.close();
  }
}

export async function runBacktest(flags, cfg) {
  const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
  try {
    const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
    const symbol = normalizeAssetSymbol(flags.symbol || cfg.symbols[0] || 'BTCUSDT.P');
    const isEq = isEquitySymbol(symbol);
    const timeframe = String(flags.timeframe || (isEq ? '1d' : '1h')).toLowerCase();
    const profile = String(flags.profile || (isEq ? 'EQUITY_ETF' : 'EXCHANGE_POST_ONLY')).toUpperCase();
    const mlEnabled = !flags['no-ml'];
    const version = String(flags.version || 'auto').toLowerCase();
    const riskTier = normalizeRiskTier(flags.tier || cfg.riskTier || 'SAFE_75WR');

    const loaded = loadOfflineOrDbDataset({ store, config: cfg, symbol, timeframe, minBars: 220 });
    const evalRes = evaluateStrategy({
      dataset: loaded.dataset,
      fundingRates: loaded.fundingRates,
      macroData: loaded.macroData,
      timeframe,
      symbol,
      exchange: isEq ? 'YAHOO' : cfg.exchange,
      execProfile: profile,
      mlEnabled,
      version,
      riskTier,
      config: cfg,
      runtimeSpecs,
    });
    return {
      source: loaded.source,
      summary: evalRes.summary,
      regime: evalRes.regime,
      liquidationDistance: evalRes.liquidationDistance,
      monthlySummary: evalRes.monthlySummary,
      execOptions: evalRes.execOptions,
    };
  } finally {
    store.close();
  }
}

export async function runPortfolio(flags, cfg) {
  const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
  const riskTier = normalizeRiskTier(flags.tier || cfg.riskTier || 'SAFE_75WR');
  const profile = String(flags.profile || 'EXCHANGE_POST_ONLY').toUpperCase();
  const version = String(flags.version || 'auto').toLowerCase();
  return runFrontierPortfolio({
    version,
    runtimeSpecs,
    config: cfg,
    riskTier,
    execProfile: profile,
  });
}

export async function runRegime(flags, cfg) {
  const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
  try {
    const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
    const symbol = normalizeAssetSymbol(flags.symbol || cfg.symbols[0] || 'BTCUSDT.P');
    const isEq = isEquitySymbol(symbol);
    const timeframe = String(flags.timeframe || (isEq ? '1d' : '1h')).toLowerCase();
    let loaded = null;
    try {
      loaded = loadOfflineOrDbDataset({ store, config: cfg, symbol, timeframe, minBars: 60 });
    } catch {
      loaded = null;
    }
    const radar = computeV8MacroRegimeRadar({
      repoRoot: cfg.repoRoot,
      runtimeSpecs,
      dataset: loaded?.dataset || null,
      fundingRates: loaded?.fundingRates || [],
      macroData: loaded?.macroData || null,
      symbol,
      timeframe,
    });
    const telemetry = computeRegimeTelemetry({
      repoRoot: cfg.repoRoot,
      runtimeSpecs,
      dataset: loaded?.dataset || null,
      fundingRates: loaded?.fundingRates || [],
      macroData: loaded?.macroData || null,
      symbol,
      timeframe,
    });
    return {
      source: loaded?.source || 'local-fallback',
      radar,
      telemetry,
    };
  } finally {
    store.close();
  }
}

export async function runVersions(_flags, cfg) {
  const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
  return getAllVersionsMatrixPreview({ repoRoot: cfg.repoRoot, runtimeSpecs });
}

export async function runLicense(flags, cfg) {
  const planId = String(flags.plan || 'PRO_AUTO_TRADER').trim().toUpperCase();
  const subscriberRef = String(flags.ref || 'buyer@example.com').trim();
  const durationDays = Number(flags.days || 30);
  const maxCapitalUsdtOverride = flags['max-capital'] ? Number(flags['max-capital']) : null;
  const signingSecret = resolveLicenseSigningSecret(cfg);
  return issueLicenseKey({
    planId,
    subscriberRef,
    durationDays,
    maxCapitalUsdtOverride,
    signingSecret,
  });
}

export async function runCommercialSim(flags, cfg) {
  const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
  try {
    const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
    const commercialStore = new CommercialStore(store);
    const engine = new CommercialPlatformEngine({ store, commercialStore, config: cfg, runtimeSpecs });
    return await engine.simulateCapitalPreview({
      equityUsdt: Number(flags.equity || 1500),
      exchange: String(flags.exchange || cfg.exchange || 'OKX').toUpperCase(),
      version: String(flags.version || 'v9').toLowerCase(),
      riskTier: normalizeRiskTier(flags.tier || cfg.riskTier || 'SAFE_75WR'),
      riskPct: Number(flags.risk || 1.0),
    });
  } finally {
    store.close();
  }
}

export async function runServe(flags, cfg) {
  if (flags.port) cfg.port = Number(flags.port);
  const store = new StandaloneStore({ dbPath: cfg.sqlitePath, allowedBaseDir: cfg.allowedDataDir });
  const runtimeSpecs = await loadRuntimeSpecs(cfg.repoRoot);
  const daemon = new StandaloneTradingDaemon({ config: cfg, store, runtimeSpecs, autoRoute: false });
  const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs, daemon, checkAccountHealth: true });

  for (const rawSym of cfg.symbols) {
    const symbol = normalizeAssetSymbol(rawSym);
    const tfs = isEquitySymbol(symbol) ? ['1d'] : (symbol === 'BTCUSDT.P' ? ['1h', '15m'] : ['1h']);
    for (const timeframe of tfs) {
      try {
        await daemon.evaluateAndRoute({ symbol, timeframe });
      } catch {
        // non-fatal if local data missing before background sync
      }
    }
  }
  daemon.start(60000);
  const bound = await srv.start();
  console.log(`[standalone] v10.0 Command Center & Commercial Portal running at http://${bound.host}:${bound.port} (mode=${cfg.executionMode}, dryRun=${cfg.dryRun})`);

  const shutdown = async () => {
    daemon.stop();
    await srv.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { bound, daemon, srv, store };
}

async function main() {
  const { cmd, flags } = parseCliArgs(process.argv);
  const cfg = loadConfig();
  if (flags.exchange) {
    const ex = String(flags.exchange).toUpperCase();
    if (['OKX', 'BINANCE', 'YAHOO'].includes(ex)) cfg.exchange = ex;
  }

  if (cmd === 'doctor') {
    const report = await runDoctor({ config: cfg });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else if (cmd === 'sync') {
    const results = await runSync(flags, cfg);
    console.log(JSON.stringify({ ok: true, synced: results }, null, 2));
  } else if (cmd === 'backtest') {
    const res = await runBacktest(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'portfolio') {
    const res = await runPortfolio(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'regime') {
    const res = await runRegime(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'versions') {
    const res = await runVersions(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'license') {
    const res = await runLicense(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'commercial-sim') {
    const res = await runCommercialSim(flags, cfg);
    console.log(JSON.stringify({ ok: true, ...res }, null, 2));
  } else if (cmd === 'serve') {
    await runServe(flags, cfg);
  } else {
    console.error(`Unknown subcommand "${cmd}". Usage: node standalone/cli.mjs <doctor|sync|backtest|portfolio|regime|versions|license|commercial-sim|serve>`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`[standalone] Error: ${err.message}`);
    process.exit(1);
  });
}
