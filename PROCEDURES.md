# PROCEDURES.md — Guia Operacional e Técnico do xrpl-telemetry (XRP/RLUSD)

## 1. Visão Geral do Sistema
O **xrpl-telemetry** monitora o livro de ofertas (`book_offers`), o fluxo de transações (`ledger` e `transactions`) e o histórico recente (`account_tx`) do par **XRP/RLUSD** na XRPL Mainnet, entregando telemetria em tempo real via **Socket.IO** para o painel web (`http://localhost:3000`).

* **Backend (`server.js`):** Coleta ofertas de compra/venda, calcula `Mid-Price`, `Microprice`, `Spread`, profundidade (Top 10), `Orderbook Imbalance` (Top 5, Top 10, Top 20 e Decay), simulação de `Slippage`, `CVD` (total, 60s e 5m), `VPIN proxy` (60s), fluxo do ledger (`OfferCreate`, `OfferCancel`, `AMM`), candles agregados (`1m`, `5m`, `15m`, `1h`), faixa diária (`dayRange`), volatilidade (`ATR 5m`), suporte/resistência (`S/R`), referência externa spot (Coinbase `XRP-USD`), radar de exaustão/reversão de pivôs e alertas opcionais no Telegram.
* **Frontend (`public/index.html`):** Exibe os cards de telemetria, barras de desequilíbrio, simulador de slippage, confluência externa, banner do radar de exaustão, controles em tempo real, contexto/histórico de candles, card de apoio operacional de cota, gráfico (`LightweightCharts` com `Mid-Price`, `EMA 9` e `VWAP`), `Tape Reader & Whale Tracker` e `Registro 24h — Topos & Fundos de Exaustão`.
* **Persistência em Disco:** Salva o estado diário em `data/daily_swings_24h.json` (`utcDayKey`, `dailySwings` até 50 registros e `pivotState`), com reset automático a cada virada de dia UTC (`00:00 UTC` = `21:00 BRT`).

---

## 2. Comandos de Terminal (Windows 11 / Git Bash / MINGW64 / PM2)

