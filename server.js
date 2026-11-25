require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const xrpl = require('xrpl');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const XRPLEngine = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const engine = new XRPLEngine();

const WINDOW_60S_MS = 60 * 1000;
const WINDOW_300S_MS = 5 * 60 * 1000;
const OBI_DECAY_LAMBDA = 0.25;

let cvdRLUSD = 0;
let totalVolumeRLUSDAcumulado = 0;
let totalVolumeXRPAcumulado = 0;
let vwapAtual = 0;
let tradeHistory = [];
let tradeEventsWindow = [];
let midPriceHistory = [];
let tickHistory = [];
const MAX_TICK_HISTORY = 360;
let ledgerFlowEvents = [];
let lastTelemetryRunMs = 0;

function calcularMidEstabilizado(rawMidPrice) {
    if (!Number.isFinite(rawMidPrice) || rawMidPrice <= 0) return rawMidPrice;
    const recentes = midPriceHistory.slice(-3).map(p => p.price).filter(p => Number.isFinite(p) && p > 0);
    if (recentes.length < 2) return rawMidPrice;

    const ordenados = [...recentes].sort((a, b) => a - b);
    const mediana = ordenados[Math.floor(ordenados.length / 2)];
    const desvioPct = mediana > 0 ? (Math.abs(rawMidPrice - mediana) / mediana) * 100 : 0;

    if (desvioPct > 0.35) {
        return mediana;
    }
    return rawMidPrice;
}

let runtimeConfig = {
    minSwingLegPct: 1.20,
    reversalConfirmPct: 0.25,
    minCandles5mBetweenPivots: 3,
    ofiThreshold: parseFloat(process.env.OFI_THRESHOLD || "0.55"),
    slippageAmountRlusd: 1000,
    whaleThresholdRlusd: Math.max(parseFloat(process.env.WHALE_THRESHOLD_RLUSD || "5000"), 50),
    pollingIntervalMs: Math.max(parseInt(process.env.POLLING_INTERVAL_MS || "3000", 10), 1500),
    emaTrendFilter: process.env.EMA_TREND_FILTER === "true",
    enableTelegramAlerts: process.env.ENABLE_TELEGRAM_ALERTS === "true"
};

const SWINGS_PERSIST_DIR = process.env.TELEMETRY_DATA_DIR
    ? path.resolve(process.env.TELEMETRY_DATA_DIR)
    : path.join(__dirname, 'data');
const SWINGS_PERSIST_FILE = path.join(SWINGS_PERSIST_DIR, 'daily_swings_24h.json');

let currentUtcDayKey = null;
let dailySwings = [];
let pivotState = {
    seeking: "ANY", // "ANY" | "TOP" | "BOTTOM"
    lastPivotKind: null,
    lastPivotPrice: null,
    lastPivotCandle5mStartMs: null,
    candidateHigh: null,
    candidateLow: null,
    legMovePct: 0,
    phaseLabel: "AGUARDANDO_DADOS"
};

function getUtcDayKey(dateObj = new Date()) {
    return dateObj.toISOString().slice(0, 10);
}

function formatUtcAndBrtTime(dateObj = new Date()) {
    const utcTime = dateObj.toISOString().slice(11, 19);
    const brtTime = dateObj.toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour12: false
    });
    return `${utcTime} UTC / ${brtTime} BRT`;
}

function salvarEstadoSwingsJSON() {
    try {
        if (!fs.existsSync(SWINGS_PERSIST_DIR)) {
            fs.mkdirSync(SWINGS_PERSIST_DIR, { recursive: true });
        }
        const payload = {
            utcDayKey: currentUtcDayKey || getUtcDayKey(new Date()),
            updatedAtIso: new Date().toISOString(),
            dailySwings: Array.isArray(dailySwings) ? dailySwings.slice(0, 50) : [],
            pivotState
        };
        fs.writeFileSync(SWINGS_PERSIST_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        console.error("[ERRO PERSISTENCIA JSON]", err.message);
    }
}

function carregarEstadoSwingsJSON() {
    const todayKey = getUtcDayKey(new Date());
    currentUtcDayKey = todayKey;

    try {
        if (!fs.existsSync(SWINGS_PERSIST_FILE)) {
            salvarEstadoSwingsJSON();
            return;
        }
        const raw = fs.readFileSync(SWINGS_PERSIST_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        if (parsed && parsed.utcDayKey === todayKey) {
            dailySwings = Array.isArray(parsed.dailySwings) ? parsed.dailySwings.slice(0, 50) : [];
            if (parsed.pivotState && typeof parsed.pivotState === 'object') {
                pivotState = {
                    ...pivotState,
                    ...parsed.pivotState
                };
            } else if (dailySwings.length > 0) {
                const ultimo = dailySwings[0];
                pivotState.lastPivotKind = ultimo.kind;
                pivotState.lastPivotPrice = Number(ultimo.price);
                pivotState.seeking = ultimo.kind === "TOPO" ? "BOTTOM" : "TOP";
            }
            console.log(`[PERSISTENCIA JSON] Carregados ${dailySwings.length} swings do ciclo UTC ${todayKey}.`);
        } else {
            dailySwings = [];
            salvarEstadoSwingsJSON();
            console.log(`[PERSISTENCIA JSON] Novo ciclo UTC ${todayKey} iniciado (reset 00:00 UTC).`);
        }
    } catch (err) {
        console.error("[ERRO LEITURA JSON]", err.message);
        dailySwings = [];
    }
}

const TELEMETRY_STATE_FILE = path.join(SWINGS_PERSIST_DIR, 'telemetry_history_state.json');
const MAX_CANDLES_STORED = 60;
const CANDLE_1M_MS = 60 * 1000;
const CANDLE_5M_MS = 5 * 60 * 1000;
const CANDLE_15M_MS = 15 * 60 * 1000;
const CANDLE_1H_MS = 60 * 60 * 1000;

let candles1m = [];
let candles5m = [];
let candles15m = [];
let candles1h = [];
let dayRangeState = {
    dayKey: null,
    high: null,
    low: null,
    open: null
};

let lastTelemetryPersistMs = 0;

function salvarEstadoTelemetriaJSON(force = false) {
    try {
        const now = Date.now();
        if (!force && now - lastTelemetryPersistMs < 3000) return;
        lastTelemetryPersistMs = now;

        if (!fs.existsSync(SWINGS_PERSIST_DIR)) {
            fs.mkdirSync(SWINGS_PERSIST_DIR, { recursive: true });
        }

        const payload = {
            utcDayKey: currentUtcDayKey || getUtcDayKey(new Date()),
            updatedAtIso: new Date(now).toISOString(),
            cvdRLUSD,
            totalVolumeRLUSDAcumulado,
            totalVolumeXRPAcumulado,
            vwapAtual,
            tradeHistory: Array.isArray(tradeHistory) ? tradeHistory.slice(0, 15) : [],
            tickHistory: Array.isArray(tickHistory) ? tickHistory.slice(-MAX_TICK_HISTORY) : [],
            candles1m: candles1m.slice(-MAX_CANDLES_STORED),
            candles5m: candles5m.slice(-MAX_CANDLES_STORED),
            candles15m: candles15m.slice(-MAX_CANDLES_STORED),
            candles1h: candles1h.slice(-MAX_CANDLES_STORED),
            dayRangeState
        };

        fs.writeFileSync(TELEMETRY_STATE_FILE, JSON.stringify(payload), 'utf8');
    } catch (err) {
        console.error("[ERRO PERSISTENCIA TELEMETRIA JSON]", err.message);
    }
}

function carregarEstadoTelemetriaJSON() {
    const todayKey = getUtcDayKey(new Date());
    try {
        if (!fs.existsSync(TELEMETRY_STATE_FILE)) return;
        const raw = fs.readFileSync(TELEMETRY_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;

        if (Array.isArray(parsed.tickHistory)) {
            tickHistory = parsed.tickHistory
                .filter(t => t && Number.isFinite(Number(t.timeSec)) && Number.isFinite(Number(t.midPrice)) && Number(t.midPrice) > 0)
                .slice(-MAX_TICK_HISTORY);
        }

        if (Array.isArray(parsed.candles1m)) candles1m = parsed.candles1m.slice(-MAX_CANDLES_STORED);
        if (Array.isArray(parsed.candles5m)) candles5m = parsed.candles5m.slice(-MAX_CANDLES_STORED);
        if (Array.isArray(parsed.candles15m)) candles15m = parsed.candles15m.slice(-MAX_CANDLES_STORED);
        if (Array.isArray(parsed.candles1h)) candles1h = parsed.candles1h.slice(-MAX_CANDLES_STORED);

        if (parsed.dayRangeState && parsed.dayRangeState.dayKey === todayKey) {
            dayRangeState = parsed.dayRangeState;
        }

        if (parsed.utcDayKey === todayKey) {
            if (Number.isFinite(Number(parsed.cvdRLUSD))) cvdRLUSD = Number(parsed.cvdRLUSD);
            if (Number.isFinite(Number(parsed.totalVolumeRLUSDAcumulado))) totalVolumeRLUSDAcumulado = Number(parsed.totalVolumeRLUSDAcumulado);
            if (Number.isFinite(Number(parsed.totalVolumeXRPAcumulado))) totalVolumeXRPAcumulado = Number(parsed.totalVolumeXRPAcumulado);
            if (Number.isFinite(Number(parsed.vwapAtual)) && Number(parsed.vwapAtual) > 0) vwapAtual = Number(parsed.vwapAtual);
            if (Array.isArray(parsed.tradeHistory) && parsed.tradeHistory.length > 0) {
                tradeHistory = parsed.tradeHistory.slice(0, 15);
            }
        }

        console.log(`[PERSISTENCIA TELEMETRIA] Carregados ${tickHistory.length} ticks e ${candles1m.length} velas 1m.`);
    } catch (err) {
        console.error("[ERRO LEITURA TELEMETRIA JSON]", err.message);
    }
}

function syncUtcCycle(nowDate = new Date()) {
    const dayKey = getUtcDayKey(nowDate);
    if (currentUtcDayKey === null) {
        currentUtcDayKey = dayKey;
    } else if (dayKey !== currentUtcDayKey) {
        currentUtcDayKey = dayKey;
        dailySwings = [];
        pivotState = {
            seeking: "ANY",
            lastPivotKind: null,
            lastPivotPrice: null,
            lastPivotCandle5mStartMs: null,
            candidateHigh: null,
            candidateLow: null,
            legMovePct: 0,
            phaseLabel: "AGUARDANDO_DADOS"
        };
        salvarEstadoSwingsJSON();
    }
}

async function enviarAlertaTelegramSeAtivo(item) {
    if (!runtimeConfig.enableTelegramAlerts) return;
    const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const chatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
    if (!token || !chatId || typeof fetch !== "function") return;

    const sign = item.legMovePct >= 0 ? "+" : "";
    const text = `[XRPL TELEMETRY] ${item.kind} CONFIRMADO ($${Number(item.price).toFixed(4)}) | Perna: ${sign}${Number(item.legMovePct).toFixed(2)}% | Score: ${item.score}/${item.maxScore} | ${item.timeLabel}`;

    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text })
        });
    } catch (_) {
        // Falha silenciosa para não impactar o loop de telemetria
    }
}

