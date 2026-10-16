require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const xrpl = require('xrpl');
const config = require('./config');
const XRPLEngine = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const engine = new XRPLEngine();

const WHALE_THRESHOLD_RLUSD = 1500;
let cvdRLUSD = 0;
let totalVolumeRLUSDAcumulado = 0;
let totalVolumeXRPAcumulado = 0;
let vwapAtual = 0;
let tradeHistory = [];

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

        const transactionData = tx.transaction || tx;
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

            const timestamp = transactionData.date 
                ? new Date((transactionData.date + 946684800) * 1000).toLocaleTimeString('pt-BR')
                : new Date().toLocaleTimeString('pt-BR');

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

    await carregarHistoricoExecucoes();

    io.on('connection', async (socket) => {
        const dadosIniciais = await coletarDadosTelemetry();
        if (dadosIniciais) {
            socket.emit('xrpl_telemetry', dadosIniciais);
        }
        if (tradeHistory.length > 0) {
            socket.emit('xrpl_trade_history', tradeHistory);
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
        const trade = processarTradeMeta(tx);
        if (trade) {
            tradeHistory.unshift(trade);
            if (tradeHistory.length > 15) {
                tradeHistory.pop();
            }
            io.emit('xrpl_trade', trade);
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