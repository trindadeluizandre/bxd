const xrpl = require('xrpl');

// Converte "RLUSD" para a representação Hexadecimal de 40 caracteres exigida pela XRPL
const rlusdHex = xrpl.convertStringToHex('RLUSD').padEnd(40, '0');

module.exports = {
    // Parâmetros de Protocolo e Conexão
    RLUSD_ISSUER: process.env.RLUSD_ISSUER || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    CURRENCY_XRP: 'XRP',
    CURRENCY_RLUSD: rlusdHex
};