### 2.1 Abertura do Painel no Navegador
Abrir no navegador padrão via Git Bash:
```bash
start http://localhost:3000

Forçar abertura no Google Chrome:

Bash
start chrome http://localhost:3000
2.2 Gerenciamento do Processo via PM2 (xrpl-telemetry)
Iniciar o servidor sob PM2 no diretório /c/Projetos/xrpl-telemetry:

Bash
pm2 start server.js --name "xrpl-telemetry"
Verificar status dos processos ativos:

Bash
pm2 status
Acompanhar logs em tempo real:

Bash
pm2 logs xrpl-telemetry
Reiniciar após alterações no código ou variáveis de ambiente:

Bash
pm2 restart xrpl-telemetry
Parar o processo:

Bash
pm2 stop xrpl-telemetry
Salvar lista de processos e restaurar após reinicialização do sistema (se aplicável):

Bash
pm2 save
(Nota: se anteriormente existia um processo legado nomeado xrpl-dashboard, você pode removê-lo com pm2 delete xrpl-dashboard para evitar confusão de logs.)

2.3 Execução Direta (Desenvolvimento e Depuração)
Executar em primeiro plano com Node:

Bash
node server.js
Executar via script start do package.json:

Bash
npm start
2.4 Auditoria, Dependências e Inspeção de Estado/Persistência
Auditar dependências e verificar estado do repositório Git:

Bash
npm audit
git status
Inspecionar o arquivo de persistência diária dos pivôs (data/daily_swings_24h.json):

Bash
cat data/daily_swings_24h.json

-------------------------------

3. Como Operar o Sistema na Prática

3.1 Rotina de Inicialização e Conferência

Suba o serviço com pm2 start server.js --name "xrpl-telemetry" (ou npm start / node server.js para depuração) e acompanhe pm2 logs xrpl-telemetry até confirmar [CONECTADO] Nó ativo... e SERVER TELEMETRIA ONLINE: http://localhost:3000.

É normal ver [AVISO] SEED/Secret Numbers não configurados no .env. Executando em MODO SOMENTE LEITURA. na inicialização, pois o xrpl-telemetry atua como telemetria/leitura.

Abra http://localhost:3000 e valide se o cabeçalho exibe Atualizado em: ... e se os preços (BEST ASK, BEST BID, MID-PRICE) estão atualizando.

Verifique no card CONTROLES & CHAVES DE CALIBRAÇÃO (TEMPO REAL) os parâmetros ativos (Perna Mínima, Recuo/Repique Conf., Velas 5m Mínimas, OFI Threshold, Slippage, Polling, EMA_TREND_FILTER e ENABLE_TELEGRAM_ALERTS).

3.2 Leitura Operacional para Venda / Realização e Recompra de XRP

Evitar saída prematura em pernas estendidas: Quando o preço rompe o pivô oposto (extendingLeg === "TOP" ou "BOTTOM"), o sistema estende a perna (ESTENDENDO_TOP_LEG ou ESTENDENDO_BOTTOM_LEG) e não grava um pivô oposto prematuro no meio do movimento.

Aguardar confirmação de exaustão: O radar exige amplitude mínima da perna (minSwingLegPct), recuo ou repique mínimo (confirmPct, ajustado pelo multiplicador de volatilidade ATR 5m), espaçamento mínimo em velas de 5m (minCandles5mBetweenPivots), score >= 4/6 (ou até 6/6 com bônus de contexto de candle quando emaBiasAllows é verdadeiro) e 2 leituras consecutivas (confirmations === 2).

Usar o Card de Apoio Operacional de Cota (#quotaDecisionCard): Combine o estado de exaustão (VENDA / REALIZAÇÃO, RECOMPRA XRP ou EXTENSÃO ... ATIVA) com CVD 60s, distância percentual vs VWAP, proximidade de S/R (5m, 15m, 1h, D_24H), Slippage C/V e Diff Spot.

Atenção ao áudio do navegador: Os alertas sonoros (emitirBeepWhale e emitirBeepExaustao) usam AudioContext e podem exigir interação prévia do usuário na página para serem liberados pelo navegador.

4. Todos os Dados do Sistema: Visíveis, Ocultos/Condicionais e Internos

4.1 Dados Visíveis no Painel (index.html)
Cabeçalho: Título XRPL DEX TELEMETRY | XRP/RLUSD e #timestamp (Atualizado em: HH:MM:SS).

Grid Principal:

BEST ASK (#bestAsk): menor preço de oferta de venda de XRP.

BEST BID (#bestBid): maior preço de oferta de compra de XRP.

MID-PRICE (#midPrice): média simples (bestAsk + bestBid) / 2.

MICROPRICE (#micropriceValue): média ponderada pelo volume no Top 1 Bid/Ask.

SPREAD (#spread): spread nominal e percentual ((bestAsk - bestBid) / bestAsk) * 100.

CVD TOTAL / 60S / 5M (#cvdValue e #cvdWindows): CVD acumulado desde o boot e janelas móveis de 60s e 5m em RLUSD.

VWAP DE LEDGER (#vwapValue): totalVolumeRLUSDAcumulado / totalVolumeXRPAcumulado.

FLUXO / ABSORÇÃO (#flowSignal e #flowDetails): signalAbsorptionDivergence, VPIN proxy (60s), % Canc (offerCancelRatio) e AMM (ammTxCount).

Profundidade (Top 10): PROFUNDIDADE DE VENDA (#depthAsk) e PROFUNDIDADE DE COMPRA (#depthBid) em XRP e ~$ RLUSD.

Orderbook Imbalance: Barra e percentuais de COMPRADORES vs VENDEDORES (Top 10) + #obiMultiDetails (Top 5 Bid, Top 20 Bid e Decay Bid).

Simulador de Slippage: Preço médio estimado e % de slippage para compra e venda no valor configurado em slippageAmountRlusd (padrão $1.000 RLUSD).

Confluência Externa: Preço spot externo (Coinbase XRP-USD), % de diferença e status (NO_REF, ALIGNED, LOCAL_PREMIUM, LOCAL_DISCOUNT).

Radar de Exaustão & Reversão:

Sinal e score (#exhaustionSignalText), Âncora Pivô e direção buscada (#exhaustionCorridorMeta), Topo/Fundo, Recuo, Repique e Gatilho (#exhaustionTrailingMeta), variação percentual (#exhaustionDevValue) e status (#exhaustionStatusDetail).

Controles & Chaves de Calibração: Inputs de Perna Mínima (%), Recuo/Repique Conf. (%), Velas 5m Mínimas, OFI Threshold, Slippage (RLUSD), Polling / Refresh (MS), checkboxes EMA_TREND_FILTER e ENABLE_TELEGRAM_ALERTS, botão APLICAR PARÂMETROS e status ativo (#runtimeConfigStatus).

Contexto & Histórico de Candles: REGIME DE MERCADO, VIÉS DE VELA / REVERSÃO, resumos atuais (1m, 5m, 15m), faixas históricas das últimas velas fechadas (Hist 1m, Hist 5m, Hist 15m), Volatilidade (ATR 5m) e S/R Mais Próximo (5m/15m/1h/D).

Apoio Operacional de Cota: Leitura consolidada de exaustão, CVD 60s, % vs VWAP, S/R e Slippage C/V / Diff Spot.

Gráfico em Tempo Real: Mid-Price (azul), EMA 9 (dourada tracejada), VWAP (roxa) e marcadores de trades/whales (até 40 marcadores no cliente).

Tape Reader & Whale Tracker: Até 15 negócios recentes, destacando whales (amountRLUSD >= 1500 com badge WHALE e linha destacada).

Registro 24h — Topos & Fundos de Exaustão: Resumo do ciclo UTC (00:00 UTC = 21:00 BRT), contadores de Topos e Fundos, Fase atual, tabela paginada (10 itens por página, até 50 registros no histórico diário).

4.2 Dados Que Ficam Ocultos, Condicionais ou Só Aparecem em Determinados Momentos
Bônus de Score por Contexto de Candle (+1 até teto 6/6): O server.js soma +1 ao exhaustionRadar.score (limitado a 6) quando há SELL_REVERSAL_EXHAUSTION com candleContext.candleBias === "TOP_EXHAUSTION_CONTEXT" ou BUY_REVERSAL_EXHAUSTION com candleContext.candleBias === "BOTTOM_EXHAUSTION_CONTEXT", respeitando emaTrendFilter.

Estado de Extensão de Perna (extendingLeg = "TOP" ou "BOTTOM"): Só aparece quando o preço rompe além de 0.03% (breakoutBufferPct) a referência do pivô anterior em direção oposta ao pivô buscado, alterando phaseLabel para ESTENDENDO_TOP_LEG (...) ou ESTENDENDO_BOTTOM_LEG (...) e exibindo EXTENSÃO ... ATIVA no card de cota.

Substituição Cirúrgica de Pivô Estendido (replaceIndex === 0): Quando o último registro salvo em dailySwings[0] é do mesmo kind (TOPO ou FUNDO) e o penúltimo não é do mesmo tipo, um novo extremo com diferença relevante substitui dailySwings[0] em vez de criar duplicata ou quebrar a alternância.

Mensagens de Falta de Liquidez no Slippage: "Liquidez insuficiente no Top 15" só aparece quando rlusdRestante > 0 ao percorrer as ofertas disponíveis do livro.

Níveis de 1H_RES e 1H_SUP: Só entram na avaliação de S/R quando existem velas fechadas de 1 hora (candles1h.slice(0, -1).slice(-12).length > 0).

Dados de dayRange (high, low, open): Calculados no servidor e enviados em candleContext.dayRange, mas não possuem card dedicado no index.html (apenas alimentam D_RES_24H e D_SUP_24H no cálculo de S/R).

Paginação do Registro 24h: Os botões de página só aparecem quando há mais de 10 registros (DAILY_SWINGS_PAGE_SIZE = 10) no ciclo UTC atual.

Alertas no Telegram: Só disparam quando enableTelegramAlerts está ativo e TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID estão configurados no ambiente.

Reset à Meia-Noite UTC (00:00 UTC / 21:00 BRT): syncUtcCycle limpa dailySwings e reseta pivotState quando utcDayKey muda; syncDayRange reinicia dayRangeState no novo dia UTC.

5. Regras de Pivôs, Extensões e Regimes do Motor
Padrões de Calibração (runtimeConfig): minSwingLegPct = 1.20%, reversalConfirmPct = 0.25%, minCandles5mBetweenPivots = 3, ofiThreshold via process.env.OFI_THRESHOLD || "0.55", slippageAmountRlusd = 1000, pollingIntervalMs mínimo de 1500ms (padrão 3000ms via POLLING_INTERVAL_MS).

Multiplicador de Volatilidade (ATR 5m):

atr5mPct < 0.16%: CALMO (confirmMultiplier = 0.85).

0.16% <= atr5mPct <= 0.45%: NORMAL (confirmMultiplier = 1.0).

atr5mPct > 0.45%: TENSO (confirmMultiplier = 1.35).

Confirmação de Pivô: Requer canEvaluateTop ou canEvaluateBottom (respeitando hasMinCandleSpacing, amplitude da perna >= minLegPct e recuo/repique >= confirmPct), score >= 4 e confirmations >= 2 leituras consecutivas do mesmo candidato.

6. Variáveis de Ambiente (.env) e Configuração
OFI_THRESHOLD: Limiar numérico do OFI (ex.: 0.55).

POLLING_INTERVAL_MS: Intervalo mínimo de coleta em milissegundos (mínimo efetivo 1500).

EMA_TREND_FILTER: "true" para aplicar o filtro de confluência de contexto de vela no bônus de score.

ENABLE_TELEGRAM_ALERTS: "true" para habilitar envio de alertas de pivô confirmado via Bot API do Telegram.

TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID: Credenciais do bot e destino das mensagens.

PORT: No server.js atual, o servidor escuta na porta fixa 3000 (const PORT = 3000;).

7. Sugestões para Enriquecer o PROCEDURES.md e a Operação
Tabela de Diagnóstico Rápido de Logs:

[ERRO TELEMETRIA] The server is too busy to help you now.: Sobrecarga momentânea do nó WSS (wss://xrplcluster.com). Em geral se resolve no próximo ciclo de coleta; se persistir com frequência, avalie rotacionar/ajustar os servidores configurados no engine ou aumentar POLLING_INTERVAL_MS (ex.: 3000 a 5000 ms).

[HISTÓRICO CONCLUÍDO] 0 trades processados...: Indica que entre as últimas 60 transações do emissor RLUSD recuperadas no boot não houve OfferCreate elegível do par XRP/RLUSD com execução em AffectedNodes/valores parseáveis; o fluxo passa a ser alimentado pelos eventos em tempo real (xrpl_trade).

[PERSISTENCIA JSON] Carregados N swings do ciclo UTC ...: Confirma retomada do estado salvo em data/daily_swings_24h.json dentro do mesmo dia UTC.

[DESCONECTADO] / [RECONECTADO]: Backoff exponencial automático na reconexão da XRPL.

Perfis de Calibração por Cenário: Documentar presets práticos para mercado lateral/baixo volume vs. rompimento/alta volatilidade (minSwingLegPct, reversalConfirmPct, minCandles5mBetweenPivots e EMA_TREND_FILTER).

Checklist de Troca de Dia UTC (21:00 BRT): Orientar a conferência de data/daily_swings_24h.json antes e após 21:00 BRT (00:00 UTC) para auditoria de swings encerrados.

Evolução Futura Recomendada (Opcional): Expor dayRange (D_HIGH / D_LOW / D_OPEN) e a janela de 5m no card de apoio de cota, além de tornar PORT configurável via process.env.PORT || 3000.

## Versão Técnica

Sim, você observou muito bem: o repositório e o sistema são **`xrpl-telemetry`** (`green@Dell MINGW64 /c/Projetos/xrpl-telemetry (main)`), e o nome **`xrpl-dashboard`** na seção de PM2 vinha daquele trecho desatualizado.

Abaixo está o documento **`PROCEDURES.md`** completo, alinhado ao sistema **`xrpl-telemetry`** e incorporando as observações reais do seu log de execução (`wss://xrplcluster.com`, modo somente leitura, carregamento de swings do ciclo UTC e ocorrência transiente de `[ERRO TELEMETRIA] The server is too busy to help you now.`).

