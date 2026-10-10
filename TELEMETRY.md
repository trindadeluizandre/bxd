cat << 'EOF' > TELEMETRY.md
ESPECIFICAÇÃO TÉCNICA E MANUAL DE TELEMETRIA (PROJETO BXD)

Este documento estabelece a especificação completa da arquitetura de dados, métricas de microestrutura e fluxo de ordens processados pelo painel de telemetria `bxd` para o par de negociação XRP/RLUSD na DEX da XRPL.

---

1. CAMADA DE TOPO DE LIVRO (TOP-OF-BOOK & SPREAD)

- Best Ask (Menor Venda): Menor taxa marginal à qual um participante passivo aceita entregar XRP em troca de RLUSD.
  Formula: Ask_best = min(TakerPays_RLUSD / TakerGets_XRP)

- Best Bid (Maior Compra): Maior taxa marginal à qual um participante passivo aceita pagar em RLUSD para adquirir XRP.
  Formula: Bid_best = max(TakerGets_RLUSD / TakerPays_XRP)

- Mid-Price (Preço Médio Teórico): Ponto de equilíbrio exato entre a melhor oferta de compra e de venda:
  Formula: Mid_Price = (Ask_best + Bid_best) / 2

- Spread Nominal e Percentual: Medida de atrito transacional e iliquidez do livro:
  Formula: Spread_Nominal = Ask_best - Bid_best
  Formula: Spread_Percentual = (Spread_Nominal / Ask_best) * 100

---

2. INDICADORES DE FLUXO DE ORDENS (ORDERFLOW)

- CVD (Cumulative Volume Delta): Rastreia o saldo acumulado de agressão no mercado (compras a mercado versus vendas a mercado).
  Formula: CVD_t = CVD_{t-1} + Volume_Compra_RLUSD - Volume_Venda_RLUSD
  Interpretação: CVD positivo indica dominância de compradores agressivos; CVD negativo indica dominância de vendedores agressivos.

- VWAP de Ledger (Volume-Weighted Average Price): Preço médio ponderado pelo volume das execuções reais validadas nos blocos da sessão:
  Formula: VWAP = Total_Volume_RLUSD_Acumulado / Total_Volume_XRP_Acumulado

---

3. PROFUNDIDADE E ASIMETRIA DO LIVRO (ORDERBOOK IMBALANCE)

- Profundidade (Top 10): Soma da quantidade total de XRP e notional em RLUSD disponíveis nos 10 melhores níveis do livro.
- Orderbook Imbalance: Proporção percentual da liquidez passiva estática entre compradores e vendedores:
  Formula: Imbalance_Buy% = (Soma_Bids_RLUSD / (Soma_Bids_RLUSD + Soma_Asks_RLUSD)) * 100
  Formula: Imbalance_Sell% = 100% - Imbalance_Buy%

---

4. MODELO DE SIMULAÇÃO DE FRICCÃO (SLIPPAGE ESTIMADO)

- Simulador de Impacto de Mercado ($1.000 RLUSD): Varre a profundidade de ofertas do livro para calcular o preço médio ponderado de execução e o desvio percentual em relação ao topo do livro.
  Formula: Slippage_Compra% = ((Preco_Medio_Executado - Ask_best) / Ask_best) * 100
  Formula: Slippage_Venda% = ((Bid_best - Preco_Medio_Executado) / Bid_best) * 100

---

5. GRÁFICO DE TELEMETRIA DINÂMICA

- Mid-Price Line (Azul): Trajetória do preço de equilíbrio instantâneo amostragem a cada validação de ledger.
- EMA 9 (Linha Dourada Tracejada): Média Móvel Exponencial de 9 períodos com fator de suavização k = 2 / (9 + 1) = 0,2.
  Formula: EMA_t = (Mid_Price_t * 0.2) + (EMA_{t-1} * 0.8)
- VWAP Line (Roxa): Curva de referência do preço médio ponderado real das agressões da sessão.

---

6. TAPE READER & WHALE TRACKER (TIME & SALES)

- Processamento de Liquidação Real: Inspeciona o objeto `meta.AffectedNodes` das transações validadas, extraindo a movimentação efetiva de saldos para classificar a agressão (`COMPRA` ou `VENDA`).

- Whale Tracker: Ordens com valor total igual ou superior a $1.500 RLUSD recebem a etiqueta `WHALE`, ganham destaque visual na tabela e acionam o sinal sonoro via Web Audio API.
EOF