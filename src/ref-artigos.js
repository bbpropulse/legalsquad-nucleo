// Leitura de artigo pelo servidor (plano de arquitetura da Legis, seção 8b, decisão 2).
//
// O índice local não guarda o texto de artigo (regra 1) e o texto vive no servidor (regra 2). O motor
// acha o diploma e o rótulo pelo índice e pede aqui só os artigos de que precisa, até 20 por chamada
// (`POST /v1/ref/artigos`), agrupando os pedidos da mesma consulta. A conferência é em camadas, e
// qualquer falha recusa o artigo (regra 7: nunca aprovar sem conferência):
//
//   1. assinatura do artigo pelo ANEL DE ARTIGOS (`srv-2026-11`, SEPARADO do anel de produção que
//      assina índice, diferença e pacote: ver `ref-leitor/artigo-assinado.js`);
//   2. sha256 do texto recebido igual ao `sha256` assinado;
//   3. `sha256_texto` do diploma igual ao do índice LOCAL, que a curadoria assinou (anel de produção).
//
// Cache: o artigo conferido fica em `textos/` por sha256 do texto e, ao lado, o registro assinado
// (`textos/art-<sha256 de id + sha256_texto do diploma>.json`). Quem lê do cache refaz as três
// conferências, sem rede: adulterar o arquivo, ou o diploma mudar no índice, invalida o registro.
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chamarServidor } from './ref-http.js';
import { ANEL_ARTIGOS, verificarArtigoAssinado } from './ref-leitor/artigo-assinado.js';
import { CHAVES_PUBLICAS_PRODUCAO } from './acervo-config.js';
import { caminhosDaReferencia } from './indice-sync.js';
import { temArtigo } from './busca/enxuto.js';

export const ARTIGOS_POR_CHAMADA = 20;

const miolo = (pem) => createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

/** Nenhum kid e nenhuma chave pode estar nos dois anéis (o de artigos e o de produção). Lança erro com a causa. */
export function garantirAneisSeparados(anelDeArtigos, anelDeProducao = CHAVES_PUBLICAS_PRODUCAO) {
  const producao = new Set(Object.values(anelDeProducao).map(miolo));
  for (const [kid, pem] of Object.entries(anelDeArtigos)) {
    if (Object.hasOwn(anelDeProducao, kid)) throw new Error(`o kid ${kid} está no anel de artigos e no de produção: os anéis têm de ser separados`);
    if (producao.has(miolo(pem))) throw new Error(`a chave do kid ${kid} (anel de artigos) é a mesma de uma chave do anel de produção: os anéis têm de ser separados`);
  }
}

/**
 * O anel de artigos da execução: `ANEL_ARTIGOS` e nada mais. Só dentro da suíte de testes
 * (`NODE_TEST_CONTEXT`, que um processo de produção nunca tem) a variável `LEGALSQUAD_ANEL_ARTIGOS_TESTE`
 * (JSON {kid: pem}) acrescenta a chave do servidor falso; mesmo assim, chave que também esteja no anel de
 * produção é recusada.
 */
export function anelDeArtigosDoAmbiente(env = process.env) {
  const anel = { ...ANEL_ARTIGOS };
  if (env.NODE_TEST_CONTEXT && env.LEGALSQUAD_ANEL_ARTIGOS_TESTE) {
    try { Object.assign(anel, JSON.parse(env.LEGALSQUAD_ANEL_ARTIGOS_TESTE)); } catch { /* variável de teste ilegível: ignorada */ }
  }
  garantirAneisSeparados(anel);
  return anel;
}

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function arquivoDoArtigoNoCache(raiz, id, shaDiploma) {
  return join(caminhosDaReferencia(raiz).textos, `art-${sha(`${id}\0${shaDiploma}`)}.json`);
}

/** O artigo conferido que está no cache, ou null. Refaz as conferências: o arquivo não é confiado. */
export function lerArtigoDoCache(raiz, id, shaDiploma, { anel = ANEL_ARTIGOS } = {}) {
  if (!shaDiploma) return null;
  try {
    const a = JSON.parse(readFileSync(arquivoDoArtigoNoCache(raiz, id, shaDiploma), 'utf8'));
    if (a?.id !== id) return null;
    const v = verificarArtigoAssinado(a, { anel, sha256Diploma: shaDiploma, docId: id.split('#')[0] });
    return v.ok ? a : null;
  } catch {
    return null;
  }
}

