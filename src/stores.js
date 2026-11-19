// Farmácias consultadas. Todas rodam na plataforma VTEX, que expõe uma API
// pública de catálogo. Drogasil, Droga Raia, Panvel e Araujo bloqueiam
// requisições automatizadas (Akamai) e por isso não estão aqui.
export const STORES = [
  { id: 'dsp', name: 'Drogaria São Paulo', base: 'https://www.drogariasaopaulo.com.br', color: '#e30613' },
  { id: 'pacheco', name: 'Drogarias Pacheco', base: 'https://www.drogariaspacheco.com.br', color: '#0055a5' },
  { id: 'paguemenos', name: 'Pague Menos', base: 'https://www.paguemenos.com.br', color: '#d7282f' },
  { id: 'extrafarma', name: 'Extrafarma', base: 'https://www.extrafarma.com.br', color: '#00843d' },
  { id: 'venancio', name: 'Drogaria Venancio', base: 'https://www.drogariavenancio.com.br', color: '#00539b' },
  { id: 'saojoao', name: 'São João', base: 'https://www.saojoaofarmacias.com.br', color: '#e2001a' },
  { id: 'drogal', name: 'Drogal', base: 'https://www.drogal.com.br', color: '#f39200' },
  { id: 'indiana', name: 'Farmácia Indiana', base: 'https://www.farmaciaindiana.com.br', color: '#1d4f91' },
  { id: 'precopopular', name: 'Preço Popular', base: 'https://www.precopopular.com.br', color: '#ffcc00' },
  { id: 'rosario', name: 'Drogaria Rosário', base: 'https://www.drogariarosario.com.br', color: '#c8102e' },
  { id: 'catarinense', name: 'Drogaria Catarinense', base: 'https://www.drogariacatarinense.com.br', color: '#008c45' },
  { id: 'consultaremedios', name: 'Consulta Remédios', base: 'https://consultaremedios.com.br', color: '#00a0df' },
];

export const STORE_BY_ID = Object.fromEntries(STORES.map((s) => [s.id, s]));