```markdown
# PROCEDURES.md — Guia Operacional e Técnico do xrpl-telemetry (XRP/RLUSD)

## 1. Visão Geral do Sistema
O **xrpl-telemetry** monitora o livro de ofertas (`book_offers`), o fluxo de transações (`ledger` e `transactions`) e o histórico recente (`account_tx`) do par **XRP/RLUSD** na XRPL Mainnet, entregando telemetria em tempo real via **Socket.IO** para o painel web (`http://localhost:3000`).

* **Backend (`server.js`):** Coleta ofertas de compra/venda, calcula `Mid-Price`, `Microprice`, `Spread`, profundidade (Top 10), `Orderbook Imbalance` (Top 5, Top 10, Top 20 e Decay), simulação de `Slippage`, `CVD` (total, 60s e 5m), `VPIN proxy` (60s), fluxo do ledger (`OfferCreate`, `OfferCancel`, `AMM`), candles agregados (`1m`, `5m`, `15m`, `1h`), faixa diária (`dayRange`), volatilidade (`ATR 5m`), suporte/resistência (`S/R`), referência externa spot (Coinbase `XRP-USD`), radar de exaustão/reversão de pivôs e alertas opcionais no Telegram.
* **Frontend (`public/index.html`):** Exibe os cards de telemetria, barras de desequilíbrio, simulador de slippage, confluência externa, banner do radar de exaustão, controles em tempo real, contexto/histórico de candles, card de apoio operacional de cota, gráfico (`LightweightCharts` com `Mid-Price`, `EMA 9` e `VWAP`), `Tape Reader & Whale Tracker` e `Registro 24h — Topos & Fundos de Exaustão`.
* **Persistência em Disco:** Salva o estado diário em `data/daily_swings_24h.json` (`utcDayKey`, `dailySwings` até 50 registros e `pivotState`), com reset automático a cada virada de dia UTC (`00:00 UTC` = `21:00 BRT`).

