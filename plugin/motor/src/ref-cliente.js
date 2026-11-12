// Cliente do servidor de referência e o comando `legalsquad ref` (plano do servidor de referência,
// seções 3.3, 3.4, 3.5 e 3.9 B, D e E).
//
// O que os agentes veem do servidor é isto, em respostas curtas, e nunca o índice inteiro (o
// `_index.yaml` de 24 MB era o que gastava tokens):
//
//   ref resolver "art. 312 do CPP"     id canônico, situação, selo e as linhas do dispositivo
//   ref ler <id> [--filhos]            o texto conferido (do cache por hash, ou do servidor)
//   ref buscar "<tema>" [--area ...]   lista curta de ids, uma linha cada (local por FTS5; com rede,
//                                      também a busca do servidor)
//   ref vinculos <id>                  o que altera, interpreta ou controla o dispositivo
//   ref mapa <área>                    o mapa da área, gerado do índice, em poucos KB
//   ref revalidar <run>                o que mudou no servidor desde a conferência do run (3.9 D)
//   ref conferir --entrada <json>      o lote do Citation Gate: uma requisição com todas as citações
//   ref sync | ref estado              o índice desta máquina
//
// Ordem de cada consulta: índice local (milissegundos, sem servidor e sem modelo) › cache de texto
// por sha256 › servidor. O texto que vem do servidor só é aceito se o sha256 bater com o do índice
// (ou, sem índice, com o que o próprio servidor declara, e então a resposta diz isso).
//
// Privacidade (seção 3.7 E): sai da máquina a CITAÇÃO ("art. 312 do CPP") ou o TEMA da busca, nunca
// o texto da peça nem dado do caso. Busca com cara de dado de caso (número de processo, CPF, CNPJ,
// e-mail) fica só no índice local, e a resposta diz por quê.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AVISO_SERVIDOR_DESLIGADO, SERVIDOR_URL_PADRAO, resolverConfigDeAcervo, servidorDeReferenciaLigado } from './acervo-config.js';
import {
  CAMADA_NACIONAL, FORMATO_INDICE, arquivoDaCamada, caminhosDaReferencia, carregarSqlite, descreverSyncDoIndice, ehIndiceEnxuto,
  instalacaoDaReferencia, lerEstadoDaReferencia, listarCamadasDoServidor, raizDaReferencia, resumoDaReferencia, sincronizarIndice, verificarAssinaturaDoManifesto,
} from './indice-sync.js';
import { chamarServidor } from './ref-http.js';
import { lerCitacao, normalizarBusca, rotuloDeCaminho, sha256, trechoConfere } from './ref-citacao.js';
import { anelDeArtigosDoAmbiente, lerArtigosConferidos } from './ref-artigos.js';
import { situacaoQueImpede, videControleNoTexto } from './ref-gate.js';
import { prepararBancoEnxuto, temArtigo } from './busca/enxuto.js';
import { expandirSiglas, lerNr, lerSumulaRegional, resolverNr, resolverSumulaAtomizada } from './busca/citacao-orgaos.js';
import { buscarTudoNoIndice } from './busca/index.js';

