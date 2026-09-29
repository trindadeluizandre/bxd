require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const xrpl = require('xrpl');
const config = require('./config');
const XRPLEngine = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const engine = new XRPLEngine();

const WHALE_THRESHOLD_RLUSD = 1500;
let cvdRLUSD = 0;
let totalVolumeRLUSDAcumulado = 0;
let totalVolumeXRPAcumulado = 0;
let vwapAtual = 0;

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

async function coletarDadosTelemetry() {
    try {
        if (!engine.client || !engine.client.isConnected()) {
            return null;
        }

        const [asksResponse, bidsResponse] = await Promise.all([
            engine.client.request({
                command: "book_offers",
                taker_gets: { currency: config.CURRENCY_XRP },
                taker_pays: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                limit: 15
            }),
            engine.client.request({
                command: "book_offers",
                taker_gets: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                taker_pays: { currency: config.CURRENCY_XRP },
                limit: 15
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

        let profundidadeAskXRP = 0;
        let profundidadeAskRLUSD = 0;
        asks.forEach(offer => {
            const parsed = parseOffer(offer);
            profundidadeAskXRP += parsed.qttXRP;
            profundidadeAskRLUSD += parsed.valorRLUSD;
        });

        let profundidadeBidXRP = 0;
        let profundidadeBidRLUSD = 0;
        bids.forEach(offer => {
            const parsed = parseOffer(offer);
            profundidadeBidXRP += parsed.qttXRP;
            profundidadeBidRLUSD += parsed.valorRLUSD;
        });

        const totalLiquidez = profundidadeBidRLUSD + profundidadeAskRLUSD;
        const imbalanceBuyPercent = totalLiquidez > 0 ? (profundidadeBidRLUSD / totalLiquidez) * 100 : 50;
        const imbalanceSellPercent = totalLiquidez > 0 ? (profundidadeAskRLUSD / totalLiquidez) * 100 : 50;

        const simulaCompra = calcularSlippage(asks, 1000, bestAsk.precoUnitario, true);
        const simulaVenda = calcularSlippage(bids, 1000, bestBid.precoUnitario, false);

        return {
            timestamp: new Date().toLocaleTimeString('pt-BR'),
            bestAsk: bestAsk.precoUnitario,
            bestBid: bestBid.precoUnitario,
            midPrice,
            spreadNominal,
            spreadPercentual,
            profundidadeAskXRP,
            profundidadeAskRLUSD,
            profundidadeBidXRP,
            profundidadeBidRLUSD,
            imbalanceBuyPercent,
            imbalanceSellPercent,
            cvdRLUSD,
            slippageCompra: simulaCompra,
            slippageVenda: simulaVenda,
            vwap: vwapAtual
        };
    } catch (err) {
        console.error("[ERRO TELEMETRIA]", err.message);
        return null;
    }
}

async function iniciarServidor() {
    await engine.connect();
    await engine.init();

    io.on('connection', async (socket) => {
        const dadosIniciais = await coletarDadosTelemetry();
        if (dadosIniciais) {
            socket.emit('xrpl_telemetry', dadosIniciais);
        }
    });

    engine.client.on("disconnected", async (code) => {
        console.log(`[DESCONECTADO] Código ${code}. Reconectando em 5s...`);
        setTimeout(async () => {
            try {
                await engine.connect();
                await engine.client.request({ command: "subscribe", streams: ["ledger", "transactions"] });
            } catch (e) {
                console.error("[FALHA RECONEXÃO]", e.message);
            }
        }, 5000);
    });

    engine.client.on("ledgerClosed", async () => {
        const dados = await coletarDadosTelemetry();
        if (dados) {
            io.emit('xrpl_telemetry', dados);
        }
    });

    setInterval(async () => {
        const dados = await coletarDadosTelemetry();
        if (dados) {
            io.emit('xrpl_telemetry', dados);
        }
    }, 3000);

    engine.client.on("transaction", (tx) => {
        try {
            if (tx.validated && tx.transaction.TransactionType === "OfferCreate") {
                const transactionData = tx.transaction;
                
                let side = null;
                let amountXRP = 0;
                let amountRLUSD = 0;

                if (typeof transactionData.TakerGets === 'string' && typeof transactionData.TakerPays === 'object') {
                    if (transactionData.TakerPays.currency === config.CURRENCY_RLUSD) {
                        side = 'SELL';
                        amountXRP = parseFloat(xrpl.dropsToXrp(transactionData.TakerGets));
                        amountRLUSD = parseFloat(transactionData.TakerPays.value);
                    }
                } else if (typeof transactionData.TakerPays === 'string' && typeof transactionData.TakerGets === 'object') {
                    if (transactionData.TakerGets.currency === config.CURRENCY_RLUSD) {
                        side = 'BUY';
                        amountXRP = parseFloat(xrpl.dropsToXrp(transactionData.TakerPays));
                        amountRLUSD = parseFloat(transactionData.TakerGets.value);
                    }
                }

                if (side && amountXRP > 0) {
                    const price = amountRLUSD / amountXRP;
                    const isWhale = amountRLUSD >= WHALE_THRESHOLD_RLUSD;

                    if (side === 'BUY') {
                        cvdRLUSD += amountRLUSD;
                    } else {
                        cvdRLUSD -= amountRLUSD;
                    }

                    totalVolumeRLUSDAcumulado += amountRLUSD;
                    totalVolumeXRPAcumulado += amountXRP;
                    if (totalVolumeXRPAcumulado > 0) {
                        vwapAtual = totalVolumeRLUSDAcumulado / totalVolumeXRPAcumulado;
                    }

                    const tradePayload = {
                        timestamp: new Date().toLocaleTimeString('pt-BR'),
                        side,
                        price,
                        amountXRP,
                        amountRLUSD,
                        isWhale,
                        cvdRLUSD,
                        vwap: vwapAtual,
                        hash: tx.transaction.hash
                    };
                    io.emit('xrpl_trade', tradePayload);
                }
            }
        } catch (e) {
            console.error("[ERRO PROCESSAMENTO TRADE]", e.message);
        }
    });

    await engine.client.request({
        command: "subscribe",
        streams: ["ledger", "transactions"]
    });

    const PORT = 3000;
    server.listen(PORT, () => {
        console.log(`===============================================================`);
        console.log(` SERVER TELEMETRIA ONLINE: http://localhost:${PORT}`);
        console.log(`===============================================================`);
    });
}

iniciarServidor();