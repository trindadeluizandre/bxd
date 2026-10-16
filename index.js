require('dotenv').config();
const xrpl = require('xrpl');
const config = require('./config');
const XRPLEngine = require('./engine');

const engine = new XRPLEngine();

async function iniciarMonitoramentoDEX() {
    console.log("===============================================================");
    console.log("      XRPL DEX TELEMETRY - ANALISADOR DE LIVRO DE OFERTAS      ");
    console.log("===============================================================");

    await engine.connect();
    await engine.init();

    // Função para tratamento de dados brutos das ofertas da DEX
    function parseOffer(offer) {
        const qttXRP = parseFloat(xrpl.dropsToXrp(typeof offer.TakerGets === 'string' ? offer.TakerGets : offer.TakerPays));
        const objRLUSD = typeof offer.TakerGets === 'object' ? offer.TakerGets : offer.TakerPays;
        const valorRLUSD = parseFloat(objRLUSD.value);
        const precoUnitario = valorRLUSD / qttXRP;

        return { qttXRP, valorRLUSD, precoUnitario };
    }

    async function processarMicroestruturaMercado() {
        try {
            // Consulta paralela dos dois lados do livro (Asks = Vendas | Bids = Compras)
            const [asksResponse, bidsResponse] = await Promise.all([
                engine.client.request({
                    command: "book_offers",
                    taker_gets: { currency: config.CURRENCY_XRP },
                    taker_pays: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                    limit: 10
                }),
                engine.client.request({
                    command: "book_offers",
                    taker_gets: { currency: config.CURRENCY_RLUSD, issuer: config.RLUSD_ISSUER },
                    taker_pays: { currency: config.CURRENCY_XRP },
                    limit: 10
                })
            ]);

            const asks = asksResponse.result.offers || [];
            const bids = bidsResponse.result.offers || [];

            if (asks.length === 0 || bids.length === 0) {
                console.log("[LIVRO SEM LIQUIDEZ] Ofertas insuficientes no par XRP/RLUSD.");
                return;
            }

            // Mapeamento das melhores ofertas topo de livro
            const bestAsk = parseOffer(asks[0]);
            const bestBid = parseOffer(bids[0]);

            // Cálculo das métricas puras de mercado
            const midPrice = (bestAsk.precoUnitario + bestBid.precoUnitario) / 2;
            const spreadNominal = bestAsk.precoUnitario - bestBid.precoUnitario;
            const spreadPercentual = (spreadNominal / bestAsk.precoUnitario) * 100;

            // Agregação da profundidade de liquidez no Top 10 do livro
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

            const timestamp = new Date().toLocaleTimeString('pt-BR');

            // Impressão limpa no terminal
            console.clear();
            console.log(`===============================================================`);
            console.log(` PAINEL DE TELEMETRIA XRPL | ${timestamp} | PAR: XRP/RLUSD`);
            console.log(`===============================================================`);
            console.log(` Best Ask (Menor Venda) : $${bestAsk.precoUnitario.toFixed(4)} RLUSD`);
            console.log(` Best Bid (Maior Compra): $${bestBid.precoUnitario.toFixed(4)} RLUSD`);
            console.log(` Mid-Price (Preço Médio): $${midPrice.toFixed(4)} RLUSD`);
            console.log(` Spread Nominal         : $${spreadNominal.toFixed(4)} RLUSD`);
            console.log(` Spread Percentual      : ${spreadPercentual.toFixed(2)}%`);
            console.log(`---------------------------------------------------------------`);
            console.log(` PROFUNDIDADE DO LIVRO (Top 10 Níveis):`);
            console.log(`  ► Asks (Ofertas de Venda) : ${profundidadeAskXRP.toFixed(2)} XRP (~$${profundidadeAskRLUSD.toFixed(2)} RLUSD)`);
            console.log(`  ► Bids (Ofertas de Compra): ${profundidadeBidXRP.toFixed(2)} XRP (~$${profundidadeBidRLUSD.toFixed(2)} RLUSD)`);
            console.log(`===============================================================\n`);

        } catch (err) {
            console.error("[ERRO DE PROCESSAMENTO DO LIVRO]", err.message);
        }
    }

    // Leitura imediata
    await processarMicroestruturaMercado();

    // Sincronização reativa com os blocos da blockchain
    engine.client.on("ledgerClosed", async () => {
        await processarMicroestruturaMercado();
    });

    await engine.client.request({
        command: "subscribe",
        streams: ["ledger"]
    });
}

iniciarMonitoramentoDEX();