---

## 2. Comandos de Terminal (Windows 11 / Git Bash / MINGW64 / PM2)

### 2.1 Abertura do Painel no Navegador
Abrir no navegador padrão via Git Bash:
```bash
start http://localhost:3000

```

Forçar abertura no Google Chrome:

```bash
start chrome http://localhost:3000

```

### 2.2 Gerenciamento do Processo via PM2 (`xrpl-telemetry`)

Iniciar o servidor sob PM2 no diretório `/c/Projetos/xrpl-telemetry`:

```bash
pm2 start server.js --name "xrpl-telemetry"

```

Verificar status dos processos ativos:

```bash
pm2 status

```

Acompanhar logs em tempo real:

```bash
pm2 logs xrpl-telemetry

```

Reiniciar após alterações no código ou variáveis de ambiente:

```bash
pm2 restart xrpl-telemetry

```

Parar o processo:

```bash
pm2 stop xrpl-telemetry

```

Salvar lista de processos e restaurar após reinicialização do sistema (se aplicável):

```bash
pm2 save

```

*(Nota: se anteriormente existia um processo legado nomeado `xrpl-dashboard`, você pode removê-lo com `pm2 delete xrpl-dashboard` para evitar confusão de logs.)*

### 2.3 Execução Direta (Desenvolvimento e Depuração)