app.use(express.static('public'));

function parseOffer(offer) {
    const qttXRP = parseFloat(xrpl.dropsToXrp(typeof offer.TakerGets === 'string' ? offer.TakerGets : offer.TakerPays));
    const objRLUSD = typeof offer.TakerGets === 'object' ? offer.TakerGets : offer.TakerPays;
    const valorRLUSD = parseFloat(objRLUSD.value);
    const precoUnitario = valorRLUSD / qttXRP;

    return { qttXRP, valorRLUSD, precoUnitario };
}

function calcularSlippage(offers, targetRLUSD, bestPrice, isBuy) {
    let rlusdRestante = targetRLUSD;
    let totalXRPObtido = 0;

    for (const offer of offers) {
        const parsed = parseOffer(offer);
        if (rlusdRestante <= 0) break;

        if (parsed.valorRLUSD <= rlusdRestante) {
            totalXRPObtido += parsed.qttXRP;
            rlusdRestante -= parsed.valorRLUSD;
        } else {
            const fracao = rlusdRestante / parsed.valorRLUSD;
            totalXRPObtido += parsed.qttXRP * fracao;
            rlusdRestante = 0;
        }
    }

    if (rlusdRestante > 0) {
        return { precoMedio: 0, slippagePercent: 0, semLiquidezSuficiente: true };
    }

    const precoMedio = targetRLUSD / totalXRPObtido;
    const slippagePercent = isBuy
        ? ((precoMedio - bestPrice) / bestPrice) * 100
        : ((bestPrice - precoMedio) / bestPrice) * 100;

    return { precoMedio, slippagePercent, semLiquidezSuficiente: false };
}

function processarTradeMeta(tx) {
    try {
        const meta = tx.meta || tx.metaData;
        if (!meta || meta.TransactionResult !== "tesSUCCESS") return null;

        const transactionData = tx.transaction || tx.tx_json || tx.tx || tx;
        if (transactionData.TransactionType !== "OfferCreate") return null;

        let side = null;
        let amountXRP = 0;
        let amountRLUSD = 0;

        if (typeof transactionData.TakerGets === 'string' && typeof transactionData.TakerPays === 'object') {
            if (transactionData.TakerPays.currency === config.CURRENCY_RLUSD) {
                side = 'SELL';
            }
        } else if (typeof transactionData.TakerPays === 'string' && typeof transactionData.TakerGets === 'object') {
            if (transactionData.TakerGets.currency === config.CURRENCY_RLUSD) {
                side = 'BUY';
            }
        }

        if (!side) return null;

        const affectedNodes = meta.AffectedNodes || [];
        for (const node of affectedNodes) {
            const nodeData = node.ModifiedNode || node.DeletedNode;
            if (nodeData && nodeData.LedgerEntryType === "Offer") {
                const previousFields = nodeData.PreviousFields;
                const finalFields = nodeData.FinalFields;

                if (previousFields && finalFields) {
                    let prevXRP = 0, finalXRP = 0;
                    let prevRLUSD = 0, finalRLUSD = 0;

                    if (typeof previousFields.TakerGets === 'string' && typeof previousFields.TakerPays === 'object') {
                        prevXRP = parseFloat(xrpl.dropsToXrp(previousFields.TakerGets));
                        finalXRP = finalFields.TakerGets ? parseFloat(xrpl.dropsToXrp(finalFields.TakerGets)) : 0;
                        prevRLUSD = parseFloat(previousFields.TakerPays.value);
                        finalRLUSD = finalFields.TakerPays ? parseFloat(finalFields.TakerPays.value) : 0;
                    } else if (typeof previousFields.TakerPays === 'string' && typeof previousFields.TakerGets === 'object') {
                        prevXRP = parseFloat(xrpl.dropsToXrp(previousFields.TakerPays));
                        finalXRP = finalFields.TakerPays ? parseFloat(finalFields.TakerPays.value) : 0;
                        prevRLUSD = parseFloat(previousFields.TakerGets.value);
                        finalRLUSD = finalFields.TakerGets ? parseFloat(finalFields.TakerGets.value) : 0;
                    }

                    const execXRP = Math.abs(prevXRP - finalXRP);
                    const execRLUSD = Math.abs(prevRLUSD - finalRLUSD);

                    if (execXRP > 0 && execRLUSD > 0) {
                        amountXRP += execXRP;
                        amountRLUSD += execRLUSD;
                    }
                }
            }
        }

        if (amountXRP === 0 && amountRLUSD === 0) {
            if (side === 'SELL') {
                amountXRP = parseFloat(xrpl.dropsToXrp(transactionData.TakerGets));
                amountRLUSD = parseFloat(transactionData.TakerPays.value);
            } else {
                amountXRP = parseFloat(xrpl.dropsToXrp(transactionData.TakerPays));
                amountRLUSD = parseFloat(transactionData.TakerGets.value);
            }
        }

        if (amountXRP > 0 && amountRLUSD > 0) {
            const price = amountRLUSD / amountXRP;
            const whaleMin = Math.max(Number(runtimeConfig.whaleThresholdRlusd || 5000), 50);
            const isWhale = amountRLUSD >= whaleMin;

            const deltaRLUSD = side === 'BUY' ? amountRLUSD : -amountRLUSD;
            cvdRLUSD += deltaRLUSD;
            tradeEventsWindow.push({ ts: Date.now(), deltaRLUSD });

            totalVolumeRLUSDAcumulado += amountRLUSD;
            totalVolumeXRPAcumulado += amountXRP;
            if (totalVolumeXRPAcumulado > 0) {
                vwapAtual = totalVolumeRLUSDAcumulado / totalVolumeXRPAcumulado;
            }

            const rawDateSec = Number(transactionData.date ?? tx.date);
            const timestamp = Number.isFinite(rawDateSec) && rawDateSec > 0
                ? new Date((rawDateSec + 946684800) * 1000).toLocaleTimeString('pt-BR')
                : (tx.close_time_iso
                    ? new Date(tx.close_time_iso).toLocaleTimeString('pt-BR')
                    : new Date().toLocaleTimeString('pt-BR'));

            return {
                timestamp,
                side,
                price,
                amountXRP,
                amountRLUSD,
                isWhale,
                cvdRLUSD,
                vwap: vwapAtual,
                hash: transactionData.hash || tx.hash
            };
        }
    } catch (e) {
        console.error("[ERRO PARSING TRADE]", e.message);
    }
    return null;
}

