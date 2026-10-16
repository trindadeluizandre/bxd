require('dotenv').config();
const xrpl = require('xrpl');
const xrplSecretNumbers = require('@xrplf/secret-numbers');
const config = require('./config');

class XRPLEngine {
    constructor() {
        this.client = new xrpl.Client(process.env.XRPL_NODE);
        this.wallet = null;
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
        if (this.client.isConnected()) {
            await this.client.disconnect();
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

        console.log(`[STATUS DA TRANSAÇÃO] Resultado na Blockchain: ${result.result.meta.TransactionResult}`);
        return result;
    }
}

module.exports = XRPLEngine;