Executar em primeiro plano com Node:

```bash
node server.js

```

Executar via script `start` do `package.json`:

```bash
npm start

```

### 2.4 Auditoria, Dependências e Inspeção de Estado/Persistência

Auditar dependências e verificar estado do repositório Git:

```bash
npm audit
git status

```

Inspecionar o arquivo de persistência diária dos pivôs (`data/daily_swings_24h.json`):

```bash
cat data/daily_swings_24h.json

```

---

## 3. Como Operar o Sistema na Prática

### 3.1 Rotina de Inicialização e Conferência

1. Suba o serviço com `pm2 start server.js --name "xrpl-telemetry"` (ou `npm start` / `node server.js` para depuração) e acompanhe `pm2 logs xrpl-telemetry` até confirmar `[CONECTADO] Nó ativo...` e `SERVER TELEMETRIA ONLINE: http://localhost:3000`.
2. É normal ver `[AVISO] SEED/Secret Numbers não configurados no .env. Executando em MODO SOMENTE LEITURA.` na inicialização, pois o `xrpl-telemetry` atua como telemetria/leitura.
3. Abra `http://localhost:3000` e valide se o cabeçalho exibe `Atualizado em: ...` e se os preços (`BEST ASK`, `BEST BID`, `MID-PRICE`) estão atualizando.
4. Verifique no card **CONTROLES & CHAVES DE CALIBRAÇÃO (TEMPO REAL)** os parâmetros ativos (`Perna Mínima`, `Recuo/Repique Conf.`, `Velas 5m Mínimas`, `OFI Threshold`, `Slippage`, `Polling`, `EMA_TREND_FILTER` e `ENABLE_TELEGRAM_ALERTS`).

### 3.2 Leitura Operacional para Venda / Realização e Recompra de XRP