async function carregarHistoricoExecucoes() {
    console.log("[INICIALIZANDO] Carregando histórico de transações da XRPL...");
    try {
        const response = await engine.client.request({
            command: "account_tx",
            account: config.RLUSD_ISSUER,
            limit: 60
        });

        const transactions = response.result.transactions || [];
        console.log(`[HISTÓRICO] ${transactions.length} transações recuperadas do emissor RLUSD.`);

        const sortedTx = transactions.reverse();

        for (const txData of sortedTx) {
            const trade = processarTradeMeta(txData);
            if (trade) {
                tradeHistory.unshift(trade);
                if (tradeHistory.length > 15) {
                    tradeHistory.pop();
                }
            }
        }

        console.log(`[HISTÓRICO CONCLUÍDO] ${tradeHistory.length} trades processados. CVD Inicial: $${cvdRLUSD.toFixed(2)} | VWAP Inicial: $${vwapAtual.toFixed(4)}`);
    } catch (err) {
        console.error("[FALHA NO CARREGAMENTO HISTÓRICO]", err.message);
    }
}

function calcularOBI(bids, asks, maxLevels = null, decayLambda = 0) {
    const bidSlice = maxLevels ? bids.slice(0, maxLevels) : bids;
    const askSlice = maxLevels ? asks.slice(0, maxLevels) : asks;

    let weightedBid = 0;
    let weightedAsk = 0;

    bidSlice.forEach((offer, idx) => {
        const parsed = parseOffer(offer);
        const weight = decayLambda > 0 ? Math.exp(-decayLambda * idx) : 1;
        weightedBid += parsed.valorRLUSD * weight;
    });

    askSlice.forEach((offer, idx) => {
        const parsed = parseOffer(offer);
        const weight = decayLambda > 0 ? Math.exp(-decayLambda * idx) : 1;
        weightedAsk += parsed.valorRLUSD * weight;
    });

    const total = weightedBid + weightedAsk;
    const buyPercent = total > 0 ? (weightedBid / total) * 100 : 50;
    const sellPercent = total > 0 ? (weightedAsk / total) * 100 : 50;

    return { buyPercent, sellPercent, weightedBid, weightedAsk };
}

function registrarFluxoLedger(tx) {
    const now = Date.now();
    const txData = tx.transaction || tx.tx_json || tx.tx || tx;
    const txType = txData.TransactionType;

    if (!txType) return;

    if (txType === "OfferCreate") {
        ledgerFlowEvents.push({ ts: now, type: "OFFER_CREATE" });
    } else if (txType === "OfferCancel") {
        ledgerFlowEvents.push({ ts: now, type: "OFFER_CANCEL" });
    } else if (
        txType === "AMMDeposit" ||
        txType === "AMMWithdraw" ||
        txType === "AMMCreate" ||
        txType === "AMMVote" ||
        txType === "AMMBid"
    ) {
        ledgerFlowEvents.push({ ts: now, type: "AMM_TX" });
    }

    ledgerFlowEvents = ledgerFlowEvents.filter(ev => now - ev.ts <= WINDOW_300S_MS);
}

function resumirFluxoLedger() {
    const now = Date.now();
    ledgerFlowEvents = ledgerFlowEvents.filter(ev => now - ev.ts <= WINDOW_300S_MS);
    const events60s = ledgerFlowEvents.filter(ev => now - ev.ts <= WINDOW_60S_MS);

    let offerCreateCount = 0;
    let offerCancelCount = 0;
    let ammTxCount = 0;

    for (const ev of events60s) {
        if (ev.type === "OFFER_CREATE") offerCreateCount++;
        else if (ev.type === "OFFER_CANCEL") offerCancelCount++;
        else if (ev.type === "AMM_TX") ammTxCount++;
    }

    const totalOffers = offerCreateCount + offerCancelCount;
    const offerCancelRatio = totalOffers > 0 ? (offerCancelCount / totalOffers) * 100 : 0;

    return {
        offerCreateCount,
        offerCancelCount,
        offerCancelRatio,
        ammTxCount
    };
}

function avaliarCvdEAbsorcao(midPrice) {
    const now = Date.now();
    tradeEventsWindow = tradeEventsWindow.filter(ev => now - ev.ts <= WINDOW_300S_MS);
    midPriceHistory.push({ ts: now, price: midPrice });
    midPriceHistory = midPriceHistory.filter(pt => now - pt.ts <= WINDOW_300S_MS);

    let cvd60s = 0;
    let cvd300s = 0;
    let buyVol60s = 0;
    let sellVol60s = 0;

    for (const ev of tradeEventsWindow) {
        cvd300s += ev.deltaRLUSD;
        if (now - ev.ts <= WINDOW_60S_MS) {
            cvd60s += ev.deltaRLUSD;
            if (ev.deltaRLUSD > 0) buyVol60s += ev.deltaRLUSD;
            else sellVol60s += Math.abs(ev.deltaRLUSD);
        }
    }

    const totalVol60s = buyVol60s + sellVol60s;
    const vpinProxy60s = totalVol60s > 0 ? (Math.abs(buyVol60s - sellVol60s) / totalVol60s) * 100 : 0;

    const price60sAgoObj = midPriceHistory.find(pt => now - pt.ts <= WINDOW_60S_MS) || midPriceHistory[0];
    const priceDelta60s = price60sAgoObj ? ((midPrice - price60sAgoObj.price) / price60sAgoObj.price) * 100 : 0;

    let signalAbsorptionDivergence = "NEUTRAL";
    if (cvd60s > 500 && priceDelta60s <= 0.02) {
        signalAbsorptionDivergence = "BULLISH_ABSORPTION";
    } else if (cvd60s < -500 && priceDelta60s >= -0.02) {
        signalAbsorptionDivergence = "BEARISH_ABSORPTION";
    } else if (priceDelta60s > 0.15 && cvd60s < -250) {
        signalAbsorptionDivergence = "BEARISH_DIVERGENCE";
    } else if (priceDelta60s < -0.15 && cvd60s > 250) {
        signalAbsorptionDivergence = "BULLISH_DIVERGENCE";
    }

    return {
        cvd60s,
        cvd300s,
        vpinProxy60s,
        priceDelta60s,
        signalAbsorptionDivergence
    };
}

let externalRefCache = { price: null, source: null, updatedAtMs: 0 };

