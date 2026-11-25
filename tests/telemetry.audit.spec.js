const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  calcularSlippage,
  calcularOBI,
  avaliarCvdEAbsorcao,
  avaliarRadarExaustaoCorredor,
  atualizarCandlesAgregados
} = require('../server');

test.afterAll(() => {
  const testDataDir = path.resolve(__dirname, '..', 'test-data');
  if (fs.existsSync(testDataDir)) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});

test.describe('1. Auditoria Lógica do Motor (Cálculos & Invariantes)', () => {
  test('OBI Top 10 e Slippage respeitam invariantes matemáticas', () => {
    const bids = [
      { TakerGets: { currency: 'RLUSD', value: '600' }, TakerPays: '600000000' },
      { TakerGets: { currency: 'RLUSD', value: '600' }, TakerPays: '610000000' }
    ];
    const asks = [
      { TakerGets: '600000000', TakerPays: { currency: 'RLUSD', value: '612' } },
      { TakerGets: '600000000', TakerPays: { currency: 'RLUSD', value: '624' } }
    ];

    const obi = calcularOBI(bids, asks, 10, 0);
    expect(obi.buyPercent + obi.sellPercent).toBeCloseTo(100, 5);

    const slipBuy = calcularSlippage(asks, 1000, 1.02, true);
    expect(slipBuy.semLiquidezSuficiente).toBe(false);
    expect(slipBuy.precoMedio).toBeGreaterThanOrEqual(1.02);
    expect(slipBuy.slippagePercent).toBeGreaterThanOrEqual(0);
  });

  test('Radar de Exaustão exige alternância TOPO -> FUNDO e 2 confirmações', () => {
    const baseMs = Date.UTC(2026, 10, 24, 12, 0, 0);
    const candles = atualizarCandlesAgregados(1.0000, baseMs);
    const commonCtx = {
      c1m: { ...candles.candle1m, positionInRangePct: 20, bodyChangePct: -0.3, isBearish: true, isBullish: false },
      c5m: { ...candles.candle5m, isBearish: true, isBullish: false },
      history: { m5: { historyPositionPct: 85 } },
      srVol: { atr5mPct: 0.25, volatilityRegime: 'NORMAL', confirmMultiplier: 1.0, nearResistance: true, nearSupport: false },
      candleBias: 'TOP_EXHAUSTION_CONTEXT'
    };

    // Âncora inicial em 1.0000 e subida de +1.5% até 1.0150
    avaliarRadarExaustaoCorredor({
      midPrice: 1.0000, microprice: 1.0001, obiTop5: { buyPercent: 60 }, obiDecay: { buyPercent: 55 },
      cvd60s: 200, priceDelta60s: 0.2, signalAbsorptionDivergence: 'NEUTRAL',
      ledgerFlow: { offerCancelRatio: 10 }, slippageVenda: { semLiquidezSuficiente: false, slippagePercent: 0.1 },
      candleContext: commonCtx, timestampMs: baseMs
    });

    avaliarRadarExaustaoCorredor({
      midPrice: 1.0150, microprice: 1.0151, obiTop5: { buyPercent: 60 }, obiDecay: { buyPercent: 55 },
      cvd60s: 400, priceDelta60s: 1.5, signalAbsorptionDivergence: 'NEUTRAL',
      ledgerFlow: { offerCancelRatio: 10 }, slippageVenda: { semLiquidezSuficiente: false, slippagePercent: 0.1 },
      candleContext: commonCtx, timestampMs: baseMs + 60_000
    });

    // 1ª leitura de recuo (-0.39% do topo 1.0150 -> 1.0110) após 3 velas de 5m: ainda não confirmado (1/2)
    const r1 = avaliarRadarExaustaoCorredor({
      midPrice: 1.0110, microprice: 1.0105, obiTop5: { buyPercent: 35 }, obiDecay: { buyPercent: 40 },
      cvd60s: -300, priceDelta60s: -0.2, signalAbsorptionDivergence: 'BEARISH_ABSORPTION',
      ledgerFlow: { offerCancelRatio: 45 }, slippageVenda: { semLiquidezSuficiente: false, slippagePercent: 0.35 },
      candleContext: commonCtx, timestampMs: baseMs + 20 * 60_000
    });
    expect(r1.confirmed).toBe(false);
    expect(r1.confirmations).toBe(1);

    // 2ª leitura consecutiva confirma TOPO e alterna busca para BOTTOM
    const r2 = avaliarRadarExaustaoCorredor({
      midPrice: 1.0108, microprice: 1.0102, obiTop5: { buyPercent: 32 }, obiDecay: { buyPercent: 38 },
      cvd60s: -350, priceDelta60s: -0.25, signalAbsorptionDivergence: 'BEARISH_ABSORPTION',
      ledgerFlow: { offerCancelRatio: 50 }, slippageVenda: { semLiquidezSuficiente: false, slippagePercent: 0.35 },
      candleContext: commonCtx, timestampMs: baseMs + 20 * 60_000 + 5000
    });
    expect(r2.confirmed).toBe(true);
    expect(r2.recordedSwing?.kind).toBe('TOPO');
    expect(r2.seekingPivot).toBe('BOTTOM');
  });
});