* **Evitar saída prematura em pernas estendidas:** Quando o preço rompe o pivô oposto (`extendingLeg === "TOP"` ou `"BOTTOM"`), o sistema estende a perna (`ESTENDENDO_TOP_LEG` ou `ESTENDENDO_BOTTOM_LEG`) e não grava um pivô oposto prematuro no meio do movimento.
* **Aguardar confirmação de exaustão:** O radar exige amplitude mínima da perna (`minSwingLegPct`), recuo ou repique mínimo (`confirmPct`, ajustado pelo multiplicador de volatilidade `ATR 5m`), espaçamento mínimo em velas de 5m (`minCandles5mBetweenPivots`), `score >= 4/6` (ou até `6/6` com bônus de contexto de candle quando `emaBiasAllows` é verdadeiro) e **2 leituras consecutivas** (`confirmations === 2`).
* **Usar o Card de Apoio Operacional de Cota (`#quotaDecisionCard`):** Combine o estado de exaustão (`VENDA / REALIZAÇÃO`, `RECOMPRA XRP` ou `EXTENSÃO ... ATIVA`) com `CVD 60s`, distância percentual vs `VWAP`, proximidade de `S/R` (`5m`, `15m`, `1h`, `D_24H`), `Slippage C/V` e `Diff Spot`.
* **Atenção ao áudio do navegador:** Os alertas sonoros (`emitirBeepWhale` e `emitirBeepExaustao`) usam `AudioContext` e podem exigir interação prévia do usuário na página para serem liberados pelo navegador.

---

## 4. Todos os Dados do Sistema: Visíveis, Ocultos/Condicionais e Internos

### 4.1 Dados Visíveis no Painel (`index.html`)

* **Cabeçalho:** Título `XRPL DEX TELEMETRY | XRP/RLUSD` e `#timestamp` (`Atualizado em: HH:MM:SS`).
* **Grid Principal:**
* `BEST ASK` (`#bestAsk`): menor preço de oferta de venda de XRP.
* `BEST BID` (`#bestBid`): maior preço de oferta de compra de XRP.
* `MID-PRICE` (`#midPrice`): média simples `(bestAsk + bestBid) / 2`.
* `MICROPRICE` (`#micropriceValue`): média ponderada pelo volume no Top 1 Bid/Ask.
* `SPREAD` (`#spread`): spread nominal e percentual `((bestAsk - bestBid) / bestAsk) * 100`.
* `CVD TOTAL / 60S / 5M` (`#cvdValue` e `#cvdWindows`): CVD acumulado desde o boot e janelas móveis de `60s` e `5m` em RLUSD.
* `VWAP DE LEDGER` (`#vwapValue`): `totalVolumeRLUSDAcumulado / totalVolumeXRPAcumulado`.
* `FLUXO / ABSORÇÃO` (`#flowSignal` e `#flowDetails`): `signalAbsorptionDivergence`, `VPIN` proxy (60s), `% Canc` (`offerCancelRatio`) e `AMM` (`ammTxCount`).


* **Profundidade (Top 10):** `PROFUNDIDADE DE VENDA` (`#depthAsk`) e `PROFUNDIDADE DE COMPRA` (`#depthBid`) em XRP e `~$ RLUSD`.
* **Orderbook Imbalance:** Barra e percentuais de `COMPRADORES` vs `VENDEDORES` (Top 10) + `#obiMultiDetails` (`Top 5 Bid`, `Top 20 Bid` e `Decay Bid`).
* **Simulador de Slippage:** Preço médio estimado e `%` de slippage para compra e venda no valor configurado em `slippageAmountRlusd` (padrão `$1.000 RLUSD`).
* **Confluência Externa:** Preço spot externo (Coinbase `XRP-USD`), `%` de diferença e status (`NO_REF`, `ALIGNED`, `LOCAL_PREMIUM`, `LOCAL_DISCOUNT`).
* **Radar de Exaustão & Reversão:**
* Sinal e score (`#exhaustionSignalText`), Âncora Pivô e direção buscada (`#exhaustionCorridorMeta`), `Topo/Fundo`, `Recuo`, `Repique` e `Gatilho` (`#exhaustionTrailingMeta`), variação percentual (`#exhaustionDevValue`) e status (`#exhaustionStatusDetail`).


* **Controles & Chaves de Calibração:** Inputs de `Perna Mínima (%)`, `Recuo/Repique Conf. (%)`, `Velas 5m Mínimas`, `OFI Threshold`, `Slippage (RLUSD)`, `Polling / Refresh (MS)`, checkboxes `EMA_TREND_FILTER` e `ENABLE_TELEGRAM_ALERTS`, botão `APLICAR PARÂMETROS` e status ativo (`#runtimeConfigStatus`).
* **Contexto & Histórico de Candles:** `REGIME DE MERCADO`, `VIÉS DE VELA / REVERSÃO`, resumos atuais (`1m`, `5m`, `15m`), faixas históricas das últimas velas fechadas (`Hist 1m`, `Hist 5m`, `Hist 15m`), `Volatilidade (ATR 5m)` e `S/R Mais Próximo (5m/15m/1h/D)`.
* **Apoio Operacional de Cota:** Leitura consolidada de exaustão, `CVD 60s`, `% vs VWAP`, `S/R` e `Slippage C/V` / `Diff Spot`.
* **Gráfico em Tempo Real:** `Mid-Price` (azul), `EMA 9` (dourada tracejada), `VWAP` (roxa) e marcadores de trades/whales (até 40 marcadores no cliente).
* **Tape Reader & Whale Tracker:** Até 15 negócios recentes, destacando whales (`amountRLUSD >= 1500` com badge `WHALE` e linha destacada).
* **Registro 24h — Topos & Fundos de Exaustão:** Resumo do ciclo UTC (`00:00 UTC = 21:00 BRT`), contadores de `Topos` e `Fundos`, `Fase` atual, tabela paginada (10 itens por página, até 50 registros no histórico diário).