async function obterReferenciaExternaXRP(localMidPrice) {
    const now = Date.now();
    if (externalRefCache.price && now - externalRefCache.updatedAtMs < 10000) {
        return calcularConfluencia(localMidPrice, externalRefCache);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    try {
        const res = await fetch("https://api.coinbase.com/v2/prices/XRP-USD/spot", {
            signal: controller.signal
        });
        if (res.ok) {
            const json = await res.json();
            const spot = parseFloat(json?.data?.amount);
            if (Number.isFinite(spot) && spot > 0) {
                externalRefCache = { price: spot, source: "Coinbase XRP-USD", updatedAtMs: now };
            }
        }
    } catch (_) {
        // Falha silenciosa para não bloquear a telemetria XRPL
    } finally {
        clearTimeout(timer);
    }

    return calcularConfluencia(localMidPrice, externalRefCache);
}

function calcularConfluencia(localMidPrice, ref) {
    if (!ref.price || !localMidPrice) {
        return {
            price: null,
            source: null,
            diffPercent: null,
            status: "NO_REF"
        };
    }
    const diffPercent = ((localMidPrice - ref.price) / ref.price) * 100;
    let status = "ALIGNED";
    if (diffPercent > 0.4) status = "LOCAL_PREMIUM";
    else if (diffPercent < -0.4) status = "LOCAL_DISCOUNT";

    return {
        price: ref.price,
        source: ref.source,
        diffPercent,
        status
    };
}

const CANDLE_5M_BUCKET_MS = 5 * 60 * 1000;

let exhaustionStreak = { side: null, count: 0 };

function avaliarRadarExaustaoCorredor({
    midPrice,
    microprice,
    obiTop5,
    obiDecay,
    cvd60s,
    priceDelta60s,
    signalAbsorptionDivergence,
    ledgerFlow,
    slippageVenda,
    candleContext,
    timestampMs = Date.now()
}) {
    syncUtcCycle(new Date(timestampMs));

    const srVol = candleContext?.srVol || {
        atr5mPct: 0.25,
        volatilityRegime: "NORMAL",
        confirmMultiplier: 1.0,
        nearestLevel: null,
        nearResistance: false,
        nearSupport: false
    };
    const minLegPct = Number(runtimeConfig.minSwingLegPct || 0.90);
    const baseConfirmPct = Number(runtimeConfig.reversalConfirmPct || 0.35);
    const confirmPct = Number((baseConfirmPct * (srVol.confirmMultiplier || 1.0)).toFixed(4));
    const minCandles5m = Number(runtimeConfig.minCandles5mBetweenPivots || 2);
    const ofiBuyMinPct = runtimeConfig.ofiThreshold > 1
        ? runtimeConfig.ofiThreshold
        : runtimeConfig.ofiThreshold * 100;

    if (pivotState.candidateHigh === null || pivotState.candidateLow === null) {
        pivotState.candidateHigh = midPrice;
        pivotState.candidateLow = midPrice;
        if (pivotState.lastPivotPrice === null) {
            pivotState.lastPivotPrice = midPrice;
        }
    }

    const c1 = candleContext?.c1m || null;
    const c5 = candleContext?.c5m || null;
    const h5 = candleContext?.history?.m5 || null;
    const current5mStartMs = c5?.startMs || (Math.floor(timestampMs / CANDLE_5M_BUCKET_MS) * CANDLE_5M_BUCKET_MS);
    const candles5mElapsed = pivotState.lastPivotCandle5mStartMs !== null
        ? Math.floor((current5mStartMs - pivotState.lastPivotCandle5mStartMs) / CANDLE_5M_BUCKET_MS)
        : minCandles5m;
    const hasMinCandleSpacing = candles5mElapsed >= minCandles5m;

    const breakoutBufferPct = 0.03;
    let extendingLeg = null;

    if (pivotState.seeking === "BOTTOM" && pivotState.lastPivotPrice && pivotState.lastPivotPrice > 0) {
        const brokeAboveTop = midPrice > pivotState.lastPivotPrice * (1 + breakoutBufferPct / 100);
        if (brokeAboveTop) {
            const prevBottomSwing = dailySwings.find(s => s.kind === "FUNDO");
            if (prevBottomSwing && Number(prevBottomSwing.price) > 0) {
                pivotState.lastPivotKind = "FUNDO";
                pivotState.lastPivotPrice = Number(prevBottomSwing.price);
            }
            pivotState.candidateHigh = Math.max(pivotState.candidateHigh || midPrice, midPrice);
            pivotState.lastPivotCandle5mStartMs = current5mStartMs;
            pivotState.seeking = "TOP";
            extendingLeg = "TOP";
        }
    } else if (pivotState.seeking === "TOP" && pivotState.lastPivotPrice && pivotState.lastPivotPrice > 0) {
        const brokeBelowBottom = midPrice < pivotState.lastPivotPrice * (1 - breakoutBufferPct / 100);
        if (brokeBelowBottom) {
            const prevTopSwing = dailySwings.find(s => s.kind === "TOPO");
            if (prevTopSwing && Number(prevTopSwing.price) > 0) {
                pivotState.lastPivotKind = "TOPO";
                pivotState.lastPivotPrice = Number(prevTopSwing.price);
            }
            pivotState.candidateLow = Math.min(pivotState.candidateLow || midPrice, midPrice);
            pivotState.lastPivotCandle5mStartMs = current5mStartMs;
            pivotState.seeking = "BOTTOM";
            extendingLeg = "BOTTOM";
        }
    }

    if (midPrice > pivotState.candidateHigh) {
        pivotState.candidateHigh = midPrice;
    }
    if (midPrice < pivotState.candidateLow) {
        pivotState.candidateLow = midPrice;
    }

    const baseRefPrice = pivotState.lastPivotPrice || midPrice;
    const moveFromLastPivotPct = baseRefPrice > 0 ? ((midPrice - baseRefPrice) / baseRefPrice) * 100 : 0;

    const candidateGainFromBottomPct = baseRefPrice > 0
        ? ((pivotState.candidateHigh - baseRefPrice) / baseRefPrice) * 100
        : 0;
    const candidateDropFromTopPct = baseRefPrice > 0
        ? ((pivotState.candidateLow - baseRefPrice) / baseRefPrice) * 100
        : 0;

    const pullbackFromHighPct = pivotState.candidateHigh > 0
        ? ((midPrice - pivotState.candidateHigh) / pivotState.candidateHigh) * 100
        : 0;
    const bounceFromLowPct = pivotState.candidateLow > 0
        ? ((midPrice - pivotState.candidateLow) / pivotState.candidateLow) * 100
        : 0;

    const top5Buy = obiTop5 ? obiTop5.buyPercent : 50;
    const decayBuy = obiDecay ? obiDecay.buyPercent : 50;
    const cancelRatio = ledgerFlow ? (ledgerFlow.offerCancelRatio || 0) : 0;

    const canEvaluateTop = pivotState.seeking !== "BOTTOM" &&
        hasMinCandleSpacing &&
        candidateGainFromBottomPct >= minLegPct &&
        pullbackFromHighPct <= -confirmPct;

    const sellExhaustionChecks = [
        canEvaluateTop,
        microprice < midPrice || (c1 && c1.isBearish),
        top5Buy < (100 - Math.min(ofiBuyMinPct, 60)) || decayBuy < 48,
        signalAbsorptionDivergence === "BEARISH_DIVERGENCE" ||
        signalAbsorptionDivergence === "BEARISH_ABSORPTION" ||
        cvd60s < -150 ||
        priceDelta60s < 0,
        (c1 && c1.positionInRangePct <= 45) ||
        (h5 && h5.historyPositionPct >= 75) ||
        (c5 && c5.isBearish) ||
        Boolean(srVol.nearResistance),
        cancelRatio > 35 ||
        (slippageVenda && !slippageVenda.semLiquidezSuficiente && slippageVenda.slippagePercent > 0.25)
    ];

    const canEvaluateBottom = pivotState.seeking !== "TOP" &&
        hasMinCandleSpacing &&
        candidateDropFromTopPct <= -minLegPct &&
        bounceFromLowPct >= confirmPct;

    const candleBias = candleContext?.candleBias || "NEUTRAL";
    const sellContextBonus = candleBias === "TOP_EXHAUSTION_CONTEXT" ? 1 : 0;
    const buyContextBonus = candleBias === "BOTTOM_EXHAUSTION_CONTEXT" ? 1 : 0;

    const buyExhaustionChecks = [
        canEvaluateBottom,
        microprice > midPrice || (c1 && c1.isBullish),
        top5Buy > Math.max(ofiBuyMinPct, 55) || decayBuy > 52,
        signalAbsorptionDivergence === "BULLISH_DIVERGENCE" ||
        signalAbsorptionDivergence === "BULLISH_ABSORPTION" ||
        cvd60s > 150 ||
        priceDelta60s > 0,
        (c1 && c1.positionInRangePct >= 55) ||
        (h5 && h5.historyPositionPct <= 25) ||
        (c5 && c5.isBullish) ||
        Boolean(srVol.nearSupport),
        cancelRatio > 35 || (ledgerFlow && (ledgerFlow.ammTxCount || 0) > 0)
    ];
    const sellScore = canEvaluateTop
        ? Math.min(sellExhaustionChecks.filter(Boolean).length + sellContextBonus, 6)
        : 0;
    const buyScore = canEvaluateBottom
        ? Math.min(buyExhaustionChecks.filter(Boolean).length + buyContextBonus, 6)
        : 0;

    let rawCandidate = "NEUTRAL";
    let score = 0;

    if (sellScore >= 4 && sellScore > buyScore) {
        rawCandidate = "SELL_REVERSAL_EXHAUSTION";
        score = sellScore;
    } else if (buyScore >= 4 && buyScore > sellScore) {
        rawCandidate = "BUY_REVERSAL_EXHAUSTION";
        score = buyScore;
    }
    const emaBiasAllows = !runtimeConfig.emaTrendFilter ||
        (rawCandidate === "SELL_REVERSAL_EXHAUSTION" && candleBias === "TOP_EXHAUSTION_CONTEXT") ||
        (rawCandidate === "BUY_REVERSAL_EXHAUSTION" && candleBias === "BOTTOM_EXHAUSTION_CONTEXT");

    if (rawCandidate !== "NEUTRAL" && !emaBiasAllows) {
        rawCandidate = "NEUTRAL";
        score = 0;
    }

    if (rawCandidate === "NEUTRAL") {
        exhaustionStreak = { side: null, count: 0 };
    } else if (exhaustionStreak.side === rawCandidate) {
        exhaustionStreak.count += 1;
    } else {
        exhaustionStreak = { side: rawCandidate, count: 1 };
    }

    const confirmed = rawCandidate !== "NEUTRAL" && exhaustionStreak.count >= 2;
    let recordedSwing = null;

    const latestSwing = dailySwings[0] || null;
    const isSameOrDuplicate = (kind, priceVal, legPctVal) => {
        if (!latestSwing) return { skip: false, replaceIndex: -1 };
        const priceDiffPct = latestSwing.price > 0
            ? Math.abs((priceVal - latestSwing.price) / latestSwing.price) * 100
            : 0;
        const legDiffPct = Math.abs(Number(legPctVal) - Number(latestSwing.legMovePct));
        const isDup = priceDiffPct < 0.08 && legDiffPct < 0.05;

        if (latestSwing.kind === kind) {
            if (isDup) return { skip: true, replaceIndex: -1 };
            const secondSwing = dailySwings[1] || null;
            if (!secondSwing || secondSwing.kind !== kind) {
                return { skip: false, replaceIndex: 0 };
            }
            return { skip: true, replaceIndex: -1 };
        }
        if (isDup) return { skip: true, replaceIndex: -1 };
        return { skip: false, replaceIndex: -1 };
    };

    if (confirmed && rawCandidate === "SELL_REVERSAL_EXHAUSTION") {
        const topPrice = pivotState.candidateHigh;
        const legGainPct = pivotState.lastPivotKind === "FUNDO" && pivotState.lastPivotPrice > 0
            ? ((topPrice - pivotState.lastPivotPrice) / pivotState.lastPivotPrice) * 100
            : candidateGainFromBottomPct;

        const decision = isSameOrDuplicate("TOPO", topPrice, legGainPct);
        if (!decision.skip) {
            recordedSwing = {
                timeLabel: formatUtcAndBrtTime(new Date(timestampMs)),
                kind: "TOPO",
                price: Number(topPrice),
                score,
                maxScore: 6,
                legMovePct: Number(legGainPct)
            };
            if (decision.replaceIndex === 0) {
                dailySwings[0] = recordedSwing;
            } else {
                dailySwings.unshift(recordedSwing);
                if (dailySwings.length > 50) dailySwings.pop();
            }
            salvarEstadoSwingsJSON();
            enviarAlertaTelegramSeAtivo(recordedSwing);
        }

        pivotState.lastPivotKind = "TOPO";
        pivotState.lastPivotPrice = topPrice;
        pivotState.lastPivotCandle5mStartMs = current5mStartMs;
        pivotState.candidateLow = midPrice;
        pivotState.candidateHigh = midPrice;
        pivotState.seeking = "BOTTOM";
        exhaustionStreak = { side: null, count: 0 };
    } else if (confirmed && rawCandidate === "BUY_REVERSAL_EXHAUSTION") {
        const bottomPrice = pivotState.candidateLow;
        const legDropPct = pivotState.lastPivotKind === "TOPO" && pivotState.lastPivotPrice > 0
            ? ((bottomPrice - pivotState.lastPivotPrice) / pivotState.lastPivotPrice) * 100
            : candidateDropFromTopPct;

        const decision = isSameOrDuplicate("FUNDO", bottomPrice, legDropPct);
        if (!decision.skip) {
            recordedSwing = {
                timeLabel: formatUtcAndBrtTime(new Date(timestampMs)),
                kind: "FUNDO",
                price: Number(bottomPrice),
                score,
                maxScore: 6,
                legMovePct: Number(legDropPct)
            };
            if (decision.replaceIndex === 0) {
                dailySwings[0] = recordedSwing;
            } else {
                dailySwings.unshift(recordedSwing);
                if (dailySwings.length > 50) dailySwings.pop();
            }
            salvarEstadoSwingsJSON();
            enviarAlertaTelegramSeAtivo(recordedSwing);
        }

        pivotState.lastPivotKind = "FUNDO";
        pivotState.lastPivotPrice = bottomPrice;
        pivotState.lastPivotCandle5mStartMs = current5mStartMs;
        pivotState.candidateHigh = midPrice;
        pivotState.candidateLow = midPrice;
        pivotState.seeking = "TOP";
        exhaustionStreak = { side: null, count: 0 };
    }

    const activeLegMovePct = pivotState.lastPivotPrice && pivotState.lastPivotPrice > 0
        ? ((midPrice - pivotState.lastPivotPrice) / pivotState.lastPivotPrice) * 100
        : 0;
    pivotState.legMovePct = activeLegMovePct;

    let phaseLabel = "EM_OBSERVACAO";
    if (pivotState.seeking === "TOP") {
        phaseLabel = candidateGainFromBottomPct >= minLegPct
            ? "ALVO_ALTA_ATINGIDO_AGUARDANDO_TOPO"
            : `SUBINDO_DESDE_FUNDO (${candidateGainFromBottomPct.toFixed(2)}% / ${minLegPct.toFixed(2)}%)`;
    } else if (pivotState.seeking === "BOTTOM") {
        phaseLabel = Math.abs(candidateDropFromTopPct) >= minLegPct
            ? "ALVO_QUEDA_ATINGIDO_AGUARDANDO_FUNDO"
            : `CAINDO_DESDE_TOPO (${candidateDropFromTopPct.toFixed(2)}% / -${minLegPct.toFixed(2)}%)`;
    } else {
        phaseLabel = "MAPEANDO_PRIMEIRO_PIVOT";
    }
    pivotState.phaseLabel = phaseLabel;

    return {
        legAnchorPrice: pivotState.lastPivotPrice,
        legAnchorSide: pivotState.lastPivotKind,
        legMovePct: activeLegMovePct,
        moveFromLastPivotPct,
        trailingHigh: pivotState.candidateHigh,
        trailingLow: pivotState.candidateLow,
        pullbackFromHighPct,
        bounceFromLowPct,
        seekingPivot: pivotState.seeking,
        lastPivotKind: pivotState.lastPivotKind,
        extendingLeg,
        effectiveConfirmPct: confirmPct,
        trailingStopPrice: pivotState.seeking === "TOP"
            ? Number((pivotState.candidateHigh * (1 - confirmPct / 100)).toFixed(5))
            : (pivotState.seeking === "BOTTOM"
                ? Number((pivotState.candidateLow * (1 + confirmPct / 100)).toFixed(5))
                : null),
        phaseLabel: extendingLeg
            ? `ESTENDENDO_${extendingLeg}_LEG (${phaseLabel})`
            : phaseLabel,
        candles5mElapsed,
        signal: rawCandidate,
        confirmed,
        confirmations: exhaustionStreak.count,
        score,
        maxScore: 6,
        recordedSwing,
        dailySwings,
        utcDayKey: currentUtcDayKey,
        runtimeConfig
    };
}

function syncDayRange(price, timestampMs = Date.now()) {
    const dayKey = getUtcDayKey(new Date(timestampMs));
    if (dayRangeState.dayKey !== dayKey || dayRangeState.high === null || dayRangeState.low === null) {
        dayRangeState = {
            dayKey,
            high: price,
            low: price,
            open: price
        };
        return dayRangeState;
    }
    if (price > dayRangeState.high) dayRangeState.high = price;
    if (price < dayRangeState.low) dayRangeState.low = price;
    return dayRangeState;
}

function atualizarCandlesAgregados(price, timestampMs = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) {
        return { candle1m: null, candle5m: null, candle15m: null, candle1h: null, dayRange: null };
    }

    const upsertCandle = (arr, bucketMs) => {
        const bucketStart = Math.floor(timestampMs / bucketMs) * bucketMs;
        const last = arr[arr.length - 1];

        if (!last || last.startMs !== bucketStart) {
            const novo = {
                startMs: bucketStart,
                open: price,
                high: price,
                low: price,
                close: price,
                ticks: 1
            };
            arr.push(novo);
            if (arr.length > MAX_CANDLES_STORED) {
                arr.shift();
            }
            return novo;
        }

        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.ticks += 1;
        return last;
    };

    const c1m = upsertCandle(candles1m, CANDLE_1M_MS);
    const c5m = upsertCandle(candles5m, CANDLE_5M_MS);
    const c15m = upsertCandle(candles15m, CANDLE_15M_MS);
    const c1h = upsertCandle(candles1h, CANDLE_1H_MS);
    const dayRange = syncDayRange(price, timestampMs);

    return { candle1m: c1m, candle5m: c5m, candle15m: c15m, candle1h: c1h, dayRange };
}

