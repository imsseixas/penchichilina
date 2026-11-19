# Pechinchilina 🐭💊

Busca o seu remédio em várias farmácias online ao mesmo tempo e mostra onde está mais barato — inclusive considerando promoções do tipo "leve 3 pague 2" e "% off na 2ª unidade".

## Como rodar

Requer Node.js 18+ (sem dependências para instalar).

```bash
npm start
# abra http://localhost:3000
```

Para desenvolvimento com recarregamento automático: `npm run dev`. Testes: `npm test`.

Variáveis opcionais: `PORT` (padrão 3000) e `HOST` (padrão 127.0.0.1; use `0.0.0.0` para acessar pelo celular na mesma rede).

## O que ele faz

- **Busca em paralelo em 12 farmácias** e mostra os resultados conforme cada uma responde (streaming).
- **Agrupa o mesmo produto pelo código de barras (EAN)**, então você vê lado a lado o preço do *mesmo* item em cada loja.
- **Calcula o preço efetivo das promoções**: "leve 3 pague 2", "leve 2 e pague R$ 6,49 cada", "60% off na 2ª unidade" viram preço por unidade.
- **Preço por comprimido/ml**, para comparar embalagens de tamanhos diferentes.
- **Filtros**: genérico/referência/similar, dosagem, embalagem, só promoções, só produtos em 2+ farmácias, por farmácia.
- **Histórico de preços**: cada busca grava o menor preço de cada loja por dia em `data/history.json`; o app avisa quando o preço atual é o menor já visto.
- **Entrega no seu CEP**: informe o CEP e, para cada oferta, o app simula o carrinho na loja e mostra se ela entrega, o frete, o prazo, a opção mais rápida e a retirada grátis em loja (com distância). Quem não atende fica oculto e o ranking passa a comparar **preço + frete**. Frete acima de R$ 100 conta como "não atende na prática".
- Autocomplete, buscas recentes e link compartilhável (`?q=losartana 50mg`). O CEP fica salvo só no seu navegador e não vai no link.

## Farmácias

Drogaria São Paulo, Drogarias Pacheco, Pague Menos, Extrafarma, Drogaria Venancio, São João, Drogal, Farmácia Indiana, Preço Popular, Drogaria Rosário, Drogaria Catarinense e Consulta Remédios.

Todas usam a plataforma VTEX, cuja API de catálogo é pública. Para adicionar outra loja VTEX, basta incluir uma linha em [src/stores.js](src/stores.js).

**Não incluídas:** Drogasil, Droga Raia, Panvel e Araujo bloqueiam requisições automatizadas (proteção Akamai). Incluí-las exigiria um navegador headless (ex.: Playwright).

## Estrutura

```
server.js          servidor HTTP (estático + API + streaming SSE), cache de 10 min
src/stores.js      lista de farmácias
src/vtex.js        cliente VTEX: busca inteligente com fallback para a clássica
src/parse.js       dosagem, quantidade, tipo, relevância, cálculo de promoções
src/shipping.js    verificação de entrega/frete/retirada por CEP (simulação de carrinho)
src/history.js     histórico de preços por EAN
public/            interface (HTML/CSS/JS puro)
test/              testes do parser
```

## Avisos

- Sem CEP, os preços são **sem frete**. Com CEP, o frete mostrado é para **1 unidade**; levando mais itens (ou atingindo o valor de frete grátis da loja) ele pode cair. Confira na loja antes de comprar.
- Uso pessoal. Respeite os termos de uso das lojas.
- Siga sempre a orientação do seu médico ou farmacêutico ao trocar de marca ou genérico.