export const LIMITE_DO_LOTE = 200;
const RE_SHA = /^[a-f0-9]{64}$/;
const RE_ID = /^[a-z0-9][a-z0-9:._/#-]{2,300}$/;

// ── texto por hash ─────────────────────────────────────────────────────────

export function lerTextoDoCache(raiz, sha) {
  if (!RE_SHA.test(String(sha || ''))) return null;
  const arquivo = join(caminhosDaReferencia(raiz).textos, sha);
  try {
    const texto = readFileSync(arquivo, 'utf8');
    return sha256(texto) === sha ? texto : null;
  } catch {
    return null;
  }
}

/** Grava `textos/<sha256>` só se o hash do texto for o declarado: o cache é endereçado pelo conteúdo. */
export function gravarTextoNoCache(raiz, sha, texto) {
  if (!RE_SHA.test(String(sha || '')) || typeof texto !== 'string' || sha256(texto) !== sha) return false;
  const { textos } = caminhosDaReferencia(raiz);
  const destino = join(textos, sha);
  if (existsSync(destino)) return true;
  mkdirSync(textos, { recursive: true });
  const tmp = join(textos, `.${sha}.${process.pid}.tmp`);
  writeFileSync(tmp, texto, 'utf8');
  renameSync(tmp, destino);
  return true;
}

// ── a situação de uma citação resolvida ────────────────────────────────────

export { situacaoQueImpede, videControleNoTexto };

/** Os ancestrais do dispositivo (`doc#art-3-b/par-1` → o próprio e `doc#art-3-b`): a nota do artigo vale para as partes. */
function idsDaCadeia(id) {
  const [doc, caminho] = String(id || '').split('#');
  if (!caminho) return [id];
  const partes = caminho.split('/');
  const lista = [];
  for (let i = partes.length; i >= 1; i--) lista.push(`${doc}#${partes.slice(0, i).join('/')}`);
  return lista;
}

const FONTES_DO_VINCULO = { nota_oficial: 'nota "Vide" no texto oficial', planalto_nota: 'nota "Vide" na cópia do Planalto', bnp_legislacao: 'indexação do STF no BNP, com o artigo citado na ação' };

/**
 * O campo `fonte` do vínculo de controle concentrado, como o servidor grava desde 02/11/2026:
 * `planalto_nota; decisao=MERITO; cautelar=NAO`. Devolve `{ fonte, decisao, cautelar }`.
 */
export function lerFonteDoVinculo(bruto) {
  const partes = String(bruto || '').split(';').map((s) => s.trim()).filter(Boolean);
  const out = { fonte: null, decisao: null, cautelar: null };
  for (const p of partes) {
    const m = /^([a-z_]+)\s*=\s*(.+)$/i.exec(p);
    if (!m) { if (!out.fonte) out.fonte = p; continue; }
    const k = m[1].toLowerCase();
    if (k === 'decisao') out.decisao = m[2].trim();
    else if (k === 'cautelar') out.cautelar = /^s(im)?$/i.test(m[2].trim()) ? true : /^n(ao|ão)?$/i.test(m[2].trim()) ? false : null;
  }
  return out;
}

/** A linha do alerta, igual em todo lugar que o mostra (`ref resolver`, `ref vinculos`, pacote do verificador). */
export function descreverAlerta(a) {
  const det = [a.decisao ? `decisão registrada: ${a.decisao}` : null, a.cautelar === true ? 'com cautelar' : a.cautelar === false ? 'sem cautelar' : null, a.data || null].filter(Boolean).join('; ');
  const onde = a.no_dispositivo ? ` (no ${a.no_dispositivo})` : '';
  return `${a.rotulo || a.acao}${onde}${det ? ` (${det})` : ''}`;
}

/** Busca com cara de dado de caso não sai da máquina (seção 3.7 E do plano). */
export function pareceDadoDoCaso(q) {
  const t = String(q || '');
  return /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/.test(t) // número único do CNJ
    || /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(t) // CPF
    || /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/.test(t) // CNPJ
    || /[\w.+-]+@[\w-]+\.[\w.]+/.test(t); // e-mail
}

/** O que a área do motor (`criminal`, `direito-do-trabalho`) é no campo `area` do índice ("Direito Penal"). */
export function termosDaArea(area) {
  const s = normalizarBusca(String(area || '').replace(/[-_]+/g, ' ')).replace(/\bdireitos?\b/g, '').replace(/\b(?:d[aeo]s?)\b/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const sinonimos = { criminal: ['penal'], civel: ['civil'], trabalhista: ['trabalho'], tributaria: ['tributario'], previdenciaria: ['previdenciario'], consumerista: ['consumidor'], familia: ['civil'] };
  return [...new Set([s, ...(sinonimos[s] || [])])];
}

// ── a referência aberta ────────────────────────────────────────────────────

/**
 * Abre o índice local (as camadas que estão nesta máquina) e prepara as chamadas ao servidor.
 * Sem índice, tudo funciona pelo servidor, e as respostas dizem isso (`fonte`).
 */
export async function abrirReferencia({ raiz = raizDaReferencia(), servidorUrl, license, anel = {}, anelArtigos = anelDeArtigosDoAmbiente(), fetchImpl, esperas, esperar } = {}) {
  const estado = lerEstadoDaReferencia(raiz);
  const { indice } = caminhosDaReferencia(raiz);
  const bancos = [];
  // Só camadas do formato enxuto (legalsquad-indice/2): o formato antigo é descartado pelo `ref sync`, nunca lido.
  const camadas = Object.keys(estado.camadas || {}).filter((c) => estado.camadas[c]?.versao && !estado.camadas[c].nao_publicada && estado.camadas[c].formato === FORMATO_INDICE);
  if (camadas.length) {
    const { DatabaseSync } = await carregarSqlite();
    // A nacional primeiro: é a que responde quando duas camadas tiverem o mesmo apelido.
    for (const camada of [CAMADA_NACIONAL, ...camadas.filter((c) => c !== CAMADA_NACIONAL)]) {
      if (!camadas.includes(camada)) continue;
      const arquivo = join(indice, arquivoDaCamada(camada));
      if (!existsSync(arquivo)) continue;
      try {
        const banco = { camada, versao: estado.camadas[camada].versao, db: new DatabaseSync(arquivo, { readOnly: true }) };
        if (!ehIndiceEnxuto(banco.db)) { banco.db.close(); continue; }
        prepararBancoEnxuto(banco.db);
        bancos.push(banco);
      } catch { /* camada ilegível: o servidor responde por ela */ }
    }
  }
  const http = { license, instalacao: instalacaoDaReferencia(raiz, license), ...(fetchImpl ? { fetchImpl } : {}), ...(esperas ? { esperas } : {}), ...(esperar ? { esperar } : {}) };
  return new Referencia({ raiz, servidorUrl, http, estado, bancos, anel, anelArtigos });
}

export class Referencia {
  constructor({ raiz, servidorUrl, http, estado, bancos, anel = {}, anelArtigos = anelDeArtigosDoAmbiente() }) {
    this.raiz = raiz;
    this.servidorUrl = servidorUrl;
    this.http = http;
    this.estado = estado;
    this.bancos = bancos;
    // O anel confere o recibo assinado da conferência (3.9 E), quando o servidor o mandar.
    this.anel = anel;
    // O anel de ARTIGOS é outro: a chave que assina artigo não assina índice, diferença nem pacote.
    this.anelArtigos = anelArtigos;
  }

  get temIndice() {
    return this.bancos.length > 0;
  }

  get versoes() {
    return Object.fromEntries(this.bancos.map((b) => [b.camada, b.versao]));
  }

  fechar() {
    for (const b of this.bancos) { try { b.db.close(); } catch { /* já fechado */ } }
    this.bancos = [];
  }

  /** O documento pelo id, na primeira camada que o tem. */
  doc(id) {
    for (const b of this.bancos) {
      const d = b.db.prepare('SELECT * FROM doc WHERE id = ?').get(id);
      if (d) return { ...d, camada: b.camada };
    }
    return null;
  }

  /**
   * O dispositivo (`doc#art-312`) pela lista de artigos do documento: o índice sabe QUAIS artigos o diploma tem
   * (`rotulos_artigos`), não o texto nem o hash do artigo (regra 1 do plano da Legis). O texto vem do servidor
   * (`ref ler`, `POST /v1/ref/artigos`) e é conferido pela assinatura e pelo hash do diploma.
   */
  dispositivo(id) {
    const [docId, caminho] = String(id).split('#');
    if (!caminho) return null;
    for (const b of this.bancos) {
      const d = b.db.prepare('SELECT id, selo, rotulos_artigos FROM doc WHERE id = ?').get(docId);
      if (d && temArtigo(d.rotulos_artigos, caminho)) return { id, doc_id: docId, caminho, rotulo: rotuloDeCaminho(caminho), sha256: null, situacao: null, selo: d.selo, selo_motivo: null, trecho: null, camada: b.camada };
    }
    return null;
  }

  /**
   * O texto do diploma: cache por sha256 e, faltando, o servidor. Só vale se o hash do texto for o
   * `sha256_texto` que o índice guarda (regra 2 do plano). `{ texto, fonte }` ou `{ texto: null, motivo }`.
   */
  async textoDoDocumento(doc) {
    const sha = doc.sha256_texto;
    const doCache = sha ? lerTextoDoCache(this.raiz, sha) : null;
    if (doCache !== null) return { texto: doCache, fonte: 'cache' };
    const r = await chamarServidor(this.servidorUrl, `/v1/ref/texto/${encodeURIComponent(doc.id)}`, this.http);
    if (r.indisponivel) return { texto: null, motivo: r.motivo };
    if (!r.ok) return { texto: null, motivo: `HTTP ${r.status}` };
    const texto = typeof r.json?.texto === 'string' ? r.json.texto : null;
    if (texto === null) return { texto: null, motivo: 'resposta sem texto' };
    if (sha && sha256(texto) !== sha) return { texto: null, motivo: 'o texto do servidor não bate com o hash do índice: recusado' };
    gravarTextoNoCache(this.raiz, sha256(texto), texto);
    return { texto, fonte: 'servidor' };
  }

  /** Artigos conferidos (assinatura do servidor pelo anel de artigos, sha256 do texto e sha256 do diploma igual ao do índice): ver `src/ref-artigos.js`. */
  async lerArtigos(ids) {
    return lerArtigosConferidos(this, ids);
  }

  /** O sha256 que o índice guarda para um id de DOCUMENTO (o do texto inteiro, assinado pela curadoria), ou null. */
  shaDoIndice(id) {
    if (String(id).includes('#')) return null; // o índice enxuto guarda o hash do documento, não o do artigo
    return this.doc(id)?.sha256_texto || null;
  }

  /** Formas que o leitor do servidor não conhece: NR-N e súmula regional atomizada (src/busca/citacao-orgaos.js). */
  resolverFormasDoMotor(texto) {
    const base = { texto, fonte: 'indice-local', versao_indice: this.versoes[CAMADA_NACIONAL] || null };
    const nr = !/\bart(?:igo)?s?\b.*\b(?:cf|cc|cp|cpp|cpc|clt|ctn|cdc)\b/i.test(texto) ? lerNr(texto) : null;
    if (nr) {
      if (!this.temIndice) return null;
      const r = resolverNr(this.bancos, nr.numero);
      if (!r.escolhido) return { ...base, status: 'nao_encontrada', tipo: 'norma_regulamentadora', chave: `nr ${nr.numero}`, motivo: `NR-${nr.numero} não está no índice desta máquina (camada reg-mte: rode \`ref sync\` num projeto da área trabalhista)` };
      const d = this.doc(r.escolhido);
      return { ...base, status: 'encontrada', tipo: 'norma_regulamentadora', chave: `nr ${nr.numero}`, doc_id: d.id, id: d.id, titulo: d.titulo, vigencia: d.vigencia, selo: d.selo, selo_motivo: d.selo_motivo, url_oficial: d.url_oficial, conferido_em: d.conferido_em, sha256: d.sha256_texto, camada: d.camada, trecho_indice: d.trecho || null, ...(r.outras_versoes.length ? { outras_versoes: r.outras_versoes } : {}), ...(nr.item ? { observacao: `item ${nr.item}: use \`ref ler ${d.id} --filhos\` ou \`ref buscar\` para o texto do item` } : {}) };
    }
    const sr = lerSumulaRegional(texto);
    if (sr && this.temIndice) {
      const chave = `sumula ${sr.tribunal} ${sr.numero}`;
      for (const b of this.bancos) if (b.db.prepare('SELECT 1 FROM apelido WHERE forma = ? LIMIT 1').get(chave)) return null; // o leitor resolve o que o índice já tem pela chave
      const achados = resolverSumulaAtomizada(this, sr);
      if (achados.length === 1) { const d = achados[0]; return { ...base, status: 'encontrada', tipo: 'sumula', chave, doc_id: d.id, id: d.id, titulo: d.titulo, vigencia: d.vigencia, selo: d.selo, url_oficial: d.url_oficial, conferido_em: d.conferido_em, sha256: d.sha256_texto, camada: d.camada, alias: 'item atomizado da súmula regional', trecho_indice: null }; }
      if (achados.length > 1) return { ...base, status: 'ambigua', tipo: 'sumula', chave, candidatos: achados.map((d) => ({ id: d.id, titulo: d.titulo, selo: d.selo })) };
    }
    return null;
  }

  /** Resolve a citação no índice local, sem servidor e sem modelo. Os mesmos `status` do `conferir`. */
  resolverLocal(texto) {
    const extra = this.resolverFormasDoMotor(texto);
    if (extra) return extra;
    const l = lerCitacao(expandirSiglas(texto));
    const base = { texto, fonte: 'indice-local', versao_indice: this.versoes[CAMADA_NACIONAL] || null };
    if (!l.reconhecida) return { ...base, status: 'nao_reconhecida' };
    // Norma estadual sem a UF (leitor do servidor, `exige_uf`): nunca a lei federal do mesmo número. É
    // ambígua, com as UFs que o índice desta máquina tem; as outras camadas o servidor lista.
    if (l.exige_uf) {
      const motivo = `${l.motivo || 'norma estadual citada sem a UF'}; diga a UF (ex.: "(SP)" ou "do Estado de São Paulo")`;
      const candidatas = l.chaves_candidatas || [];
      if (!this.temIndice) return { ...base, status: 'sem_indice', tipo: l.tipo, exige_uf: true, chaves_candidatas: candidatas, caminho: l.caminho, motivo };
      const ids = new Set();
      for (const k of candidatas) for (const b of this.bancos) for (const a of b.db.prepare('SELECT doc_id FROM apelido WHERE forma = ?').all(k)) ids.add(a.doc_id);
      const candidatos = [...ids].map((id) => this.doc(id)).filter(Boolean).map((d) => ({ id: d.id, titulo: d.titulo, orgao: d.orgao, uf: d.uf ?? null, selo: d.selo }));
      return { ...base, status: 'ambigua', tipo: l.tipo, exige_uf: true, chave: null, candidatos, motivo: candidatos.length ? motivo : `${motivo}; nenhuma UF baixada nesta máquina tem essa norma (o servidor lista as da base)` };
    }
    if (!this.temIndice) return { ...base, status: 'sem_indice', tipo: l.tipo, chave: l.chaves[0], caminho: l.caminho };
    let forma = l.chaves[0];
    let docs = [];
    for (const k of l.chaves) {
      const ids = new Set();
      for (const b of this.bancos) for (const a of b.db.prepare('SELECT doc_id FROM apelido WHERE forma = ?').all(k)) ids.add(a.doc_id);
      if (ids.size) { forma = k; docs = [...ids]; break; }
    }
    base.chave = forma;
    if (!docs.length) return { ...base, status: 'nao_encontrada', tipo: l.tipo, motivo: 'nenhum documento com essa forma de citar no índice desta máquina (pode estar numa camada que não foi baixada: o servidor confere)' };
    if (docs.length > 1) return { ...base, status: 'ambigua', tipo: l.tipo, candidatos: docs.map((id) => this.doc(id)).filter(Boolean).map((d) => ({ id: d.id, titulo: d.titulo, orgao: d.orgao, selo: d.selo })) };
    const d = this.doc(docs[0]);
    const out = { ...base, status: 'encontrada', tipo: l.tipo, doc_id: d.id, titulo: d.titulo, vigencia: d.vigencia, selo: d.selo, selo_motivo: d.selo_motivo, url_oficial: d.url_oficial, conferido_em: d.conferido_em, sha256: d.sha256_texto, camada: d.camada };
    if (!l.caminho) return { ...out, id: d.id, trecho_indice: d.trecho || null };
    const idDisp = `${d.id}#${l.caminho}`;
    const disp = this.dispositivo(idDisp);
    if (!disp) return { ...out, status: 'dispositivo_nao_encontrado', id: idDisp, rotulo: rotuloDeCaminho(l.caminho), motivo: 'o documento existe, mas o dispositivo citado não está no texto conferido' };
    return { ...out, id: disp.id, rotulo: disp.rotulo, situacao: disp.situacao, selo: disp.selo, selo_motivo: disp.selo_motivo || d.selo_motivo, sha256: null, trecho_indice: null, sha256_documento: d.sha256_texto, texto_pelo: 'servidor (POST /v1/ref/artigos), conferido pela assinatura e pelo hash do diploma do índice' };
  }

  /** O lote ao servidor: uma requisição por até 200 citações. `{ indisponivel, motivo }` quando não fecha. */
  async conferir(citacoes, { incluirTexto = false } = {}) {
    const resultados = [];
    let versao = null;
    let recibos = [];
    for (let i = 0; i < citacoes.length; i += LIMITE_DO_LOTE) {
      const lote = citacoes.slice(i, i + LIMITE_DO_LOTE);
      const r = await chamarServidor(this.servidorUrl, '/v1/ref/conferir', { ...this.http, method: 'POST', body: { citacoes: lote, ...(incluirTexto ? { incluir_texto: true } : {}) } });
      if (!r.ok) return { indisponivel: true, motivo: r.motivo || `HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ''}`, status: r.status || null };
      if (!Array.isArray(r.json?.resultados) || r.json.resultados.length !== lote.length) return { indisponivel: true, motivo: 'resposta do servidor sem um resultado por citação' };
      versao = r.json.versao_indice || versao;
      resultados.push(...r.json.resultados);
      if (r.json.recibo) recibos.push(r.json.recibo);
    }
    recibos = recibos.map((rc) => ({ ...rc, verificacao: rc?.manifesto ? verificarAssinaturaDoManifesto(rc.manifesto, rc.assinatura, this.anel || {}) : { ok: false, motivo: 'recibo sem manifesto' } }));
    return { indisponivel: false, versao_indice: versao, resultados, recibos };
  }

  /** Resolve: índice local; o que ele não fecha, o servidor confere. */
  async resolver(texto) {
    const local = this.resolverLocal(texto);
    // O dispositivo que o índice local não tem vai ao servidor também: o índice pode estar defasado.
    // Estadual sem UF que nenhuma camada local tem: o servidor lista as UFs da base.
    const semCandidataLocal = local.exige_uf && !(local.candidatos || []).length;
    // O índice enxuto guarda o selo do DOCUMENTO: num diploma divergente só em alguns artigos (a Lei
    // das S.A., divergente nos arts. 31, 118, 240 e 300), o selo do artigo citado está no servidor.
    // Medido em 06/11/2026: "art. 158 da Lei 6.404" saía "selo divergente" pelo índice, e o Gate, que
    // pergunta ao servidor, o dava conferido. Servidor fora do ar: fica o selo do índice (o mais
    // severo), com o aviso.
    const artigoEmDocDivergente = local.status === 'encontrada' && String(local.id || '').includes('#') && local.selo && local.selo !== 'conferido';
    if (['encontrada', 'ambigua', 'nao_reconhecida'].includes(local.status) && !semCandidataLocal && !artigoEmDocDivergente) {
      return { ...local, alertas: local.id ? this.controleConcentrado(local.id) : [] };
    }
    if (artigoEmDocDivergente) {
      const s = await this.conferir([expandirSiglas(texto)], { incluirTexto: true });
      const r = s.indisponivel ? null : s.resultados[0];
      if (!r || r.status !== 'encontrada' || r.id !== local.id) {
        return { ...local, alertas: this.controleConcentrado(local.id), aviso_selo: `selo do documento no índice local (${local.selo}); o selo do artigo vem do servidor${s.indisponivel ? `, que não respondeu (${s.motivo})` : ''}` };
      }
      if (r.texto_dispositivo && r.sha256 && sha256(r.texto_dispositivo) === r.sha256) gravarTextoNoCache(this.raiz, r.sha256, r.texto_dispositivo);
      return { ...r, fonte: 'servidor', versao_indice: s.versao_indice, selo_do_documento: local.selo, alertas: this.controleConcentrado(r.id, { texto: r.texto_dispositivo }) };
    }
    const s = await this.conferir([expandirSiglas(texto)], { incluirTexto: true });
    if (s.indisponivel) return { ...local, servidor: { indisponivel: true, motivo: s.motivo } };
    const r = s.resultados[0];
    if (r.texto_dispositivo && r.sha256 && sha256(r.texto_dispositivo) === r.sha256) gravarTextoNoCache(this.raiz, r.sha256, r.texto_dispositivo);
    return { ...r, fonte: 'servidor', versao_indice: s.versao_indice, alertas: r.id ? this.controleConcentrado(r.id, { texto: r.texto_dispositivo }) : [] };
  }

  /**
   * O texto conferido de um id.
   *
   * - DISPOSITIVO (`doc#art-312`): pelo servidor, `POST /v1/ref/artigos`, com a conferência em camadas
   *   (assinatura pelo anel de artigos, sha256 do texto, sha256 do diploma igual ao do índice local); o
   *   resultado inclui os filhos (parágrafos, incisos) do dispositivo. Falha de rede ou qualquer camada
   *   que falhe devolve `ok: false`: nunca texto sem conferência (regra 7 do plano).
   * - DOCUMENTO (`stj:sumula:7`): cache por sha256 do índice e, faltando, o servidor; o texto só entra
   *   se o sha256 bater com o `sha256_texto` do índice (ou, sem índice, com o que o servidor declara).
   */
  async ler(id, { filhos = false } = {}) {
    if (!RE_ID.test(String(id || ''))) return { ok: false, motivo: `id fora do formato: ${id}` };
    if (String(id).includes('#')) {
      const [r] = await this.lerArtigos([id]);
      if (!r.ok) return { ok: false, id, ...(r.indisponivel ? { indisponivel: true } : {}), etapa: r.etapa, motivo: r.motivo };
      const doc = this.doc(String(id).split('#')[0]);
      return {
        ok: true, id, texto: r.texto, sha256: r.sha256, fonte: r.fonte, conferido_por: r.conferido_por, rotulo: r.rotulo || null, situacao: r.situacao || null, selo: r.selo || null,
        assinado_por: r.signing_kid, versao_servidor: r.versao || null,
        documento: { id: doc?.id, titulo: doc?.titulo || r.titulo_documento, url_oficial: r.url_oficial || doc?.url_oficial, conferido_em: r.conferido_em || doc?.conferido_em, vigencia: r.vigencia || doc?.vigencia, selo: doc?.selo },
      };
    }
    if (filhos) return { ok: false, motivo: 'documento inteiro não tem "filhos": peça o artigo (`ref ler <id>#art-N`), que já vem com os parágrafos e incisos, conferido pela assinatura do servidor' };
    const doIndice = this.shaDoIndice(id);
    if (doIndice) {
      const texto = lerTextoDoCache(this.raiz, doIndice);
      if (texto !== null) return { ok: true, id, texto, sha256: doIndice, fonte: 'cache', conferido_por: 'indice' };
    }
    const r = await chamarServidor(this.servidorUrl, `/v1/ref/texto/${encodeURIComponent(id)}`, this.http);
    if (r.indisponivel) return { ok: false, indisponivel: true, motivo: r.motivo };
    if (!r.ok) return { ok: false, motivo: r.status === 404 ? `${id} não está no servidor de referência` : `HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ''}` };
    const texto = typeof r.json?.texto === 'string' ? r.json.texto : null;
    const declarado = r.json?.sha256 || r.json?.sha256_texto || null;
    if (texto === null) return { ok: false, motivo: 'resposta sem texto' };
    const calculado = sha256(texto);
    if (doIndice && calculado !== doIndice) return { ok: false, motivo: `o texto que o servidor mandou não bate com o hash do índice desta máquina (${doIndice.slice(0, 12)}…): recusado; rode \`legalsquad ref sync\` e tente de novo` };
    if (!doIndice && declarado && calculado !== declarado) return { ok: false, motivo: 'o texto que o servidor mandou não bate com o hash que ele mesmo declara: recusado' };
    gravarTextoNoCache(this.raiz, calculado, texto);
    const doc = r.json.documento || r.json;
    return {
      ok: true, id, texto, sha256: calculado, fonte: 'servidor', conferido_por: doIndice ? 'indice' : 'servidor',
      selo: r.json.selo || null, situacao: r.json.situacao || null, rotulo: r.json.rotulo || null,
      documento: { id: doc.id, titulo: doc.titulo, url_oficial: doc.url_oficial, conferido_em: doc.conferido_em, vigencia: doc.vigencia, selo: doc.selo },
    };
  }

  /** Busca por palavra no índice local (FTS5, sem acento, ranking bm25), com os filtros do servidor. */
  buscarLocal(q, { area = null, tribunal = null, tipo = null, limite = 10 } = {}) {
    const termos = normalizarBusca(q).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 12);
    if (!termos.length || !this.temIndice) return [];
    const consulta = termos.map((t) => `"${t}"*`).join(' ');
    const areas = termosDaArea(area);
    const saida = [];
    for (const b of this.bancos) {
      const filtros = [];
      const params = [consulta];
      if (tipo) { filtros.push('(lower(d.tipo) = lower(?) OR lower(d.subtipo) = lower(?))'); params.push(tipo, tipo); }
      if (tribunal) { filtros.push('lower(d.orgao) = lower(?)'); params.push(tribunal); }
      if (areas.length) { filtros.push(`(${areas.map(() => "lower(d.area) LIKE '%' || ? || '%'").join(' OR ')})`); params.push(...areas); }
      params.push(limite);
      let linhas;
      try {
        linhas = b.db.prepare(`SELECT d.id, d.tipo, d.subtipo, d.orgao, d.titulo, d.ementa, d.selo, d.vigencia, d.area, d.url_oficial, bm25(busca) AS r
            FROM busca JOIN doc d ON d.rid = busca.rowid WHERE busca MATCH ? ${filtros.length ? `AND ${filtros.join(' AND ')}` : ''} ORDER BY r LIMIT ?`).all(...params);
      } catch { linhas = []; }
      for (const l of linhas) saida.push({ ...l, camada: b.camada, fonte: 'indice-local' });
    }
    return saida.sort((a, b) => a.r - b.r).slice(0, limite);
  }

  /** Legislação e jurisprudência do índice local, em duas listas (ver src/busca/index.js). */
  async buscarTudo(q, opcoes = {}) {
    return buscarTudoNoIndice(this, q, opcoes);
  }

  /** Local e, com rede, o servidor; o que só o servidor achou vem marcado. */
  async buscar(q, opcoes = {}) {
    const limite = Math.min(50, Math.max(1, Number(opcoes.limite) || 10));
    const local = this.buscarLocal(q, { ...opcoes, limite });
    const avisos = [];
    if (pareceDadoDoCaso(q)) {
      avisos.push('a busca tem número de processo, CPF, CNPJ ou e-mail: ficou só no índice desta máquina (dado do caso não sai para o servidor); busque pelo tema jurídico');
      return { resultados: local, avisos };
    }
    const params = new URLSearchParams({ q: String(q).slice(0, 300), limite: String(limite) });
    if (opcoes.tipo) params.set('tipo', opcoes.tipo);
    if (opcoes.tribunal) params.set('orgao', opcoes.tribunal);
    const area = termosDaArea(opcoes.area)[termosDaArea(opcoes.area).length - 1];
    if (area) params.set('area', area);
    const r = await chamarServidor(this.servidorUrl, `/v1/ref/buscar?${params}`, this.http);
    if (!r.ok) {
      avisos.push(r.indisponivel ? `servidor indisponível: só o índice local respondeu (${r.motivo})` : `servidor recusou a busca (HTTP ${r.status})`);
      return { resultados: local, avisos };
    }
    const vistos = new Set(local.map((x) => x.id));
    const doServidor = (r.json?.resultados || []).filter((x) => x && x.id && !vistos.has(x.id)).map((x) => ({ ...x, fonte: 'servidor' }));
    return { resultados: [...local, ...doServidor].slice(0, limite), avisos };
  }

  /** Vínculos do índice: o que sai do id (e das partes dele) e o que chega nele, com o título do outro lado. */
  vinculos(id) {
    const saindo = [];
    const chegando = [];
    for (const b of this.bancos) {
      for (const v of b.db.prepare('SELECT origem, destino, tipo, fonte FROM vinculo WHERE origem = ? OR origem LIKE ? LIMIT 400').all(id, `${id}#%`)) saindo.push(v);
      for (const v of b.db.prepare('SELECT origem, destino, tipo, fonte FROM vinculo WHERE destino = ? LIMIT 400').all(id)) chegando.push(v);
    }
    const titulo = (x) => this.doc(String(x).split('#')[0])?.titulo || null;
    return {
      id,
      saindo: saindo.map((v) => ({ ...v, titulo_destino: titulo(v.destino) })),
      chegando: chegando.map((v) => ({ ...v, titulo_origem: titulo(v.origem) })),
      controle: this.controleConcentrado(id),
      controle_citado: this.controleCitado(id),
    };
  }

  /**
   * Alerta de controle concentrado (3.9 B): as ações do STF ligadas por `vide_controle` ao dispositivo,
   * ao artigo dele (acima) ou a uma parte dele (abaixo: a ADI sobre o § 5º do artigo citado inteiro),
   * mais a nota "Vide ADI" no texto conferido. A decisão e a cautelar vêm do próprio vínculo (o
   * `fonte` que o servidor grava desde 02/11/2026); sem elas, a decisão do documento da ação. O
   * vínculo fraco (`controle_citado`: a indexação do BNP lista o artigo, a ação não o cita) nunca vira
   * alerta: vai em `controleCitado`. O EFEITO (suspensão, inconstitucionalidade, interpretação
   * conforme) não vem do servidor: a resposta manda conferir na ação.
   */
  controleConcentrado(id, { texto = null } = {}) {
    const acoes = new Map();
    const guardar = (destino, origem, fonteBruta) => {
      const atual = acoes.get(destino);
      const lido = lerFonteDoVinculo(fonteBruta);
      // A ligação mais próxima do dispositivo citado vale; a decisão do vínculo, se algum a tiver.
      if (!atual) acoes.set(destino, { origem, ...lido });
      else if (!atual.decisao && lido.decisao) acoes.set(destino, { ...atual, decisao: lido.decisao, cautelar: lido.cautelar });
    };
    for (const b of this.bancos) {
      for (const origem of idsDaCadeia(id)) {
        for (const v of b.db.prepare("SELECT destino, fonte FROM vinculo WHERE origem = ? AND tipo = 'vide_controle'").all(origem)) guardar(v.destino, origem, v.fonte);
      }
      // Abaixo só de dispositivo (a ADI sobre o § 5º do art. 28-A citado inteiro); do documento inteiro, não.
      if (String(id).includes('#')) {
        const prefixo = `${id}/`;
        for (const v of b.db.prepare("SELECT origem, destino, fonte FROM vinculo WHERE origem >= ? AND origem < ? AND tipo = 'vide_controle' ORDER BY origem").all(prefixo, `${prefixo}\uffff`)) guardar(v.destino, v.origem, v.fonte);
      }
    }
    for (const acao of videControleNoTexto(texto)) if (!acoes.has(acao)) acoes.set(acao, { origem: id, fonte: 'nota_oficial', decisao: null, cautelar: null });
    return [...acoes.entries()].map(([acao, v]) => {
      const d = this.doc(acao);
      const decisao = v.decisao || (d?.vigencia ? String(d.vigencia).replace(/^decisão:\s*/i, '') : null);
      const a = {
        acao, rotulo: d?.titulo || acao.split(':').slice(1).join(' ').toUpperCase(), origem: v.origem,
        ...(v.origem !== id && !idsDaCadeia(id).includes(v.origem) ? { no_dispositivo: v.origem.split('#')[1] } : {}),
        decisao, cautelar: v.cautelar, fonte: v.fonte, fonte_descricao: FONTES_DO_VINCULO[v.fonte] || v.fonte || null,
        data: d?.data || null, url_oficial: d?.url_oficial || null, efeito: null,
      };
      return { ...a, descricao: descreverAlerta(a) };
    });
  }

  /** Ações que só MENCIONAM o dispositivo (`controle_citado`): sinal fraco, nunca alerta. */
  controleCitado(id) {
    const out = new Map();
    for (const b of this.bancos) {
      for (const origem of idsDaCadeia(id)) {
        for (const v of b.db.prepare("SELECT destino, fonte FROM vinculo WHERE origem = ? AND tipo = 'controle_citado'").all(origem)) if (!out.has(v.destino)) out.set(v.destino, { acao: v.destino, origem, ...lerFonteDoVinculo(v.fonte), rotulo: this.doc(v.destino)?.titulo || v.destino });
      }
    }
    return [...out.values()];
  }

  /** O mapa da área, gerado do índice: convenções de id, diplomas com apelido consagrado, súmulas e temas da área. */
  mapa(area, { limite = 25 } = {}) {
    const termos = termosDaArea(area);
    const out = { area, versoes: this.versoes, diplomas: [], sumulas: [], temas: [], outros: [] };
    if (!this.temIndice) return out;
    const nacional = this.bancos.find((b) => b.camada === CAMADA_NACIONAL) || this.bancos[0];
    // Diplomas com apelido curto (CP, CPC, CLT...): a forma que a peça usa e o id que o índice resolve.
    const curtos = nacional.db.prepare("SELECT a.forma, a.doc_id, d.titulo FROM apelido a JOIN doc d ON d.id = a.doc_id WHERE d.tipo = 'norma' AND length(a.forma) <= 6 AND a.forma NOT LIKE '% %' ORDER BY a.forma").all();
    const porDoc = new Map();
    for (const c of curtos) if (!porDoc.has(c.doc_id)) porDoc.set(c.doc_id, { id: c.doc_id, siglas: [], titulo: c.titulo });
    for (const c of curtos) porDoc.get(c.doc_id).siglas.push(c.forma.toUpperCase());
    out.diplomas = [...porDoc.values()];
    if (!termos.length) return out;
    const filtro = `(${termos.map(() => "lower(d.area) LIKE '%' || ? || '%'").join(' OR ')})`;
    // A centralidade, até a fase 4 trazer o uso real (3.9 I), é quantos vínculos chegam ao documento.
    const consulta = (onde) => nacional.db.prepare(`SELECT d.id, d.titulo, d.subtipo, d.orgao, d.vigencia, d.selo, d.trecho,
        (SELECT count(*) FROM vinculo v WHERE v.destino = d.id) AS ligacoes
        FROM doc d WHERE ${onde} AND ${filtro} ORDER BY ligacoes DESC, CAST(d.numero AS INTEGER) LIMIT ?`).all(...termos, limite);
    out.sumulas = consulta("d.subtipo IN ('Súmula', 'Súmula vinculante')");
    out.temas = consulta("d.subtipo IN ('Tema repetitivo', 'Tema de repercussão geral')");
    // Os temas da carga de 01/11/2026 não trazem área (o campo vem vazio do BNP e dos dados abertos):
    // sem eles, o mapa cai na busca por palavra da área na tese e na questão, e diz isso.
    if (!out.temas.length) {
      out.temas = termos.flatMap((t) => {
        try {
          return nacional.db.prepare(`SELECT d.id, d.titulo, d.subtipo, d.orgao, d.vigencia, d.selo, d.trecho, 0 AS ligacoes FROM busca JOIN doc d ON d.rid = busca.rowid
            WHERE busca MATCH ? AND d.subtipo IN ('Tema repetitivo', 'Tema de repercussão geral') ORDER BY bm25(busca) LIMIT ?`).all(`"${t}"*`, limite);
        } catch { return []; }
      }).filter((x, i, todos) => todos.findIndex((y) => y.id === x.id) === i).slice(0, limite);
      if (out.temas.length) out.temas_por = 'palavra';
    }
    out.outros = consulta("d.tipo = 'jurisprudencia' AND d.subtipo NOT IN ('Súmula', 'Súmula vinculante', 'Tema repetitivo', 'Tema de repercussão geral', 'Jurisprudência selecionada')").slice(0, 10);
    return out;
  }
}

// ── pré-busca (3.3) ────────────────────────────────────────────────────────

/**
 * Pré-busca do intake (plano, seção 3.3): os textos mais prováveis da área (as súmulas e os temas do
 * mapa, pela centralidade do índice) descem de uma vez para o cache, e a pesquisa e a redação os
 * acham locais. Só o que ainda não está no cache; até `limite` textos, quatro por vez.
 */
export async function prebuscar(ref, area, { limite = 40 } = {}) {
  const mapa = ref.mapa(area, { limite });
  const ids = [...mapa.sumulas, ...mapa.temas].map((x) => x.id).slice(0, limite);
  const pendentes = ids.filter((id) => lerTextoDoCache(ref.raiz, ref.shaDoIndice(id)) === null);
  const resultado = { area, candidatos: ids.length, ja_no_cache: ids.length - pendentes.length, baixados: 0, falhas: [] };
  for (let i = 0; i < pendentes.length; i += 4) {
    const lidos = await Promise.all(pendentes.slice(i, i + 4).map((id) => ref.ler(id).then((r) => ({ id, r }))));
    for (const { id, r } of lidos) {
      if (r.ok) resultado.baixados += 1;
      else resultado.falhas.push({ id, motivo: r.motivo });
    }
    if (lidos.some(({ r }) => r.indisponivel)) break;
  }
  return resultado;
}

// ── o lote do Citation Gate ────────────────────────────────────────────────

/**
 * Confere o lote do Citation Gate: cada entrada `{ chave, texto, trecho? }` (o texto canônico que o
 * gate monta da citação do extrator). Uma requisição ao servidor com todas, o índice local por
 * baixo (quando o servidor não fecha) e o texto conferido de cada uma, para o pacote do
 * verificador. Devolve por entrada: `servidor` (o resultado do conferir), `local` (a resolução no
 * índice), `fonte` de quem decidiu, `texto_oficial` (com o sha256 conferido) e `alertas` de
 * controle concentrado. Nada aqui decide VERIFICADA: quem classifica é o gate (`src/ref-gate.js`).
 */
/**
 * O servidor em que o gate confia sem o índice: o embarcado, ou o que o operador pôs no ambiente
 * (`LEGALSQUAD_SERVIDOR_URL`). O de um `acervo.json` de projeto (que pode vir numa pasta
 * copiada de alguém) só vale quando o índice assinado desta máquina confirma o mesmo id e o mesmo
 * sha256: a resposta do `conferir` não é assinada, e redirecionar o servidor não pode aprovar citação.
 */
export function servidorConfiavel(url, env = process.env) {
  const limpa = String(url || '').replace(/\/+$/, '');
  return limpa === SERVIDOR_URL_PADRAO || (typeof env.LEGALSQUAD_SERVIDOR_URL === 'string' && limpa === env.LEGALSQUAD_SERVIDOR_URL.trim().replace(/\/+$/, ''));
}

export async function conferirLoteDoGate(ref, entradas, { comTexto = true, textosPorId = 30 } = {}) {
  const confiavel = servidorConfiavel(ref.servidorUrl);
  const locais = entradas.map((e) => ref.resolverLocal(e.texto));
  const servidor = entradas.length ? await ref.conferir(entradas.map((e) => (e.trecho ? { texto: e.texto, trecho: e.trecho } : e.texto)), { incluirTexto: comTexto }) : { indisponivel: false, resultados: [] };
  // Dispositivos (artigo, parágrafo, inciso): o texto vem do servidor em UMA chamada por até 20 artigos
  // (`POST /v1/ref/artigos`) e só vale conferido: assinatura pelo anel de artigos, sha256 do texto e sha256
  // do diploma igual ao do índice assinado. Falha de rede ou de qualquer camada deixa o artigo SEM
  // conferência, e o gate não aprova (regra 7 do plano da Legis).
  const idsDeArtigo = [];
  for (const i of entradas.keys()) {
    const r = (servidor.indisponivel ? null : servidor.resultados[i]) || locais[i];
    if (r?.status === 'encontrada' && String(r.id || '').includes('#') && !idsDeArtigo.includes(r.id)) idsDeArtigo.push(r.id);
  }
  const artigos = new Map();
  if (idsDeArtigo.length) (await ref.lerArtigos(idsDeArtigo)).forEach((a, k) => artigos.set(idsDeArtigo[k], a));
  const itens = entradas.map((e, i) => {
    const sBruto = servidor.indisponivel ? null : servidor.resultados[i];
    const l = locais[i];
    const idDoItem = (sBruto?.status === 'encontrada' ? sBruto.id : null) || (l.status === 'encontrada' ? l.id : null);
    const art = idDoItem && String(idDoItem).includes('#') ? artigos.get(idDoItem) : null;
    // O trecho entre aspas é comparado com o texto CONFERIDO do artigo, não com o que o `conferir` (sem assinatura) disse.
    const comparar = (texto) => { const c = trechoConfere(e.trecho, texto); return c === null ? 'curto_demais' : c ? 'confere' : 'nao_confere'; };
    const s = sBruto && art?.ok && e.trecho && sBruto.status === 'encontrada' ? { ...sBruto, trecho: comparar(art.texto) } : sBruto;
    // Trecho citado contra o texto do cache/conferido, quando o índice resolveu e o servidor não respondeu.
    if (!s && l.status === 'encontrada' && e.trecho) {
      if (art?.ok) l.trecho = comparar(art.texto);
      else {
        const texto = lerTextoDoCache(ref.raiz, l.sha256);
        l.trecho = texto === null ? 'sem_texto_local' : comparar(texto);
      }
    }
    let textoOficial = null;
    if (art?.ok) textoOficial = { texto: art.texto, sha256: art.sha256, de: art.id };
    const id = s?.id || l.id || null;
    const alertas = id ? ref.controleConcentrado(id, { texto: art?.ok ? art.texto : null }) : [];
    const divergeDoLocal = s && l.status === 'encontrada' && s.status === 'encontrada' && l.id === s.id && l.sha256 && s.sha256 && l.sha256 !== s.sha256;
    // O índice enxuto não tem o hash do artigo; o que o confirma é o hash do DIPLOMA (assinado pela curadoria): o servidor e o índice têm de falar do mesmo diploma.
    const confirmadoPeloIndice = Boolean(s && l.status === 'encontrada' && s.status === 'encontrada' && l.id === s.id && l.selo === s.selo
      && (l.sha256 ? l.sha256 === s.sha256 : Boolean(l.sha256_documento) && art?.ok === true && art.sha256_texto === l.sha256_documento));
    return {
      chave: e.chave,
      texto: e.texto,
      ...(e.trecho ? { trecho: e.trecho } : {}),
      servidor: s,
      local: l.status === 'sem_indice' ? null : l,
      fonte: s ? 'servidor' : l.status === 'encontrada' ? 'indice-local' : null,
      ...(art ? { artigo: art.ok ? { ok: true, id: art.id, fonte: art.fonte, assinado_por: art.signing_kid, sha256: art.sha256, sha256_diploma: art.sha256_texto } : { ok: false, etapa: art.etapa, motivo: art.motivo, indisponivel: Boolean(art.indisponivel) } } : {}),
      ...(s && !confiavel ? { servidor_confiavel: false, confirmado_pelo_indice: confirmadoPeloIndice } : {}),
      ...(divergeDoLocal ? { aviso: 'o índice desta máquina tem outro hash para este dispositivo (defasado): vale o do servidor; rode `legalsquad ref sync`' } : {}),
      texto_oficial: textoOficial,
      alertas,
    };
  });
  // O texto do documento inteiro (súmula, tema) para a fidelidade: do cache, ou do servidor por id.
  if (comTexto) {
    const pedir = [];
    for (const [i, it] of itens.entries()) {
      if (it.texto_oficial || entradas[i].sem_texto) continue;
      const r = it.servidor || it.local;
      if (!r || r.status !== 'encontrada' || !r.id || String(r.id).includes('#')) continue;
      const cache = lerTextoDoCache(ref.raiz, r.sha256);
      if (cache !== null) { it.texto_oficial = { texto: cache, sha256: r.sha256, de: r.id }; continue; }
      if (!servidor.indisponivel && pedir.length < textosPorId) pedir.push({ it, r });
    }
    // Seis por vez: medido contra o servidor público em 01/11/2026, os textos de súmula e tema
    // pedidos um a um levavam o lote de 40 citações de 0,4 s para 4,2 s.
    for (let i = 0; i < pedir.length; i += 6) {
      await Promise.all(pedir.slice(i, i + 6).map(async ({ it, r }) => {
        const lido = await ref.ler(r.id);
        if (lido.ok && (!r.sha256 || lido.sha256 === r.sha256)) it.texto_oficial = { texto: lido.texto, sha256: lido.sha256, de: r.id };
      }));
    }
  }
  return {
    servidor: servidor.indisponivel ? { indisponivel: true, motivo: servidor.motivo } : { indisponivel: false, versao_indice: servidor.versao_indice },
    // Quando o índice local foi conferido com o servidor pela última vez: é o que deixa (ou não) o
    // gate fechar lei pelo índice com o servidor fora do ar.
    indice_local: ref.temIndice ? { versoes: ref.versoes, verificado_em: ref.estado?.camadas?.[CAMADA_NACIONAL]?.verificado_em || null } : null,
    recibos: servidor.recibos || [],
    itens,
  };
}

// ── revalidar (3.9 D) ──────────────────────────────────────────────────────

/** As conferências gravadas por um run: `citacoes/conferencia-servidor*.json` e os manifestos `*.citation-gate.json`. */
export function conferenciasDoRun(alvo) {
  const caminho = resolve(alvo);
  const arquivos = [];
  const visitar = (dir, fundo = 0) => {
    let itens;
    try { itens = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of itens) {
      const p = join(dir, e.name);
      if (e.isDirectory() && fundo < 4 && !['fontes', '_tmp', 'node_modules'].includes(e.name)) visitar(p, fundo + 1);
      else if (e.isFile() && (/^conferencia-servidor.*\.json$/.test(e.name) || /\.citation-gate\.json$/.test(e.name))) arquivos.push(p);
    }
  };
  if (existsSync(caminho) && statSync(caminho).isFile()) arquivos.push(caminho);
  else visitar(caminho);
  const porTexto = new Map();
  for (const arquivo of arquivos) {
    let dado;
    try { dado = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { continue; }
    if (Array.isArray(dado?.itens)) {
      for (const it of dado.itens) {
        // O lote do `ref conferir` traz `servidor`/`local`; o arquivo do gate (`citacoes-servidor`), `resultado`.
        const s = it.servidor || it.resultado || it.local;
        if (!it.texto || !s || s.status !== 'encontrada') continue;
        porTexto.set(it.texto, { texto: it.texto, id: s.id, sha256: s.sha256, selo: s.selo, situacao: s.situacao || null, vigencia: s.vigencia || null, conferido_no_run_em: dado.gerado_em || null, arquivo });
      }
    }
    for (const c of Array.isArray(dado?.citations) ? dado.citations : []) {
      for (const it of c?.conferencia?.itens || []) {
        if (!it.texto || !it.id) continue;
        if (!porTexto.has(it.texto)) porTexto.set(it.texto, { texto: it.texto, id: it.id, sha256: it.sha256, selo: it.selo, situacao: it.situacao || null, vigencia: it.vigencia || null, conferido_no_run_em: c.consulted_at || null, arquivo });
      }
    }
  }
  return { arquivos, citacoes: [...porTexto.values()] };
}

/**
 * Conferência de véspera (3.9 D): pergunta ao servidor, num lote, o que mudou desde a conferência
 * do run, e devolve só as diferenças (hash, selo, situação, vigência, id). Sem modelo.
 */
export async function revalidarRun(ref, alvo) {
  const { arquivos, citacoes } = conferenciasDoRun(alvo);
  if (!citacoes.length) return { ok: false, motivo: arquivos.length ? 'as conferências do run não têm citação resolvida no servidor para comparar' : `nenhuma conferência do servidor encontrada em ${alvo} (conferencia-servidor*.json ou *.citation-gate.json com \`conferencia\`)`, arquivos };
  const s = await ref.conferir(citacoes.map((c) => c.texto));
  if (s.indisponivel) return { ok: false, indisponivel: true, motivo: s.motivo, arquivos, total: citacoes.length };
  const mudancas = [];
  s.resultados.forEach((r, i) => {
    const antes = citacoes[i];
    const diferencas = [];
    if (r.status !== 'encontrada') diferencas.push(`não resolve mais (${r.status})`);
    else {
      if (r.id !== antes.id) diferencas.push(`outro id: ${antes.id} → ${r.id}`);
      if (antes.sha256 && r.sha256 !== antes.sha256) diferencas.push('o texto conferido mudou (sha256 diferente)');
      if (antes.selo && r.selo !== antes.selo) diferencas.push(`selo: ${antes.selo} → ${r.selo}`);
      if ((antes.situacao || null) !== (r.situacao || null) && (antes.situacao || r.situacao)) diferencas.push(`situação: ${antes.situacao || '?'} → ${r.situacao || '?'}`);
      if ((antes.vigencia || null) !== (r.vigencia || null) && (antes.vigencia || r.vigencia)) diferencas.push(`vigência: ${antes.vigencia || '?'} → ${r.vigencia || '?'}`);
      const impede = situacaoQueImpede(r);
      if (impede && !situacaoQueImpede(antes)) diferencas.push(`agora ${impede}: não fundamente nele`);
    }
    if (diferencas.length) mudancas.push({ texto: antes.texto, id: antes.id, conferido_no_run_em: antes.conferido_no_run_em, diferencas });
  });
  return { ok: true, total: citacoes.length, mudaram: mudancas.length, mudancas, versao_indice: s.versao_indice, arquivos };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function imprimirJson(v) {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

const curto = (t, n = 160) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function linhaDaResolucao(r) {
  if (r.status === 'encontrada') {
    const impede = situacaoQueImpede(r);
    return [
      `${r.id} · ${r.rotulo ? `${r.rotulo} · ` : ''}${r.titulo}`,
      `selo ${r.selo}${r.selo_do_documento && r.selo_do_documento !== r.selo ? ` (do artigo; o documento é ${r.selo_do_documento} em outros artigos)` : ''}${impede ? ` · ${impede.toUpperCase()}` : r.situacao && r.situacao !== r.vigencia ? ` · ${r.situacao}` : ''} · vigência ${r.vigencia || '?'} · conferido em ${r.conferido_em || '?'} · ${r.fonte}`,
      r.aviso_selo ? `aviso: ${r.aviso_selo}` : null,
      r.texto_dispositivo || r.trecho_indice ? `> ${curto(r.texto_dispositivo || r.trecho_indice, 320)}` : null,
      r.url_oficial ? `fonte oficial: ${r.url_oficial}` : null,
      ...(r.alertas || []).map((a) => `ALERTA controle concentrado: ${a.descricao || descreverAlerta(a)}: confira o efeito na ação antes de fundamentar`),
    ].filter(Boolean).join('\n');
  }
  if (r.status === 'ambigua') return `ambígua (${r.chave}): ${r.candidatos.map((c) => `${c.id} (${c.orgao || c.titulo})`).join('; ')}; diga o tribunal ou o ano`;
  if (r.status === 'dispositivo_nao_encontrado') return `${r.id}: ${r.motivo}`;
  if (r.status === 'nao_reconhecida') return 'não reconheci uma citação nesse texto (escreva como na peça: "art. 312 do CPP", "Súmula 7/STJ", "Tema 1.000 do STJ")';
  return `${r.chave || r.texto}: ${r.motivo || r.status}${r.servidor?.indisponivel ? ` (servidor indisponível: ${r.servidor.motivo})` : ''}`;
}

async function referenciaDoProjeto(cwd, values = {}) {
  const config = resolverConfigDeAcervo(cwd);
  const raiz = values.raiz || raizDaReferencia();
  const ref = await abrirReferencia({ raiz, servidorUrl: config.servidorUrl, license: config.license, anel: config.chavesPublicas || {}, ...(values.fetchImpl ? { fetchImpl: values.fetchImpl } : {}), ...(values.esperas ? { esperas: values.esperas, esperar: values.esperar } : {}) });
  return { config, ref, raiz };
}

/**
 * Sincroniza o índice (o `acervo sync` e o `ref sync` chamam isto). Sem `camadas`, TODAS as que o servidor
 * publica (regra 4 do plano da Legis: cobertura completa); `camadas` só limita, para teste.
 */
export async function sincronizarIndiceDoProjeto(cwd, { raiz = raizDaReferencia(), log = () => {}, camadas = null, ...extra } = {}) {
  const config = resolverConfigDeAcervo(cwd);
  if (!config.ok) return { ok: false, motivo: config.motivo, camadas: [] };
  return sincronizarIndice({ servidorUrl: config.servidorUrl, license: config.license, anel: config.chavesPublicas, raiz, camadas, log, ...extra });
}

/** Linha curta de um resultado: id citável, título, selo, vigência e URL oficial. */
function linhaDoResultado(x) {
  const vig = x.vigencia || x.situacao;
  const partes = [x.id, x.titulo || x.processo || '', `selo ${x.selo || '?'}`, vig && vig !== 'vigente' ? vig : 'vigente'];
  if (x.fonte === 'servidor') partes.push('(servidor)');
  const linha = partes.filter((p) => p !== '').join(' · ');
  const texto = x.dispositivos?.[0]?.trecho || x.tese || x.trecho || x.ementa;
  return `${linha}${x.url_oficial ? ` · ${x.url_oficial}` : ''}${texto ? `\n  ${x.dispositivos?.[0] ? `${x.dispositivos[0].id.split('#')[1]}: ` : ''}${curto(texto)}` : ''}`;
}

function imprimirBusca(r, sub) {
  if (sub === 'buscar') {
    console.log(`# Legislação (${r.legislacao.length})`);
    for (const x of r.legislacao) console.log(linhaDoResultado(x));
    if (!r.legislacao.length && !r.so_o_numero) console.log('nada encontrado na legislação por essas palavras');
  }
  console.log(`# Jurisprudência (${r.jurisprudencia.length})`);
  for (const x of r.jurisprudencia) console.log(linhaDoResultado(x));
  // O julgado citado pelo número que não está no índice sai no resultado, não só no aviso.
  for (const a of (r.avisos || []).filter((x) => /não está no índice desta máquina/.test(x))) console.log(`(ausente) ${a}`);
  if (!r.jurisprudencia.length && !(r.ausentes || []).length) console.log('nada encontrado na jurisprudência por essas palavras (confira se o índice está completo: `ref estado`)');
  for (const a of r.avisos.filter((x) => !/não está no índice desta máquina/.test(x))) console.error(`  aviso: ${a}`);
}

/** A busca do `ref buscar|jurisprudencia`: índice local em duas listas e, com rede, o que só o servidor achou. */
export async function buscarNoProjeto(ref, q, { sub = 'buscar', values = {} } = {}) {
  const limite = Math.min(50, Math.max(1, Number(values.limit) || 10));
  // Busca única: uma chamada devolve legislação e jurisprudência sobre o mesmo índice; `ref jurisprudencia` só esconde a lista de legislação.
  // O diploma achado tem o texto lido do servidor (conferido pelo hash do índice) para achar o artigo certo, salvo `--so-local` ou dado do caso na consulta.
  const filtros = { area: values.area, tribunal: values.tribunal, tipo: values.tipo, uf: values.uf, vigente: values.vigente === true, situacao: values.situacao, relator: values.relator, desde: values.desde, limite, ...(sub === 'jurisprudencia' ? { so: 'juris' } : {}), ...(values['so-local'] === true || pareceDadoDoCaso(q) ? {} : { servidor: { refinar: true } }) };
  const local = await ref.buscarTudo(q, filtros);
  const out = { consulta: q, legislacao: sub === 'jurisprudencia' ? [] : local.legislacao, jurisprudencia: local.jurisprudencia, avisos: [...(local.avisos || [])] };
  // A consulta que é só o número de um julgado, súmula ou tema: o índice respondeu (achou, ou disse que
  // não tem); o servidor busca por palavra e devolveria outro documento no lugar.
  if (local.so_o_numero) return { ...out, so_o_numero: true, ausentes: local.ausentes || [] };
  if (pareceDadoDoCaso(q)) {
    out.avisos.push('a busca tem número de processo, CPF, CNPJ ou e-mail: ficou só no índice desta máquina (dado do caso não sai para o servidor); busque pelo tema jurídico');
    return out;
  }
  // Sem nada no índice local, ou para completar: o servidor, só com o tema.
  if (out.legislacao.length + out.jurisprudencia.length >= limite && ref.temIndice) return out;
  const params = new URLSearchParams({ q: String(q).slice(0, 300), limite: String(limite) });
  if (values.tipo) params.set('tipo', values.tipo);
  if (values.tribunal) params.set('orgao', values.tribunal);
  const areaServidor = termosDaArea(values.area).slice(-1)[0];
  if (areaServidor) params.set('area', areaServidor);
  const r = await chamarServidor(ref.servidorUrl, `/v1/ref/buscar?${params}`, ref.http);
  if (!r.ok) { out.avisos.push(r.indisponivel ? `servidor indisponível: só o índice local respondeu (${r.motivo})` : `servidor recusou a busca (HTTP ${r.status})`); return out; }
  const vistos = new Set([...out.legislacao, ...out.jurisprudencia].map((x) => x.id));
  for (const x of r.json?.resultados || []) {
    if (!x?.id || vistos.has(x.id)) continue;
    const item = { ...x, fonte: 'servidor' };
    if (x.tipo === 'jurisprudencia') { if (out.jurisprudencia.length < limite) out.jurisprudencia.push(item); } else if (sub === 'buscar' && out.legislacao.length < limite) out.legislacao.push(item);
  }
  return out;
}

/** `legalsquad ref <sub> …`. Devolve `{ success }` como os outros comandos. */
export async function refCli(sub, cwd, values = {}) {
  const pos = values.positionais || [];
  const json = values.json === true;
  // Desligado por escolha explícita (LEGALSQUAD_SERVIDOR_REF=0 ou "servidor_referencia": false): o `ref`
  // não consulta o índice nem o servidor e diz para onde ir. Sem modo offline: é a fonte oficial na web.
  if (!servidorDeReferenciaLigado(cwd)) {
    if (json) imprimirJson({ ok: false, desligado: true, motivo: AVISO_SERVIDOR_DESLIGADO });
    else console.error(`REF:DESLIGADO ${AVISO_SERVIDOR_DESLIGADO}`);
    return { success: false, desligado: true, motivo: AVISO_SERVIDOR_DESLIGADO };
  }
  try {
    if (sub === 'sync') {
      const camadas = typeof values.camadas === 'string' && values.camadas.trim() ? values.camadas.split(',').map((c) => c.trim()).filter(Boolean) : null;
      const r = await sincronizarIndiceDoProjeto(cwd, { camadas, log: (l) => console.error(l), ...(values.raiz ? { raiz: values.raiz } : {}), ...(values.fetchImpl ? { fetchImpl: values.fetchImpl } : {}), ...(values.esperas ? { esperas: values.esperas, esperar: values.esperar } : {}) });
      if (json) imprimirJson(r);
      else for (const l of descreverSyncDoIndice(r)) console.log(l);
      return { success: r.ok && !r.parou, ...r };
    }
    if (sub === 'estado' || !sub) {
      const raiz = values.raiz || raizDaReferencia();
      const resumo = resumoDaReferencia(raiz);
      // Defasagem em relação ao servidor: compara a versão local com a que o servidor publica (uma chamada, sem baixar nada).
      let desatualizadas = null;
      let faltantes = null;
      let servidorMotivo = null;
      if (values['sem-rede'] !== true) {
        const config = resolverConfigDeAcervo(cwd);
        const lista = await listarCamadasDoServidor({ servidorUrl: config.servidorUrl, license: config.license, raiz, esperas: [], ...(values.fetchImpl ? { fetchImpl: values.fetchImpl } : {}) });
        if (lista.ok) {
          desatualizadas = [];
          const doServidor = new Map(lista.camadas.map((c) => [c.camada, c]));
          for (const c of resumo.camadas) {
            const s = doServidor.get(c.camada);
            c.servidor = s ? s.versao : null;
            c.desatualizada = Boolean(c.presente && s && c.versao && s.versao !== c.versao);
            if (c.desatualizada) desatualizadas.push({ camada: c.camada, local: c.versao, servidor: s.versao });
          }
          faltantes = lista.camadas.filter((c) => !resumo.camadas.some((x) => x.camada === c.camada && x.presente)).map((c) => c.camada);
          resumo.cobertura = { ...(resumo.cobertura || {}), publicadas_agora: lista.camadas.length, faltam_agora: faltantes };
        } else servidorMotivo = lista.motivo;
      }
      const presentes = resumo.camadas.filter((c) => c.presente);
      const completo = faltantes ? faltantes.length === 0 && !desatualizadas.length : Boolean(resumo.cobertura?.completa);
      const saida = { ...resumo, desatualizadas, faltantes, servidor_motivo: servidorMotivo, completo };
      if (json) imprimirJson(saida);
      else {
        console.log(`REF:INDICE ${presentes.length} camada(s) nesta máquina (${resumo.raiz}), formato ${FORMATO_INDICE}`);
        for (const c of resumo.camadas) {
          console.log(`  ${c.presente ? '●' : '○'} ${c.camada}${c.versao ? ` ${c.versao}` : ''}${c.bytes ? `, ${(c.bytes / 1e6).toFixed(1)} MB` : ''}${c.nao_publicada ? ' (o servidor ainda não publica)' : ''}${!c.presente && !c.nao_publicada ? ' (formato antigo ou ausente: o sync troca)' : ''}${c.verificado_em ? `, verificado em ${c.verificado_em.slice(0, 10)}` : ''}${c.desatualizada ? `, DEFASADA (servidor ${c.servidor})` : ''}`);
        }
        console.log(`  cache de texto: ${resumo.textos.arquivos} texto(s), ${(resumo.textos.bytes / 1e6).toFixed(2)} MB`);
        if (resumo.progresso && !resumo.progresso.concluido_em) console.log(`  o último sync parou em ${resumo.progresso.camada_atual || 'início'} (${resumo.progresso.fase || '?'}): \`legalsquad ref sync\` continua de onde parou`);
        if (faltantes) console.log(completo ? `  índice COMPLETO: as ${presentes.length} camada(s) que o servidor publica, nas versões dele` : `  índice INCOMPLETO ou defasado: ${faltantes.length} camada(s) faltam${faltantes.length ? ` (${faltantes.slice(0, 8).join(', ')}${faltantes.length > 8 ? '…' : ''})` : ''}${desatualizadas?.length ? `, ${desatualizadas.length} defasada(s)` : ''}: rode \`legalsquad ref sync\``);
        else if (servidorMotivo) console.log(`  (não consegui perguntar ao servidor se há versão nova: ${servidorMotivo}); pelo último sync, o índice está ${resumo.cobertura?.completa ? 'completo' : 'incompleto'}`);
      }
      return { success: true, ...saida };
    }
    if (sub === 'camadas') {
      // O que o servidor publica e o que esta máquina tem. Camada é detalhe de distribuição: o sync baixa todas.
      const config = resolverConfigDeAcervo(cwd);
      const raiz = values.raiz || raizDaReferencia();
      const lista = await listarCamadasDoServidor({ servidorUrl: config.servidorUrl, license: config.license, raiz, ...(values.fetchImpl ? { fetchImpl: values.fetchImpl } : {}) });
      const locais = lerEstadoDaReferencia(raiz).camadas || {};
      const r = { ok: lista.ok, motivo: lista.motivo || null, camadas: lista.camadas.map((c) => ({ ...c, local: locais[c.camada]?.versao || null })) };
      if (json) imprimirJson(r);
      else if (!lista.ok) console.error(`REF:BLOQUEADO o servidor não listou as camadas (${lista.motivo})`);
      else {
        console.log(`REF:CAMADAS ${r.camadas.length} camada(s) publicadas (o \`ref sync\` baixa todas, nacional primeiro)`);
        const grupo = (nome, re) => {
          const g = r.camadas.filter((c) => re.test(c.camada));
          if (g.length) console.log(`${nome}: ${g.map((c) => `${c.camada} ${c.versao} (${c.bytes ? `${(c.bytes / 1e6).toFixed(1)} MB` : '?'}${c.local ? `, aqui ${c.local}` : ''})`).join('; ')}`);
        };
        grupo('nacional', /^nacional$/);
        grupo('UF (leis estaduais e municipais, regimento e súmulas do TJ)', /^uf-/);
        grupo('TRF e TRT', /^tr[ft]\d/);
        grupo('reguladores', /^reg-/);
      }
      return { success: lista.ok, ...r };
    }
    const { ref } = await referenciaDoProjeto(cwd, values);
    try {
      if (sub === 'resolver') {
        const texto = pos.join(' ').trim();
        if (!texto) { console.error('uso: legalsquad ref resolver "<citação>"'); return { success: false }; }
        const r = await ref.resolver(texto);
        if (json) imprimirJson(r); else console.log(linhaDaResolucao(r));
        return { success: r.status === 'encontrada', resultado: r };
      }
      if (sub === 'ler') {
        const id = pos[0];
        const r = await ref.ler(id, { filhos: values.filhos === true });
        if (json) imprimirJson(r);
        else if (!r.ok) console.error(`REF:BLOQUEADO ${r.motivo}`);
        else {
          console.log(`${r.id}${r.rotulo ? ` · ${r.rotulo}` : ''} · sha256 ${r.sha256.slice(0, 12)}… (${r.fonte}, conferido pelo ${r.conferido_por})${r.documento?.url_oficial ? ` · ${r.documento.url_oficial}` : ''}`);
          console.log(r.texto);
          for (const f of r.filhos || []) console.log(f.texto);
        }
        return { success: r.ok, resultado: r };
      }
      if (sub === 'buscar' || sub === 'jurisprudencia') {
        const q = pos.join(' ').trim() || values.query || '';
        if (q.length < 2) { console.error(`uso: legalsquad ref ${sub} "<tema>" [--area <área>] [--tribunal <sigla>] [--tipo <tipo>] [--vigente] [--limit N]`); return { success: false }; }
        const r = await buscarNoProjeto(ref, q, { sub, values });
        if (json) imprimirJson(r);
        else imprimirBusca(r, sub);
        return { success: true, ...r };
      }
      if (sub === 'vinculos') {
        const id = pos[0];
        if (!id) { console.error('uso: legalsquad ref vinculos <id>'); return { success: false }; }
        const r = ref.vinculos(id);
        if (json) imprimirJson(r);
        else {
          if (!ref.temIndice) console.error('  aviso: sem índice nesta máquina (rode `acervo sync`): os vínculos vêm do índice local');
          for (const a of r.controle) console.log(`ALERTA controle concentrado: ${a.descricao || descreverAlerta(a)} sobre ${a.origem}`);
          if (r.controle_citado.length) console.log(`ações que só mencionam o dispositivo (sinal fraco, não é alerta): ${r.controle_citado.slice(0, 12).map((c) => c.rotulo).join('; ')}`);
          const porTipo = new Map();
          for (const v of r.saindo) { const k = `${v.tipo}`; if (!porTipo.has(k)) porTipo.set(k, []); porTipo.get(k).push(`${v.origem === id ? '' : `${v.origem.split('#')[1]}: `}${v.destino}${v.titulo_destino ? ` (${v.titulo_destino})` : ''}`); }
          for (const [tipo, lista] of porTipo) console.log(`${tipo}: ${[...new Set(lista)].slice(0, 12).join('; ')}${lista.length > 12 ? `; e mais ${lista.length - 12}` : ''}`);
          if (r.chegando.length) console.log(`citado por: ${r.chegando.slice(0, 12).map((v) => `${v.origem} (${v.tipo})`).join('; ')}${r.chegando.length > 12 ? `; e mais ${r.chegando.length - 12}` : ''}`);
          if (!r.saindo.length && !r.chegando.length && !r.controle.length) console.log('nenhum vínculo no índice para esse id');
        }
        return { success: true, ...r };
      }
      if (sub === 'mapa') {
        const area = pos.join(' ').trim() || values.area;
        if (!area) { console.error('uso: legalsquad ref mapa <área>'); return { success: false }; }
        const r = ref.mapa(area);
        if (json) imprimirJson(r);
        else {
          console.log(`# Mapa da área: ${area} (índice ${Object.entries(r.versoes).map(([c, v]) => `${c} ${v}`).join(', ') || 'ausente nesta máquina: rode `acervo sync`'})`);
          console.log('Ids: norma federal `fed:<tipo>:<número>:<ano>` (lei, lc, dl, dec, mp, ec), CF `fed:cf:1988`, dispositivo `<id>#art-157/par-2/inc-2`; súmula `stj:sumula:7`, vinculante `stf:sv:11`, tema `stj:rep:1000` e `stf:rg:1016`, controle `stf:adi:6298`; norma estadual `est:sp:lei:10261:1968`, municipal `mun:sp:sao-paulo:dec:65599:2026`, ato de regulador `reg:anvisa:port:344:1998`, CNJ e CNMP `reg:cnj:res:213:2015`, regimento `tjsp:regimento`, súmula de TRF `trf4:sumula:1`. Resolva com `ref resolver "<citação>"`, leia com `ref ler <id>`.');
          if (r.diplomas.length) console.log(`Diplomas por sigla: ${r.diplomas.map((d) => `${d.siglas.join('/')} = ${d.id}`).join('; ')}`);
          const bloco = (nome, lista) => { if (lista.length) { console.log(`\n## ${nome}`); for (const x of lista) console.log(`- ${x.id} · ${x.titulo}${x.vigencia && x.vigencia !== 'vigente' ? ` · ${x.vigencia}` : ''} · selo ${x.selo}${x.trecho ? `: ${curto(x.trecho, 140)}` : ''}`); } };
          bloco('Súmulas da área', r.sumulas);
          bloco(r.temas_por === 'palavra' ? 'Temas com a palavra da área (o índice ainda não traz área nos temas)' : 'Temas da área', r.temas);
          bloco('Outros precedentes da área', r.outros);
          if (!r.sumulas.length && !r.temas.length) console.log(`\n(nenhuma súmula ou tema com a área "${area}" no índice; use \`ref buscar\` pelo tema)`);
        }
        return { success: true, ...r };
      }
      if (sub === 'prebuscar') {
        const area = pos.join(' ').trim() || values.area;
        if (!area) { console.error('uso: legalsquad ref prebuscar <área> [--limit N]'); return { success: false }; }
        if (!ref.temIndice) { console.error('REF:BLOQUEADO sem índice nesta máquina: rode `acervo sync` (a pré-busca escolhe os textos pelo índice)'); return { success: false }; }
        const r = await prebuscar(ref, area, { limite: Number(values.limit) || 40 });
        if (json) imprimirJson(r);
        else console.log(`REF:PREBUSCA ${area}: ${r.baixados} texto(s) baixado(s) e conferido(s) pelo hash, ${r.ja_no_cache} já no cache${r.falhas.length ? `, ${r.falhas.length} falha(s): ${r.falhas.slice(0, 3).map((f) => `${f.id} (${f.motivo})`).join('; ')}` : ''}`);
        return { success: true, ...r };
      }
      if (sub === 'revalidar') {
        const alvo = pos[0];
        if (!alvo) { console.error('uso: legalsquad ref revalidar <pasta do run | manifesto .citation-gate.json>'); return { success: false }; }
        const r = await revalidarRun(ref, isAbsolute(alvo) ? alvo : resolve(cwd, alvo));
        if (json) imprimirJson(r);
        else if (!r.ok) console.error(`REF:BLOQUEADO ${r.motivo}`);
        else {
          console.log(`REF:REVALIDAR ${r.total} citação(ões) reconferida(s) no servidor (índice ${r.versao_indice}): ${r.mudaram ? `${r.mudaram} mudaram` : 'nenhuma mudou desde a conferência do run'}`);
          for (const m of r.mudancas) console.log(`  ${m.texto} (${m.id}): ${m.diferencas.join('; ')}`);
        }
        return { success: r.ok && !r.mudaram, ...r };
      }
      if (sub === 'conferir') {
        const entrada = values.entrada;
        if (!entrada) { console.error('uso: legalsquad ref conferir --entrada <arquivo.json> [--saida <arquivo.json>]'); return { success: false }; }
        const dado = JSON.parse(readFileSync(entrada, 'utf8'));
        const itens = (Array.isArray(dado) ? dado : dado.citacoes || []).filter((e) => e && typeof e.texto === 'string');
        const r = await conferirLoteDoGate(ref, itens, { comTexto: values['sem-texto'] !== true });
        const saida = { gerado_em: new Date().toISOString(), servidor_url: ref.servidorUrl, ...r };
        if (values.saida) {
          mkdirSync(dirname(resolve(values.saida)), { recursive: true });
          const tmp = join(dirname(resolve(values.saida)), `.${basename(values.saida)}.${process.pid}.tmp`);
          writeFileSync(tmp, `${JSON.stringify(saida, null, 1)}\n`, 'utf8');
          renameSync(tmp, resolve(values.saida));
        }
        if (json || !values.saida) imprimirJson(saida);
        return { success: !r.servidor.indisponivel || Boolean(r.indice_local), ...saida };
      }
    } finally {
      ref.fechar();
    }
    console.error(`REF:BLOQUEADO subcomando desconhecido "${sub}". Use resolver, ler, buscar, jurisprudencia, vinculos, mapa, prebuscar, revalidar, conferir, camadas, sync ou estado.`);
    return { success: false };
  } catch (erro) {
    console.error(`REF:BLOQUEADO ${erro.message}`);
    return { success: false, error: { message: erro.message } };
  }
}