function calcularVolatilidadeESuporteResistencia(currentPrice, s5, s15, vwapVal) {
    const closed5m = candles5m.slice(0, -1).slice(-12);
    let atrSumPct = 0;
    let atrCount = 0;
    for (const c of closed5m) {
        if (c && c.low > 0 && c.high >= c.low) {
            atrSumPct += ((c.high - c.low) / c.low) * 100;
            atrCount += 1;
        }
    }
    const atr5mPct = atrCount > 0 ? atrSumPct / atrCount : 0.25;

    let volatilityRegime = "NORMAL";
    let confirmMultiplier = 1.0;
    if (atr5mPct < 0.16) {
        volatilityRegime = "CALMO";
        confirmMultiplier = 0.85;
    } else if (atr5mPct > 0.45) {
        volatilityRegime = "TENSO";
        confirmMultiplier = 1.35;
    }

    const levels = [];
    if (s5 && Number.isFinite(s5.historyHigh)) levels.push({ label: "5m_HIGH", price: s5.historyHigh, weight: 1 });
    if (s5 && Number.isFinite(s5.historyLow)) levels.push({ label: "5m_LOW", price: s5.historyLow, weight: 1 });
    if (s15 && Number.isFinite(s15.historyHigh)) levels.push({ label: "15m_HIGH", price: s15.historyHigh, weight: 1.2 });
    if (s15 && Number.isFinite(s15.historyLow)) levels.push({ label: "15m_LOW", price: s15.historyLow, weight: 1.2 });

    const closed1h = candles1h.slice(0, -1).slice(-12);
    if (closed1h.length > 0) {
        const h1High = Math.max(...closed1h.map(c => c.high));
        const h1Low = Math.min(...closed1h.map(c => c.low));
        if (Number.isFinite(h1High)) levels.push({ label: "1H_RES", price: h1High, weight: 1.6 });
        if (Number.isFinite(h1Low)) levels.push({ label: "1H_SUP", price: h1Low, weight: 1.6 });
    }

    if (dayRangeState && Number.isFinite(dayRangeState.high)) {
        levels.push({ label: "D_RES_24H", price: dayRangeState.high, weight: 2.0 });
    }
    if (dayRangeState && Number.isFinite(dayRangeState.low)) {
        levels.push({ label: "D_SUP_24H", price: dayRangeState.low, weight: 2.0 });
    }
    if (Number.isFinite(vwapVal) && vwapVal > 0) {
        levels.push({ label: "VWAP", price: vwapVal, weight: 1.3 });
    }

    let nearestLevel = null;
    let minDistPct = Infinity;
    for (const lvl of levels) {
        if (!lvl.price || lvl.price <= 0 || !currentPrice) continue;
        const distPct = (Math.abs(currentPrice - lvl.price) / currentPrice) * 100;
        if (distPct < minDistPct) {
            minDistPct = distPct;
            nearestLevel = { ...lvl, distPct };
        }
    }

    const nearResistance = nearestLevel &&
        (nearestLevel.label.includes("HIGH") || nearestLevel.label.includes("RES")) &&
        nearestLevel.distPct <= 0.22;

    const nearSupport = nearestLevel &&
        (nearestLevel.label.includes("LOW") || nearestLevel.label.includes("SUP")) &&
        nearestLevel.distPct <= 0.22;

    return {
        atr5mPct,
        volatilityRegime,
        confirmMultiplier,
        nearestLevel,
        nearResistance,
        nearSupport
    };
}

