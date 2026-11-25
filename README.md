# Pechinchilina 🐭💊

Busca o seu remédio em várias farmácias online ao mesmo tempo e mostra onde está mais barato — inclusive considerando promoções do tipo "leve 3 pague 2" e "% off na 2ª unidade".

## Como rodar

Requer Node.js 18+ (sem dependências para instalar).

```bash
npm start
# abra http://localhost:3000
```

Para desenvolvimento com recarregamento automático: `npm run dev`. Testes: `npm test`.

Variáveis opcionais:

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | 3000 | porta do servidor |
| `HOST` | 127.0.0.1 | use `0.0.0.0` para acessar pelo celular na mesma rede |
| `NTFY_TOPIC` | — | tópico do ntfy.sh para receber alertas no celular (use um nome difícil de adivinhar) |
| `DEALS_INTERVAL_HOURS` | 6 | intervalo da varredura de Superofertas |
| `WATCH_INTERVAL_HOURS` | 6 | intervalo de verificação dos monitorados |

Dados ficam em `data/` (histórico, superofertas, monitorados e alertas).

### Na Vercel

A Vercel não mantém um servidor ligado: cada requisição acorda uma instância, que pode ser desligada logo depois, e só `/tmp` aceita escrita (e é apagado quando a instância some). Por isso, lá:

- **Superofertas**: a varredura roda dentro da requisição de `/api/deals` (cerca de 30 s na primeira vez) e a CDN da Vercel guarda a resposta por 6 h. Passado esse prazo, entrega a versão anterior na hora e refaz a varredura por trás. O botão "atualizar agora" some. A cada novo deploy o cache zera e o primeiro visitante espera a varredura.
- **Histórico de preços e 🔔 Monitorados** ficam em `/tmp`: funcionam, mas se perdem quando a instância é recriada, e a verificação a cada 6 h não roda. Para valer de verdade, precisam de um banco (ex.: Upstash Redis ou Vercel Blob) e de um Cron Job.
- A função precisa poder rodar por até ~1 min (o padrão atual da Vercel, com Fluid compute, é 300 s).

## O que ele faz