### 4.2 Dados Que Ficam Ocultos, Condicionais ou Só Aparecem em Determinados Momentos

* **Bônus de Score por Contexto de Candle (`+1` até teto `6/6`):** O `server.js` soma `+1` ao `exhaustionRadar.score` (limitado a `6`) quando há `SELL_REVERSAL_EXHAUSTION` com `candleContext.candleBias === "TOP_EXHAUSTION_CONTEXT"` ou `BUY_REVERSAL_EXHAUSTION` com `candleContext.candleBias === "BOTTOM_EXHAUSTION_CONTEXT"`, respeitando `emaTrendFilter`.
* **Estado de Extensão de Perna (`extendingLeg` = `"TOP"` ou `"BOTTOM"`):** Só aparece quando o preço rompe além de `0.03%` (`breakoutBufferPct`) a referência do pivô anterior em direção oposta ao pivô buscado, alterando `phaseLabel` para `ESTENDENDO_TOP_LEG (...)` ou `ESTENDENDO_BOTTOM_LEG (...)` e exibindo `EXTENSÃO ... ATIVA` no card de cota.
* **Substituição Cirúrgica de Pivô Estendido (`replaceIndex === 0`):** Quando o último registro salvo em `dailySwings[0]` é do mesmo `kind` (`TOPO` ou `FUNDO`) e o penúltimo não é do mesmo tipo, um novo extremo com diferença relevante substitui `dailySwings[0]` em vez de criar duplicata ou quebrar a alternância.
* **Mensagens de Falta de Liquidez no Slippage:** `"Liquidez insuficiente no Top 15"` só aparece quando `rlusdRestante > 0` ao percorrer as ofertas disponíveis do livro.
* **Níveis de `1H_RES` e `1H_SUP`:** Só entram na avaliação de `S/R` quando existem velas fechadas de 1 hora (`candles1h.slice(0, -1).slice(-12).length > 0`).
* **Dados de `dayRange` (`high`, `low`, `open`):** Calculados no servidor e enviados em `candleContext.dayRange`, mas não possuem card dedicado no `index.html` (apenas alimentam `D_RES_24H` e `D_SUP_24H` no cálculo de `S/R`).
* **Paginação do Registro 24h:** Os botões de página só aparecem quando há mais de `10` registros (`DAILY_SWINGS_PAGE_SIZE = 10`) no ciclo UTC atual.
* **Alertas no Telegram:** Só disparam quando `enableTelegramAlerts` está ativo e `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` estão configurados no ambiente.
* **Reset à Meia-Noite UTC (`00:00 UTC` / `21:00 BRT`):** `syncUtcCycle` limpa `dailySwings` e reseta `pivotState` quando `utcDayKey` muda; `syncDayRange` reinicia `dayRangeState` no novo dia UTC.

---

## 5. Regras de Pivôs, Extensões e Regimes do Motor

* **Padrões de Calibração (`runtimeConfig`):** `minSwingLegPct = 1.20%`, `reversalConfirmPct = 0.25%`, `minCandles5mBetweenPivots = 3`, `ofiThreshold` via `process.env.OFI_THRESHOLD || "0.55"`, `slippageAmountRlusd = 1000`, `pollingIntervalMs` mínimo de `1500ms` (padrão `3000ms` via `POLLING_INTERVAL_MS`).
* **Multiplicador de Volatilidade (`ATR 5m`):**
* `atr5mPct < 0.16%`: `CALMO` (`confirmMultiplier = 0.85`).
* `0.16% <= atr5mPct <= 0.45%`: `NORMAL` (`confirmMultiplier = 1.0`).
* `atr5mPct > 0.45%`: `TENSO` (`confirmMultiplier = 1.35`).