function resumirSerieHistorica(series, currentPrice, lookbackCount = 10) {
    if (!Array.isArray(series) || series.length === 0) {
        return {
            current: null,
            closedCount: 0,
            historyHigh: null,
            historyLow: null,
            historyRangePct: 0,
            historyPositionPct: 50,
            regime: "SIDEWAYS_RANGE"
        };
    }

    const current = series[series.length - 1];
    const closed = series.slice(0, -1).slice(-lookbackCount);
    const referenceCandles = closed.length > 0 ? closed : [current];

    let historyHigh = -Infinity;
    let historyLow = Infinity;
    for (const c of referenceCandles) {
        if (c.high > historyHigh) historyHigh = c.high;
        if (c.low < historyLow) historyLow = c.low;
    }

    const rangeSpan = historyHigh - historyLow;
    const historyRangePct = historyLow > 0 ? (rangeSpan / historyLow) * 100 : 0;
    const historyPositionPct = rangeSpan > 0
        ? Math.max(0, Math.min(100, ((currentPrice - historyLow) / rangeSpan) * 100))
        : 50;

    const firstRef = referenceCandles[0];
    const netChangePct = (firstRef && firstRef.open > 0)
        ? ((currentPrice - firstRef.open) / firstRef.open) * 100
        : 0;

    let regime = "SIDEWAYS_RANGE";
    if (historyRangePct <= 0.35 && Math.abs(netChangePct) <= 0.25) {
        regime = "SIDEWAYS_RANGE";
    } else if (netChangePct > 0.25 && historyPositionPct >= 60) {
        regime = "TREND_UP";
    } else if (netChangePct < -0.25 && historyPositionPct <= 40) {
        regime = "TREND_DOWN";
    } else if (historyPositionPct >= 75 || historyPositionPct <= 25) {
        regime = "TRANSITION_EXHAUSTION";
    }

    const calcCandleMetrics = (c) => {
        if (!c || c.high === c.low) {
            return { positionInRangePct: 50, bodyChangePct: 0, isBearish: false, isBullish: false };
        }
        const positionInRangePct = ((currentPrice - c.low) / (c.high - c.low)) * 100;
        const bodyChangePct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
        return {
            positionInRangePct,
            bodyChangePct,
            isBearish: c.close < c.open,
            isBullish: c.close > c.open
        };
    };

    return {
        current: current ? { ...current, ...calcCandleMetrics(current) } : null,
        closedCount: closed.length,
        historyHigh,
        historyLow,
        historyRangePct,
        historyPositionPct,
        regime
    };
}