- **Busca em paralelo em 11 farmácias** e mostra os resultados conforme cada uma responde (streaming).
- **Agrupa o mesmo produto pelo código de barras (EAN)**, então você vê lado a lado o preço do *mesmo* item em cada loja.
- **Calcula o preço efetivo das promoções**: "leve 3 pague 2", "leve 2 e pague R$ 6,49 cada", "60% off na 2ª unidade" viram preço por unidade.
- **Preço por comprimido/ml**, para comparar embalagens de tamanhos diferentes.
- **Filtros**: genérico/referência/similar, **fabricante** (laboratório), dosagem, embalagem, só promoções, só produtos em 2+ farmácias, por farmácia.
- **Fabricante padronizado**: cada farmácia escreve o laboratório de um jeito ("NEO QUIMICA", "Prati", "Ranbaxy - Genérico", "Merck Sharp & Dohme (MSD)"); o app junta as grafias e usa o campo "Fabricante" da loja quando existe. Marca comercial (Novalgina, Aradois) não conta como fabricante. Se as farmácias discordam sobre o mesmo produto, vale a maioria.
- **Histórico de preços**: cada busca grava o menor preço de cada loja por dia em `data/history.json`; o app avisa quando o preço atual é o menor já visto.
- **Entrega no seu CEP**: informe o CEP e, para cada oferta, o app simula o carrinho na loja e mostra se ela entrega, o frete, o prazo, a opção mais rápida e a retirada grátis em loja (com distância). Quem não atende fica oculto e o ranking passa a comparar **preço + frete**. Frete acima de R$ 100 conta como "não atende na prática".
- **📍 Perto de mim** (ir à farmácia): com a localização do navegador (ou o CEP, se você não permitir), busca **só nas farmácias com loja física perto** (raio de 1 a 10 km). Para cada produto mostra a loja mais perto **com o produto em estoque**, de preferência aberta agora, com endereço, distância, horário e link do mapa, e destaca **"Vá primeiro"**: a mais barata com loja aberta. A localização é arredondada (~100 m), fica só no seu navegador e é enviada às farmácias apenas para achar as lojas. Desligar o botão apaga a localização salva.
- **🔥 Superofertas** (página inicial): o servidor varre a cada 6 h suplementos, higiene/beleza, bebê e remédios sem receita em todas as farmácias e destaca produtos com preço muito abaixo do que as **outras farmácias cobram pelo mesmo item** (mediana por código de barras). O "de/por" da loja, frequentemente inflado, só conta quando não há comparação, e com peso menor.
- **🛒 Carrinho** (painel à direita): simula o pedido inteiro em cada farmácia, com promoções de quantidade aplicadas pela própria loja e um frete único, e mostra a melhor farmácia única e se vale dividir entre duas.
- **🔔 Monitorados**: verifica os produtos a cada 6 h e gera alerta quando o preço atinge seu alvo, bate o menor já visto ou cai 10%+. Alertas aparecem no app, como notificação do navegador e, opcionalmente, no celular via [ntfy](https://ntfy.sh) (`NTFY_TOPIC`).
- Autocomplete, buscas recentes e link compartilhável (`?q=losartana 50mg`). O CEP fica salvo só no seu navegador e não vai no link.

## Farmácias

Drogaria São Paulo, Drogarias Pacheco, Pague Menos, Extrafarma, Drogaria Venancio, São João, Drogal, Farmácia Indiana, Preço Popular, Drogaria Rosário e Drogaria Catarinense.

Todas usam a plataforma VTEX, cuja API de catálogo é pública. Para adicionar outra loja VTEX, basta incluir uma linha em [src/stores.js](src/stores.js).

**Não incluídas:** Drogasil, Droga Raia, Panvel e Araujo bloqueiam requisições automatizadas (proteção Akamai). Incluí-las exigiria um navegador headless (ex.: Playwright).

## Estrutura

```
server.js          servidor HTTP (estático + API + streaming SSE), cache de 10 min
src/stores.js      lista de farmácias
src/vtex.js        cliente VTEX: busca inteligente com fallback para a clássica
src/parse.js       dosagem, quantidade, tipo, relevância, cálculo de promoções
src/shipping.js    verificação de entrega/frete/retirada por CEP (simulação de carrinho)
src/nearby.js      lojas físicas perto do CEP/localização (pontos de retirada da VTEX)
src/deals.js       varredura e pontuação das Superofertas
src/cart.js        otimizador de carrinho (uma loja x duas lojas)
src/watch.js       monitoramento periódico e alertas
src/catalog.js     busca por código de barras (EAN) com cache
src/history.js     histórico de preços por EAN
public/            interface (HTML/CSS/JS puro); near.js = localização e horários,
                   icons.js = ícones SVG (Lucide), fonts/ = Plus Jakarta Sans (OFL)
test/              testes (node --test)
```

## Avisos

- Sem CEP, os preços são **sem frete**. Com CEP, o frete mostrado é para **1 unidade**; levando mais itens (ou atingindo o valor de frete grátis da loja) ele pode cair. Confira na loja antes de comprar.
- **Perto de mim:** só Drogaria São Paulo/Pacheco e Pague Menos/Extrafarma informam onde ficam suas lojas (Pacheco e Extrafarma usam as lojas da DSP e da Pague Menos para retirada). O preço mostrado é o do site para **comprar online e retirar**; no balcão pode ser diferente. A localização do navegador só funciona em `localhost` ou `https` (acessando pelo IP da rede, o app usa o CEP).
- As farmácias limitam o número de consultas (HTTP 429). O app tenta de novo com espera; se mesmo assim falhar, a farmácia aparece como "não deu para verificar".
- Uso pessoal. Respeite os termos de uso das lojas.
- Siga sempre a orientação do seu médico ou farmacêutico ao trocar de marca ou genérico.