function gravarArtigoNoCache(raiz, artigo, shaDiploma) {
  const destino = arquivoDoArtigoNoCache(raiz, artigo.id, shaDiploma);
  mkdirSync(caminhosDaReferencia(raiz).textos, { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(artigo), 'utf8');
  renameSync(tmp, destino);
  return existsSync(destino);
}

const recusa = (id, etapa, motivo, extra = {}) => ({ ok: false, id, etapa, motivo, ...extra });

/**
 * Lê e confere artigos. `pedidos`: ids de dispositivo (`fed:dl:3689:1941#art-312`). `ref` dá o índice
 * local (`ref.doc`), o servidor e o cache. Devolve um resultado por pedido, na ordem, sem repetição de
 * chamada: `{ ok: true, id, texto, sha256, rotulo, selo, ..., fonte: 'cache'|'servidor' }` ou
 * `{ ok: false, id, etapa, motivo, indisponivel? }`.
 */
export async function lerArtigosConferidos(ref, pedidos, { anel = ref.anelArtigos || ANEL_ARTIGOS, porChamada = ARTIGOS_POR_CHAMADA } = {}) {
  const ids = [...new Set(pedidos.map(String))];
  const saida = new Map();
  const pendentes = [];
  for (const id of ids) {
    const [docId, caminho] = id.split('#');
    const doc = caminho ? ref.doc(docId) : null;
    if (!caminho) { saida.set(id, recusa(id, 'forma', 'o id não é de um dispositivo (falta #caminho)')); continue; }
    if (!doc?.sha256_texto) { saida.set(id, recusa(id, 'indice', `${docId} não está no índice desta máquina (ou sem hash do texto): rode \`legalsquad ref sync\`; sem o hash do diploma assinado pela curadoria o artigo não pode ser conferido`)); continue; }
    // O índice sabe QUAIS artigos o diploma tem (`rotulos_artigos`, sem texto): artigo fora da lista nem vai ao servidor.
    if (temArtigo(doc.rotulos_artigos, caminho) === false) { saida.set(id, recusa(id, 'indice', `o diploma ${docId} não tem este artigo (${caminho}) na lista de artigos do índice desta máquina`)); continue; }
    const doCache = lerArtigoDoCache(ref.raiz, id, doc.sha256_texto, { anel });
    if (doCache) { saida.set(id, { ok: true, ...doCache, fonte: 'cache', conferido_por: 'assinatura do servidor, hash do diploma do índice' }); continue; }
    pendentes.push({ id, docId, shaDiploma: doc.sha256_texto });
  }
  for (let i = 0; i < pendentes.length; i += porChamada) {
    const lote = pendentes.slice(i, i + porChamada);
    const r = await chamarServidor(ref.servidorUrl, '/v1/ref/artigos', { ...ref.http, method: 'POST', body: { pedidos: lote.map((p) => ({ id: p.id })) } });
    if (!r.ok) {
      const motivo = r.indisponivel ? r.motivo : `HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ''}`;
      for (const p of lote) saida.set(p.id, recusa(p.id, 'servidor', `não consegui ler o artigo no servidor (${motivo}); sem a leitura conferida o artigo não vale`, { indisponivel: Boolean(r.indisponivel) || r.status === 503 }));
      continue;
    }
    const resultados = Array.isArray(r.json?.resultados) ? r.json.resultados : [];
    for (const p of lote) {
      const a = resultados.find((x) => `${x.doc_id}#${x.pedido}` === p.id || x.id === p.id);
      if (!a) { saida.set(p.id, recusa(p.id, 'servidor', 'o servidor não respondeu este artigo')); continue; }
      if (a.status !== 'encontrado') { saida.set(p.id, recusa(p.id, a.status || 'servidor', a.status === 'artigo_nao_encontrado' ? 'o artigo não está no texto do diploma no servidor' : `o servidor respondeu ${a.status}`, { status: a.status })); continue; }
      if (a.id !== p.id) { saida.set(p.id, recusa(p.id, 'documento', 'o servidor devolveu outro dispositivo no lugar do pedido')); continue; }
      const v = verificarArtigoAssinado(a, { anel, sha256Diploma: p.shaDiploma, docId: p.docId });
      if (!v.ok) { saida.set(p.id, recusa(p.id, v.etapa, v.motivo)); continue; }
      gravarArtigoNoCache(ref.raiz, a, p.shaDiploma);
      saida.set(p.id, { ok: true, ...a, fonte: 'servidor', conferido_por: 'assinatura do servidor, hash do diploma do índice' });
    }
  }
  return pedidos.map((id) => saida.get(String(id)));
}