function avaliarContextoCandles(currentPrice, c1m, c5m, c15m) {
    const s1 = resumirSerieHistorica(candles1m, currentPrice, 10);
    const s5 = resumirSerieHistorica(candles5m, currentPrice, 10);
    const s15 = resumirSerieHistorica(candles15m, currentPrice, 10);

    const m1 = s1.current || { positionInRangePct: 50, bodyChangePct: 0, isBearish: false, isBullish: false };

    let candleBias = "NEUTRAL";
    if (
        (s5.historyPositionPct >= 75 || s15.historyPositionPct >= 75) &&
        (m1.isBearish || m1.bodyChangePct < 0)
    ) {
        candleBias = "TOP_EXHAUSTION_CONTEXT";
    } else if (
        (s5.historyPositionPct <= 25 || s15.historyPositionPct <= 25) &&
        (m1.isBullish || m1.bodyChangePct > 0)
    ) {
        candleBias = "BOTTOM_EXHAUSTION_CONTEXT";
    }

    const marketRegime = s5.closedCount >= 2 ? s5.regime : s1.regime;
    const srVol = calcularVolatilidadeESuporteResistencia(currentPrice, s5, s15, vwapAtual);

    const s1h = resumirSerieHistorica(candles1h, currentPrice, 12);

    return {
        c1m: s1.current,
        c5m: s5.current,
        c15m: s15.current,
        c1h: s1h.current,
        history: {
            m1: s1,
            m5: s5,
            m15: s15,
            h1: s1h
        },
        series: {
            m1: candles1m.slice(-30),
            m5: candles5m.slice(-30),
            m15: candles15m.slice(-30),
            h1: candles1h.slice(-24)
        },
        dayRange: dayRangeState,
        srVol,
        marketRegime,
        candleBias
    };
}

async function coletarDadosTelemetry(force = false) {
    try {
        if (!engine.client || !engine.client.isConnected()) {
            return null;
        }

        const now = Date.now();
        const minIntervalMs = Math.max(Number(runtimeConfig.pollingIntervalMs || 3000), 1500);
        if (!force && now - lastTelemetryRunMs < minIntervalMs) {
            return null;
        }
        lastTelemetryRunMs = now;

        const [asksResponse, bidsResponse] = await Promise.all([
            engine.client.request({
                command: "book_offers",
                taker_gets: { currency: config.CURRENCY_XRP },
                taker_pays: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                limit: 20
            }),
            engine.client.request({
                command: "book_offers",
                taker_gets: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                taker_pays: { currency: config.CURRENCY_XRP },
                limit: 20
            })
        ]);

        const asks = asksResponse.result.offers || [];
        const bids = bidsResponse.result.offers || [];

        if (asks.length === 0 || bids.length === 0) return null;

        const bestAsk = parseOffer(asks[0]);
        const bestBid = parseOffer(bids[0]);

        const midPrice = (bestAsk.precoUnitario + bestBid.precoUnitario) / 2;
        const spreadNominal = bestAsk.precoUnitario - bestBid.precoUnitario;
        const spreadPercentual = (spreadNominal / bestAsk.precoUnitario) * 100;

        const totalTop1Vol = bestBid.qttXRP + bestAsk.qttXRP;
        const microprice = totalTop1Vol > 0
            ? ((bestAsk.precoUnitario * bestBid.qttXRP) + (bestBid.precoUnitario * bestAsk.qttXRP)) / totalTop1Vol
            : midPrice;

        let profundidadeAskXRP = 0;
        let profundidadeAskRLUSD = 0;
        asks.slice(0, 10).forEach(offer => {
            const parsed = parseOffer(offer);
            profundidadeAskXRP += parsed.qttXRP;
            profundidadeAskRLUSD += parsed.valorRLUSD;
        });

        let profundidadeBidXRP = 0;
        let profundidadeBidRLUSD = 0;
        bids.slice(0, 10).forEach(offer => {
            const parsed = parseOffer(offer);
            profundidadeBidXRP += parsed.qttXRP;
            profundidadeBidRLUSD += parsed.valorRLUSD;
        });

        const obiTop5 = calcularOBI(bids, asks, 5, 0);
        const obiTop10 = calcularOBI(bids, asks, 10, 0);
        const obiTop20 = calcularOBI(bids, asks, 20, 0);
        const obiDecay = calcularOBI(bids, asks, 20, OBI_DECAY_LAMBDA);

        const slipAmount = Math.max(Number(runtimeConfig.slippageAmountRlusd || 1000), 10);
        const simulaCompra = calcularSlippage(asks, slipAmount, bestAsk.precoUnitario, true);
        const simulaVenda = calcularSlippage(bids, slipAmount, bestBid.precoUnitario, false);

        const stabilizedMid = calcularMidEstabilizado(midPrice);
        const fluxoCvd = avaliarCvdEAbsorcao(stabilizedMid);
        const fluxoLedger = resumirFluxoLedger();

        const { candle1m, candle5m, candle15m, candle1h, dayRange } = atualizarCandlesAgregados(stabilizedMid, now);
        const candleContext = avaliarContextoCandles(stabilizedMid, candle1m, candle5m, candle15m, candle1h, dayRange);
        const externalConfluence = await obterReferenciaExternaXRP(midPrice);

        const exhaustionRadar = avaliarRadarExaustaoCorredor({
            midPrice: stabilizedMid,
            microprice,
            obiTop5,
            obiDecay,
            cvd60s: fluxoCvd.cvd60s,
            priceDelta60s: fluxoCvd.priceDelta60s,
            signalAbsorptionDivergence: fluxoCvd.signalAbsorptionDivergence,
            ledgerFlow: fluxoLedger,
            slippageVenda: simulaVenda,
            candleContext,
            timestampMs: now
        });

        // Bônus de candleBias já incorporado dentro de avaliarRadarExaustaoCorredor antes da persistência

        const timeSec = Math.floor(now / 1000);
        const lastTick = tickHistory[tickHistory.length - 1];
        const safeTimeSec = lastTick && timeSec <= lastTick.timeSec ? lastTick.timeSec + 1 : timeSec;
        tickHistory.push({
            timeSec: safeTimeSec,
            midPrice: stabilizedMid,
            vwap: vwapAtual > 0 ? vwapAtual : null
        });
        if (tickHistory.length > MAX_TICK_HISTORY) {
            tickHistory.shift();
        }

        salvarEstadoTelemetriaJSON(false);

        return {
            timestamp: new Date().toLocaleTimeString('pt-BR'),
            bestAsk: bestAsk.precoUnitario,
            bestBid: bestBid.precoUnitario,
            midPrice,
            microprice,
            spreadNominal,
            spreadPercentual,
            profundidadeAskXRP,
            profundidadeAskRLUSD,
            profundidadeBidXRP,
            profundidadeBidRLUSD,
            imbalanceBuyPercent: obiTop10.buyPercent,
            imbalanceSellPercent: obiTop10.sellPercent,
            obiTop5,
            obiTop20,
            obiDecay,
            cvdRLUSD,
            cvd60s: fluxoCvd.cvd60s,
            cvd300s: fluxoCvd.cvd300s,
            vpinProxy60s: fluxoCvd.vpinProxy60s,
            priceDelta60s: fluxoCvd.priceDelta60s,
            signalAbsorptionDivergence: fluxoCvd.signalAbsorptionDivergence,
            ledgerFlow: fluxoLedger,
            candleContext,
            externalConfluence,
            exhaustionRadar,
            slippageCompra: simulaCompra,
            slippageVenda: simulaVenda,
            vwap: vwapAtual
        };
    } catch (err) {
        console.error("[ERRO TELEMETRIA]", err.message);
        return null;
    }
}