* **Confirmação de Pivô:** Requer `canEvaluateTop` ou `canEvaluateBottom` (respeitando `hasMinCandleSpacing`, amplitude da perna >= `minLegPct` e recuo/repique >= `confirmPct`), `score >= 4` e `confirmations >= 2` leituras consecutivas do mesmo candidato.

---

## 6. Variáveis de Ambiente (`.env`) e Configuração

* `OFI_THRESHOLD`: Limiar numérico do OFI (ex.: `0.55`).
* `POLLING_INTERVAL_MS`: Intervalo mínimo de coleta em milissegundos (mínimo efetivo `1500`).
* `EMA_TREND_FILTER`: `"true"` para aplicar o filtro de confluência de contexto de vela no bônus de score.
* `ENABLE_TELEGRAM_ALERTS`: `"true"` para habilitar envio de alertas de pivô confirmado via Bot API do Telegram.
* `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`: Credenciais do bot e destino das mensagens.
* `PORT`: No `server.js` atual, o servidor escuta na porta fixa `3000` (`const PORT = 3000;`).

---

## 7. Sugestões para Enriquecer o `PROCEDURES.md` e a Operação

1. **Tabela de Diagnóstico Rápido de Logs:**
* `[ERRO TELEMETRIA] The server is too busy to help you now.`: Sobrecarga momentânea do nó WSS (`wss://xrplcluster.com`). Em geral se resolve no próximo ciclo de coleta; se persistir com frequência, avalie rotacionar/ajustar os servidores configurados no `engine` ou aumentar `POLLING_INTERVAL_MS` (ex.: `3000` a `5000` ms).
* `[HISTÓRICO CONCLUÍDO] 0 trades processados...`: Indica que entre as últimas 60 transações do emissor RLUSD recuperadas no boot não houve `OfferCreate` elegível do par XRP/RLUSD com execução em `AffectedNodes`/valores parseáveis; o fluxo passa a ser alimentado pelos eventos em tempo real (`xrpl_trade`).
* `[PERSISTENCIA JSON] Carregados N swings do ciclo UTC ...`: Confirma retomada do estado salvo em `data/daily_swings_24h.json` dentro do mesmo dia UTC.
* `[DESCONECTADO]` / `[RECONECTADO]`: Backoff exponencial automático na reconexão da XRPL.


2. **Perfis de Calibração por Cenário:** Documentar presets práticos para mercado lateral/baixo volume vs. rompimento/alta volatilidade (`minSwingLegPct`, `reversalConfirmPct`, `minCandles5mBetweenPivots` e `EMA_TREND_FILTER`).
3. **Checklist de Troca de Dia UTC (`21:00 BRT`):** Orientar a conferência de `data/daily_swings_24h.json` antes e após `21:00 BRT` (`00:00 UTC`) para auditoria de swings encerrados.
4. **Evolução Futura Recomendada (Opcional):** Expor `dayRange` (`D_HIGH` / `D_LOW` / `D_OPEN`) e a janela de `5m` no card de apoio de cota, além de tornar `PORT` configurável via `process.env.PORT || 3000`.

```

---

## Versão Didática

Boa leitura do cenário, André! Realmente o nome do sistema é **`xrpl-telemetry`** (`green@Dell MINGW64 /c/Projetos/xrpl-telemetry (main)`), e já ajustei o `PROCEDURES.md` inteiro para refletir o nome certo no `PM2` (`xrpl-telemetry`) e incluir o que apareceu no seu terminal agora:

* A mensagem **`[ERRO TELEMETRIA] The server is too busy to help you now.`** é uma resposta pontual de sobrecarga do nó público da XRPL (`wss://xrplcluster.com`) durante uma consulta; o servidor continua rodando e tenta novamente nos próximos ciclos. Se acontecer demais, subir um pouco o `POLLING_INTERVAL_MS` ajuda a aliviar as requisições.
* O **`[PERSISTENCIA JSON] Carregados 4 swings do ciclo UTC 2026-11-21.`** confirma que seu histórico do dia foi recuperado certinho ao subir o processo.
* O aviso de modo somente leitura na inicialização é esperado para o `xrpl-telemetry`, já que ele é focado na leitura e telemetria do mercado.

Agora o texto está pronto para você salvar direto no seu **`PROCEDURES.md`** em `/c/Projetos/xrpl-telemetry`. Se quiser adicionar alguma seção específica de rotina sua no `xrpl-telemetry`, é só falar!

```