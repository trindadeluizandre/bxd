require('dotenv').config();
const xrpl = require('xrpl');
const xrplSecretNumbers = require('@xrplf/secret-numbers');
const config = require('./config');

const DEFAULT_XRPL_SERVERS = [
    "wss://s1.ripple.com",
    "wss://xrplcluster.com",
    "wss://s2.ripple.com"
];

function buildServerList() {
    const candidates = [
        process.env.XRPL_SERVER,
        process.env.XRPL_WSS_URL,
        process.env.XRPL_NODE,
        process.env.XRPL_SERVER_FALLBACK,
        ...DEFAULT_XRPL_SERVERS
    ];
    const unique = [];
    for (const url of candidates) {
        if (typeof url === "string") {
            const trimmed = url.trim();
            if (trimmed && !unique.includes(trimmed)) {
                unique.push(trimmed);
            }
        }
    }
    return unique;
}

class XRPLEngine {
    constructor() {
        this.servers = buildServerList();
        this.serverIndex = 0;
        this.connectionTimeoutMs = parseInt(process.env.XRPL_CONNECT_TIMEOUT_MS || "20000", 10);
        this.client = this._createClient(this.getCurrentServer());
        this.wallet = null;
    }

    _createClient(url) {
        const client = new xrpl.Client(url, {
            connectionTimeout: this.connectionTimeoutMs
        });
        client.on('error', (errorCode, errorMessage) => {
            console.error(`[XRPL CLIENT ERROR] (${url}) ${errorCode}:`, errorMessage || '');
        });
        return client;
    }

    getCurrentServer() {
        return this.servers[this.serverIndex] || "wss://s1.ripple.com";
    }

    rotateServer() {
        if (this.servers.length > 1) {
            this.serverIndex = (this.serverIndex + 1) % this.servers.length;
        }
        const nextUrl = this.getCurrentServer();
        this.client = this._createClient(nextUrl);
        return nextUrl;
    }

    async init() {
        const seed = process.env.PORTFOLIO_SEED;

        if (!seed || seed.includes('sua_chave_privada') || seed.includes('COLE_AQUI')) {
            console.log("\n[AVISO] SEED/Secret Numbers não configurados no .env. Executando em MODO SOMENTE LEITURA.");
            return;
        }

        try {
            const cleanSeed = seed.trim();

            if (cleanSeed.startsWith('s')) {
                // Family Seed tradicional (iniciada com 's')
                this.wallet = xrpl.Wallet.fromSeed(cleanSeed);
            } else {
                // Suporte a diferentes formatos de exportação do módulo @xrplf/secret-numbers
                let familySeed = null;

                if (typeof xrplSecretNumbers === 'function') {
                    const sn = new xrplSecretNumbers(cleanSeed);
                    familySeed = sn.getFamilySeed();
                } else if (xrplSecretNumbers.SecretNumbers) {
                    const sn = new xrplSecretNumbers.SecretNumbers(cleanSeed);
                    familySeed = sn.getFamilySeed();
                } else if (xrplSecretNumbers.getFamilySeed) {
                    familySeed = xrplSecretNumbers.getFamilySeed(cleanSeed);
                }

                if (!familySeed) {
                    throw new Error("Formato não suportado pela biblioteca @xrplf/secret-numbers.");
                }

                this.wallet = xrpl.Wallet.fromSeed(familySeed);
            }

            if (this.wallet && this.wallet.classicAddress) {
                console.log(`\n[CARTEIRA CONECTADA] Endereço Ativo: ${this.wallet.classicAddress}`);
            }
        } catch (error) {
            console.error("\n[ERRO DE AUTENTICAÇÃO] Não foi possível derivar a carteira com a chave do .env.");
            console.error("Detalhes:", error.message);
        }
    }

    async connect() {
        if (!this.client.isConnected()) {
            await this.client.connect();
        }
    }

   async disconnect() {
        try {
            if (this.client && this.client.isConnected()) {
                await this.client.disconnect();
            }
        } catch (error) {
            console.error("[AVISO DESCONEXÃO XRPL]", error.message);
        }
    }

    async criarOrdemCompra(quantidadeXRP, precoUnitarioRLUSD) {
        if (!this.wallet) {
            throw new Error("Carteira não inicializada. Verifique os dados no .env");
        }

        const totalRLUSD = (quantidadeXRP * precoUnitarioRLUSD).toFixed(6);
        const dropsXRP = xrpl.xrpToDrops(quantidadeXRP.toFixed(6));

        const offerTx = {
            TransactionType: "OfferCreate",
            Account: this.wallet.classicAddress,
            TakerGets: {
                currency: config.CURRENCY_RLUSD,
                issuer: config.RLUSD_ISSUER,
                value: totalRLUSD.toString()
            },
            TakerPays: dropsXRP.toString()
        };

        console.log(`\n[ASSINANDO E ENVIANDO ORDEM REAL] Compra de ${quantidadeXRP.toFixed(4)} XRP a $${precoUnitarioRLUSD.toFixed(4)} RLUSD (Total: $${totalRLUSD})`);

        const prepared = await this.client.autofill(offerTx);
        const signed = this.wallet.sign(prepared);
        const result = await this.client.submitAndWait(signed.tx_blob);

        const txResult = result?.result?.meta?.TransactionResult || "DESCONHECIDO";
        console.log(`[STATUS DA TRANSAÇÃO] Resultado na Blockchain: ${txResult}`);
        return result;
    }

    async criarOrdemVenda(quantidadeXRP, precoUnitarioRLUSD) {
        if (!this.wallet) {
            throw new Error("Carteira não inicializada. Verifique os dados no .env");
        }

        const totalRLUSD = (quantidadeXRP * precoUnitarioRLUSD).toFixed(6);
        const dropsXRP = xrpl.xrpToDrops(quantidadeXRP.toFixed(6));

        const offerTx = {
            TransactionType: "OfferCreate",
            Account: this.wallet.classicAddress,
            TakerGets: dropsXRP.toString(),
            TakerPays: {
                currency: config.CURRENCY_RLUSD,
                issuer: config.RLUSD_ISSUER,
                value: totalRLUSD.toString()
            }
        };

        console.log(`\n[ASSINANDO E ENVIANDO ORDEM REAL] Venda de ${quantidadeXRP.toFixed(4)} XRP a $${precoUnitarioRLUSD.toFixed(4)} RLUSD (Total: $${totalRLUSD})`);

        const prepared = await this.client.autofill(offerTx);
        const signed = this.wallet.sign(prepared);
        const result = await this.client.submitAndWait(signed.tx_blob);

        const txResult = result?.result?.meta?.TransactionResult || "DESCONHECIDO";
        console.log(`[STATUS DA TRANSAÇÃO] Resultado na Blockchain: ${txResult}`);
        return result;
    }
}

module.exports = XRPLEngine;