let isTelemetryRunning = false;
let isReconnecting = false;
let reconnectAttempt = 0;

async function executarCicloTelemetry(force = false) {
    if (isTelemetryRunning) return;
    isTelemetryRunning = true;
    try {
        const dados = await coletarDadosTelemetry(force);
        if (dados) {
            io.emit('xrpl_telemetry', dados);
        }
    } finally {
        isTelemetryRunning = false;
    }
}

async function assinarStreamsXRPL() {
    await engine.client.request({
        command: "subscribe",
        streams: ["ledger", "transactions"]
    });
}

function anexarListenersCliente() {
    engine.client.removeAllListeners("disconnected");
    engine.client.removeAllListeners("ledgerClosed");
    engine.client.removeAllListeners("transaction");

    engine.client.on("disconnected", async (code) => {
        if (isReconnecting) return;
        isReconnecting = true;

        const delayMs = Math.min(3000 * Math.pow(2, reconnectAttempt), 20000);
        reconnectAttempt += 1;
        const nextServer = engine.rotateServer();

        console.log(`[DESCONECTADO] Código ${code} (${engine.getCurrentServer()}). Tentativa #${reconnectAttempt} em ${(delayMs / 1000).toFixed(1)}s via ${nextServer}...`);

        setTimeout(async () => {
            try {
                await engine.connect();
                anexarListenersCliente();
                await assinarStreamsXRPL();
                reconnectAttempt = 0;
                console.log(`[RECONECTADO] Operando em ${engine.getCurrentServer()}`);
                await executarCicloTelemetry(true);
            } catch (e) {
                console.error(`[FALHA RECONEXÃO] ${nextServer}: ${e.message}`);
            } finally {
                isReconnecting = false;
            }
        }, delayMs);
    });

    engine.client.on("ledgerClosed", async () => {
        await executarCicloTelemetry(false);
    });

    engine.client.on("transaction", (tx) => {
        registrarFluxoLedger(tx);
        const trade = processarTradeMeta(tx);
        if (trade) {
            tradeHistory.unshift(trade);
            if (tradeHistory.length > 15) {
                tradeHistory.pop();
            }
            salvarEstadoTelemetriaJSON(false);
            io.emit('xrpl_trade', trade);
        }
    });
}

async function conectarComFallbackInicial() {
    const totalTentativas = Math.max(engine.servers.length * 2, 4);
    for (let i = 0; i < totalTentativas; i++) {
        const servidorAtual = engine.getCurrentServer();
        try {
            console.log(`[CONECTANDO] Tentando ${servidorAtual} (timeout ${engine.connectionTimeoutMs}ms)...`);
            await engine.connect();
            console.log(`[CONECTADO] Nó ativo: ${servidorAtual}`);
            return;
        } catch (err) {
            console.error(`[FALHA CONEXÃO] ${servidorAtual}: ${err.message}`);
            engine.rotateServer();
        }
    }
    throw new Error("Não foi possível conectar a nenhum servidor WSS da XRPL na inicialização.");
}

const IS_TEST_MOCK_MODE = process.env.TEST_MOCK_MODE === 'true';

async function iniciarServidor() {
    if (!IS_TEST_MOCK_MODE) {
        await conectarComFallbackInicial();
        await engine.init();
        await carregarHistoricoExecucoes();
    }

    carregarEstadoSwingsJSON();
    carregarEstadoTelemetriaJSON();

    io.on('connection', async (socket) => {
        syncUtcCycle(new Date());
        socket.emit('runtime_config_state', {
            config: runtimeConfig,
            dailySwings,
            utcDayKey: currentUtcDayKey
        });
        const dadosIniciais = await coletarDadosTelemetry(true);
        if (tickHistory.length > 0) {
            socket.emit('xrpl_tick_history', tickHistory);
        }
        if (dadosIniciais) {
            socket.emit('xrpl_telemetry', dadosIniciais);
        }
        if (tradeHistory.length > 0) {
            socket.emit('xrpl_trade_history', tradeHistory);
        }

        socket.on('update_runtime_config', async (patch) => {
            if (!patch || typeof patch !== 'object') return;
            if (Number.isFinite(Number(patch.minSwingLegPct))) {
                runtimeConfig.minSwingLegPct = Math.max(0.10, Math.min(20.0, Number(patch.minSwingLegPct)));
            }
            if (Number.isFinite(Number(patch.reversalConfirmPct))) {
                runtimeConfig.reversalConfirmPct = Math.max(0.05, Math.min(10.0, Number(patch.reversalConfirmPct)));
            }
            if (Number.isFinite(Number(patch.minCandles5mBetweenPivots))) {
                runtimeConfig.minCandles5mBetweenPivots = Math.max(1, Math.min(30, Math.round(Number(patch.minCandles5mBetweenPivots))));
            }
            if (Number.isFinite(Number(patch.ofiThreshold))) {
                runtimeConfig.ofiThreshold = Math.max(0.1, Math.min(0.99, Number(patch.ofiThreshold)));
            }
            if (Number.isFinite(Number(patch.slippageAmountRlusd))) {
                runtimeConfig.slippageAmountRlusd = Math.max(10, Math.min(1000000, Number(patch.slippageAmountRlusd)));
            }
            if (Number.isFinite(Number(patch.whaleThresholdRlusd))) {
                runtimeConfig.whaleThresholdRlusd = Math.max(50, Math.min(10000000, Number(patch.whaleThresholdRlusd)));
                tradeHistory = tradeHistory.map(t => ({
                    ...t,
                    isWhale: Number(t.amountRLUSD) >= runtimeConfig.whaleThresholdRlusd
                }));
                io.emit('xrpl_trade_history', tradeHistory);
            }
            if (Number.isFinite(Number(patch.pollingIntervalMs))) {
                runtimeConfig.pollingIntervalMs = Math.max(1500, Math.min(30000, Math.round(Number(patch.pollingIntervalMs))));
            }
            if (typeof patch.emaTrendFilter === 'boolean') {
                runtimeConfig.emaTrendFilter = patch.emaTrendFilter;
            }
            if (typeof patch.enableTelegramAlerts === 'boolean') {
                runtimeConfig.enableTelegramAlerts = patch.enableTelegramAlerts;
            }
            io.emit('runtime_config_state', {
                config: runtimeConfig,
                dailySwings,
                utcDayKey: currentUtcDayKey
            });
            await executarCicloTelemetry(true);
        });
    });

    if (!IS_TEST_MOCK_MODE) {
        anexarListenersCliente();
        await assinarStreamsXRPL();

        setInterval(async () => {
            const backupGapMs = Math.max(runtimeConfig.pollingIntervalMs * 2.5, 7500);
            if (!isReconnecting && Date.now() - lastTelemetryRunMs >= backupGapMs) {
                await executarCicloTelemetry(false);
            }
        }, 5000);
    } else {
        app.use(express.json());
        app.post('/__test__/emit', (req, res) => {
            const { event, payload } = req.body || {};
            if (!event) return res.status(400).json({ ok: false, error: 'event_required' });
            if (event === 'xrpl_tick_history' && Array.isArray(payload)) {
                tickHistory = payload;
            } else if (event === 'xrpl_trade' && payload) {
                tradeHistory.unshift(payload);
            }
            io.emit(event, payload);
            return res.json({ ok: true });
        });
    }

    const PORT = parseInt(process.env.PORT || '3000', 10);
    server.listen(PORT, () => {
        console.log(`===============================================================`);
        console.log(` SERVER TELEMETRIA ONLINE: http://localhost:${PORT}`);
        console.log(`===============================================================`);
    });
}

if (require.main === module) {
    iniciarServidor();
}

module.exports = {
    iniciarServidor,
    calcularMidEstabilizado,
    parseOffer,
    calcularSlippage,
    calcularOBI,
    registrarFluxoLedger,
    resumirFluxoLedger,
    avaliarCvdEAbsorcao,
    avaliarRadarExaustaoCorredor,
    avaliarContextoCandles,
    atualizarCandlesAgregados,
    syncUtcCycle
};