test.describe('2. Auditoria Ponta a Ponta da Interface & Console (Playwright)', () => {
  test('Carrega sem ReferenceError/TDZ, sobrevive ao F5 e valida regras visuais', async ({ page, request }) => {
    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForTimeout(400);

    // Envia histórico de ticks simulado
    const nowSec = Math.floor(Date.now() / 1000) - 10;
    await request.post('/__test__/emit', {
      data: {
        event: 'xrpl_tick_history',
        payload: [
          { timeSec: nowSec, midPrice: 0.9280, vwap: 0.9275 },
          { timeSec: nowSec + 3, midPrice: 0.9290, vwap: 0.9280 },
          { timeSec: nowSec + 6, midPrice: 0.9300, vwap: 0.9284 }
        ]
      }
    });

    // Envia pacote completo de telemetria e swings para validar DOM
    await request.post('/__test__/emit', {
      data: {
        event: 'xrpl_telemetry',
        payload: {
          timestamp: '21:30:00',
          bestAsk: 0.93100,
          bestBid: 0.92900,
          midPrice: 0.93000,
          microprice: 0.93020,
          spreadNominal: 0.00200,
          spreadPercentual: 0.21,
          profundidadeAskXRP: 1200,
          profundidadeAskRLUSD: 1117.2,
          profundidadeBidXRP: 1500,
          profundidadeBidRLUSD: 1393.5,
          imbalanceBuyPercent: 55.5,
          imbalanceSellPercent: 44.5,
          obiTop5: { buyPercent: 58.0 },
          obiTop20: { buyPercent: 52.0 },
          obiDecay: { buyPercent: 56.0 },
          cvdRLUSD: 1250.5,
          cvd60s: 320.0,
          cvd300s: 890.0,
          vpinProxy60s: 24.5,
          signalAbsorptionDivergence: 'BULLISH_ABSORPTION',
          ledgerFlow: { offerCancelRatio: 18.2, ammTxCount: 2 },
          slippageCompra: { precoMedio: 0.9315, slippagePercent: 0.05, semLiquidezSuficiente: false },
          slippageVenda: { precoMedio: 0.9285, slippagePercent: 0.05, semLiquidezSuficiente: false },
          vwap: 0.9284,
          externalConfluence: { price: 0.9295, source: 'Coinbase XRP-USD', diffPercent: 0.05, status: 'ALIGNED' },
          exhaustionRadar: {
            signal: 'NEUTRAL',
            score: 2,
            maxScore: 6,
            legMovePct: 0.45,
            legAnchorPrice: 0.9258,
            lastPivotKind: 'FUNDO',
            seekingPivot: 'TOP',
            trailingHigh: 0.9300,
            trailingLow: 0.9258,
            pullbackFromHighPct: 0,
            bounceFromLowPct: 0.45,
            trailingStopPrice: 0.92768,
            phaseLabel: 'SUBINDO_DESDE_FUNDO',
            utcDayKey: '2026-11-24',
            dailySwings: [
              { timeLabel: '00:15:00 UTC / 21:15:00 BRT', kind: 'TOPO', price: 0.94100, score: 5, maxScore: 6, legMovePct: 1.42 },
              { timeLabel: '00:05:00 UTC / 21:05:00 BRT', kind: 'FUNDO', price: 0.92780, score: 4, maxScore: 6, legMovePct: -1.35 }
            ]
          },
          candleContext: { marketRegime: 'TREND_UP', candleBias: 'NEUTRAL' }
        }
      }
    });

    // Verifica ausência de NaN/undefined nos cards principais
    const bestAskText = await page.locator('#bestAsk').innerText();
    const bestBidText = await page.locator('#bestBid').innerText();
    expect(bestAskText).toBe('$0.93100');
    expect(bestBidText).toBe('$0.92900');

    // Verifica inversão semântica de cores no Registro 24h (TOPO = bid verde, FUNDO = ask vermelho)
    const firstRowExtremo = page.locator('#dailySwingsBody tr').nth(0).locator('td').nth(1);
    const secondRowExtremo = page.locator('#dailySwingsBody tr').nth(1).locator('td').nth(1);
    await expect(firstRowExtremo).toHaveText('TOPO');
    await expect(firstRowExtremo).toHaveClass(/bid/);
    await expect(secondRowExtremo).toHaveText('FUNDO');
    await expect(secondRowExtremo).toHaveClass(/ask/);

    // Testa troca de timeframes e botão EXPANDIR
    await page.locator('.tf-btn[data-tf="5m"]').click();
    await expect(page.locator('#chartReadTf')).toHaveText('TF: 5m');
    await page.locator('.tf-btn[data-tf="TICK"]').click();
    await expect(page.locator('#chartReadTf')).toHaveText('TF: TICK');

    // Testa atualização de parâmetros em tempo real
    await page.fill('#cfgWhaleThreshold', '7500');
    await page.click('#btnApplyRuntimeConfig');
    await expect(page.locator('#runtimeConfigStatus')).toContainText('Whale ≥ $7500');

    // Recarrega a página (F5) para auditar ausência de TDZ (lastEMA9) e persistência
    await page.reload();
    await page.waitForTimeout(500);

    expect(pageErrors, `Erros não capturados na página: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `Erros no console: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
