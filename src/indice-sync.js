// Sync do índice do servidor de referência: INCREMENTAL, SEGURO e COMPLETO.
//
// O plano de arquitetura da Legis (04/11/2026) manda: o índice local é só índice (uma linha pequena por
// documento, sem texto de artigo), cobre o acervo inteiro (regra 4) e nunca fica vazio. O `ref sync` é
// quem o traz, e é feito para não repetir o defeito do sync anterior, que foi morto por memória
// (código 137), deixou o índice vazio, um lock órfão e um `.gz.tmp` de 272 MB:
//
//   - UMA CAMADA POR VEZ: download em fluxo (nunca o arquivo inteiro em memória), descompressão em
//     fluxo para um arquivo temporário, conferência de assinatura, tamanho, sha256 do arquivo, sha256
//     do SQLite e hash lógico das tabelas ANTES de trocar, e troca atômica por `rename`. O índice
//     vigente da camada só sai do lugar quando o novo está verificado. Memória: a de uns poucos
//     buffers de fluxo e do cache do SQLite, não a do arquivo (medida em arquivo de 500 MB: ver
//     docs/BUSCA-LOCAL.md).
//   - RETOMÁVEL: o `estado.json` é gravado a cada camada concluída (não só no fim) e leva o progresso;
//     ao começar, sob a trava, o sync apaga os `.tmp` e as sobras de um sync morto e o lock de um pid
//     que já não existe, e continua das camadas que faltam.
//   - DIFERENÇA EM CADEIA: quem está até 8 versões atrás, e cuja cadeia de diferenças soma menos da
//     metade da camada, aplica as diferenças (`legalsquad-indice-delta/3`), cada uma numa transação
//     que só fica se chegar ao hash lógico assinado. Senão baixa a camada inteira, uma vez.
//   - COBERTURA COMPLETA POR PADRÃO: todas as camadas que o servidor publica (nacional, 27 UFs, TRFs,
//     TRTs, reguladores), nacional primeiro. A camada, o grupo e o banco são detalhe interno: quem
//     usa o motor não escolhe. `camadas` só limita para teste.
//   - ESPAÇO: antes de cada camada confere o espaço livre (arquivo comprimido + SQLite + margem) e,
//     se faltar, para com mensagem clara, sem deixar índice quebrado.
//   - O enxuto compacto (`legalsquad-indice/3`) SUBSTITUI os formatos antigos (`/1`, `/2`): arquivo antigo em disco é
//     descartado e trocado; o índice de conteúdo local e os arquivos `juris-*` de antes deixam de
//     existir e são apagados.
//
// A raiz de confiança é a dos pacotes: o manifesto de cada índice e de cada diferença vem assinado
// (Ed25519) e é conferido pelo anel `CHAVES_PUBLICAS_PRODUCAO`, só por ele. Quem confere artigo usa
// outro anel (`ANEL_ARTIGOS`, src/ref-artigos.js), e uma chave de artigo nunca assina manifesto aqui.
// Nada é offline por desenho: o índice existe pela velocidade (decisão do dono, 30/10/2026).
//
// O SQLite é o embutido do Node (`node:sqlite`): nada a instalar no aluno.
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import { idDaInstalacao } from './instalacao.js';
import { chamarServidor } from './ref-http.js';
import { jsonCanonico } from './ref-citacao.js';

/**
 * O formato do índice enxuto e compacto (plano da Legis, seção 5): sem tabela de dispositivos, com sumário.
 * Por fora, as views lógicas `doc` e `apelido` e a tabela `vinculo`; por baixo, dicionário (`dic`), chave
 * inteira (`rid`), sha256 em BLOB e buscas FTS5 sem cópia do texto (`rowid` = `rid`).
 */
export const FORMATO_INDICE = 'legalsquad-indice/3';
/** Os formatos anteriores (`/1` com `dispositivo`; `/2` enxuto sem compactação, nunca publicado): só reconhecidos para serem descartados e substituídos. */
export const FORMATOS_ANTIGOS = Object.freeze(['legalsquad-indice/1', 'legalsquad-indice/2']);
export const FORMATO_INDICE_ANTIGO = FORMATOS_ANTIGOS[0];
/** Diferença por documento sobre o formato enxuto. */
export const FORMATO_DELTA_DOCS = 'legalsquad-indice-delta/3';
/** O plano de atualização do servidor (`GET /v1/indice/<camada>/cadeia/<versão local>`). */
export const FORMATO_CADEIA = 'legalsquad-indice-cadeia/1';
export const CAMADA_NACIONAL = 'nacional';
/** Mais passos que isto é cadeia frágil: baixa-se a camada (o servidor guarda 8 versões). */
export const MAX_PASSOS_CADEIA = 8;
/** A cadeia só vale se as diferenças somarem menos que esta fração da camada (bytes gzip dos dois lados). */
export const FRACAO_TETO_CADEIA = 0.5;
/** Diferença acima disto (gzip) ou descomprimida acima do teto seguinte cai em "baixe a camada": a diferença é lida em memória. */
export const TETO_DELTA_GZIP = 32 * 1024 * 1024;
export const TETO_DELTA_JSON = 96 * 1024 * 1024;
/** Folga de disco depois de baixar uma camada (além do .gz e do SQLite). */
export const MARGEM_DE_DISCO = 256 * 1024 * 1024;
const RE_VERSAO = /^\d{4}\.\d{2}\.\d+$/;
/** Os nomes de camada que o servidor publica (o mesmo padrão do `RE_CAMADA` de lá, sem os grupos `juris-*`: a jurisprudência é documento do índice). */
export const RE_CAMADA = /^(?:nacional|uf-[A-Z]{2}|trf\d|trt\d{1,2}|reg-[a-z0-9-]{2,60})$/;

// ── node:sqlite ────────────────────────────────────────────────────────────

let moduloSqlite = null;

/**
 * Carrega `node:sqlite` uma vez, sem o aviso de recurso experimental que o Node 22 a 25 emite ao
 * carregar o módulo (o aluno não precisa ler "ExperimentalWarning: SQLite" a cada comando). Só esse
 * aviso some: qualquer outro passa.
 */
export async function carregarSqlite() {
  if (moduloSqlite) return moduloSqlite;
  const original = process.emitWarning;
  process.emitWarning = function semAvisoDoSqlite(aviso, ...resto) {
    const tipo = typeof resto[0] === 'string' ? resto[0] : resto[0]?.type;
    const nome = aviso?.name || tipo;
    const texto = typeof aviso === 'string' ? aviso : aviso?.message;
    if (nome === 'ExperimentalWarning' && /sqlite/i.test(String(texto))) return undefined;
    return original.call(process, aviso, ...resto);
  };
  try {
    moduloSqlite = await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return moduloSqlite;
}

// ── tabelas e hash lógico (o mesmo contrato do servidor: src/indice-sqlite.js de lá) ─────────────

/** Colunas por tabela, em ordem; a primeira (ou as primeiras) formam a chave. O documento é uma linha pequena. */
export const TABELAS = Object.freeze({
  doc: { chave: ['id'], colunas: ['id', 'tipo', 'subtipo', 'esfera', 'uf', 'orgao', 'numero', 'data', 'titulo', 'ementa', 'vigencia', 'selo', 'selo_motivo', 'conferido_em', 'url_oficial', 'sha256_texto', 'area', 'rotulos_artigos', 'assunto'] },
  apelido: { chave: ['forma', 'doc_id'], colunas: ['forma', 'doc_id', 'exibicao'] },
  vinculo: { chave: ['origem', 'destino', 'tipo'], colunas: ['origem', 'destino', 'tipo', 'fonte'] },
});

/** O banco aberto é do formato atual (`/3`): views `doc` e `apelido` sobre `doc_`, `apelido_` e `dic`, sem `dispositivo`? */
export function ehIndiceEnxuto(db) {
  const nomes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((r) => r.name));
  if (nomes.has('dispositivo')) return false;
  return ['doc', 'doc_', 'dic', 'apelido', 'apelido_', 'vinculo', 'busca', 'busca_assunto', 'meta'].every((n) => nomes.has(n));
}

/** Hash lógico: sha256 das linhas LÓGICAS de cada tabela (as views `doc` e `apelido` e a tabela `vinculo`), em ordem de chave. Independe de página, VACUUM, `rid` e códigos do dicionário. Linha a linha, sem juntar nada em memória. */
export function hashLogico(db) {
  const h = createHash('sha256');
  for (const [t, def] of Object.entries(TABELAS)) {
    h.update(`#${t}\n`);
    const st = db.prepare(`SELECT ${def.colunas.join(',')} FROM ${t} ORDER BY ${def.chave.join(',')}`);
    for (const linha of st.iterate()) h.update(`${JSON.stringify(def.colunas.map((c) => linha[c] ?? null))}\n`);
  }
  return h.digest('hex');
}

export function lerMeta(db) {
  const out = {};
  for (const r of db.prepare('SELECT chave, valor FROM meta').all()) out[r.chave] = r.valor;
  return out;
}

const placeholders = (n) => `(${Array(n).fill('?').join(',')})`;

// ── escrita física do formato /3 (o mesmo contrato do servidor: src/indice-sqlite.js de lá) ────────────

/** Colunas do `doc` físico que viram código do dicionário. O motivo do selo e a base da URL têm coluna própria. */
export const COLUNAS_DIC = Object.freeze(['tipo', 'subtipo', 'esfera', 'uf', 'orgao', 'vigencia', 'selo', 'area']);
export const COLUNAS_FISICAS = ['id', 'tipo', 'subtipo', 'esfera', 'uf', 'orgao', 'numero', 'data', 'titulo', 'ementa', 'vigencia', 'selo', 'motivo', 'conferido_em', 'url_base', 'url_suf', 'sha256_texto', 'area', 'rotulos_artigos', 'assunto'];

/** Parte a URL oficial em base (esquema, host e primeiro segmento) e sufixo: a view recompõe `base || sufixo`, então qualquer corte serve ao hash lógico. */
export function partirUrl(url) {
  if (url === null || url === undefined) return [null, null];
  const u = String(url);
  const m = /^(https?:\/\/[^/?#]+\/(?:[^/?#]+\/)?)/.exec(u);
  return m ? [m[1], u.slice(m[1].length)] : [null, u];
}

/** Traduz a linha LÓGICA do documento (as colunas de `TABELAS.doc`) para a física de `doc_`, criando o código de um valor novo no dicionário. */
export class Codificador {
  constructor(db) {
    this.codigos = new Map();
    for (const r of db.prepare('SELECT cod, valor FROM dic').all()) this.codigos.set(r.valor, Number(r.cod));
    this.ins = db.prepare('INSERT INTO dic (cod, valor) VALUES (?, ?)');
    this.proximo = Number(db.prepare('SELECT coalesce(max(cod), 0) + 1 AS p FROM dic').get().p);
  }

  cod(valor) {
    if (valor === null || valor === undefined) return null;
    const v = String(valor);
    let c = this.codigos.get(v);
    if (c === undefined) {
      c = this.proximo++;
      this.ins.run(c, v);
      this.codigos.set(v, c);
    }
    return c;
  }

  fisica(logica) {
    const [id, tipo, subtipo, esfera, uf, orgao, numero, data, titulo, ementa, vigencia, selo, motivo, conferidoEm, url, sha, area, rotulos, assunto] = logica;
    const [base, suf] = partirUrl(url);
    const hex = typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? Buffer.from(sha, 'hex') : sha;
    return [id, this.cod(tipo), this.cod(subtipo), this.cod(esfera), this.cod(uf), this.cod(orgao), numero, data, titulo, ementa, this.cod(vigencia), this.cod(selo), this.cod(motivo), conferidoEm, this.cod(base), suf, hex, this.cod(area), rotulos, assunto];
  }
}

const textoDosApelidos = (apelidos) => apelidos.map((a) => a.exibicao || a.forma).join(' | ');

/**
 * Aplica a diferença por documento (`legalsquad-indice-delta/3`) numa transação: tira todas as linhas
 * de cada documento listado (o documento, os apelidos e os vínculos que saem dele ou dos dispositivos
 * dele), põe as linhas novas, refaz as buscas e só confirma se chegar ao hash lógico da versão nova.
 * As linhas da diferença são LÓGICAS; o dicionário, o `rid` e o BLOB são refeitos aqui. O documento que
 * já existia mantém o `rid`. Mesma semântica de `aplicarDocsAtual` do servidor.
 */
export function aplicarDeltaDocsConferido(db, corpo, { hashEsperado, metaNova = {} }) {
  if (corpo?.formato !== FORMATO_DELTA_DOCS) throw new Error(`formato de diferença inesperado: ${corpo?.formato}`);
  const docs = Array.isArray(corpo.docs) ? corpo.docs.map(String) : [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const cod = new Codificador(db);
    const ridDe = db.prepare('SELECT rid, assunto IS NOT NULL AS tinha_assunto FROM doc_ WHERE id = ?');
    let proximo = Number(db.prepare('SELECT coalesce(max(rid), 0) AS m FROM doc_').get().m) + 1;
    const del = {
      doc: db.prepare('DELETE FROM doc_ WHERE rid = ?'),
      apelido: db.prepare('DELETE FROM apelido_ WHERE rid = ?'),
      vinculo: db.prepare("DELETE FROM vinculo WHERE origem = ? OR (origem >= ? || '#' AND origem < ? || '$')"),
      busca: db.prepare('DELETE FROM busca WHERE rowid = ?'),
      assunto: db.prepare('DELETE FROM busca_assunto WHERE rowid = ?'),
    };
    const rids = new Map();
    for (const id of docs) {
      const antes = ridDe.get(id);
      if (antes) {
        const rid = Number(antes.rid);
        rids.set(id, rid);
        del.busca.run(rid);
        if (antes.tinha_assunto) del.assunto.run(rid);
        del.apelido.run(rid);
        del.doc.run(rid);
      }
      del.vinculo.run(id, id, id);
    }
    const insDoc = db.prepare(`INSERT INTO doc_ (rid, ${COLUNAS_FISICAS.join(',')}) VALUES ${placeholders(COLUNAS_FISICAS.length + 1)}`);
    const ridAtual = new Map();
    for (const linha of corpo.tabelas?.doc?.upsert || []) {
      const rid = rids.get(linha[0]) ?? proximo++;
      ridAtual.set(linha[0], rid);
      insDoc.run(rid, ...cod.fisica(linha));
    }
    const insAp = db.prepare('INSERT OR REPLACE INTO apelido_ (forma, rid, exibicao) VALUES (?,?,?)');
    const achar = db.prepare('SELECT rid FROM doc_ WHERE id = ?');
    for (const [forma, docId, exibicao] of corpo.tabelas?.apelido?.upsert || []) {
      const rid = ridAtual.get(docId) ?? achar.get(docId)?.rid;
      if (rid === undefined) throw new Error(`apelido ${forma} de documento que não está no índice: ${docId}`);
      insAp.run(forma, Number(rid), exibicao);
    }
    const insVin = db.prepare('INSERT OR REPLACE INTO vinculo (origem, destino, tipo, fonte) VALUES (?,?,?,?)');
    for (const linha of corpo.tabelas?.vinculo?.upsert || []) insVin.run(...linha);
    const insBusca = db.prepare('INSERT INTO busca (rowid, titulo, ementa, apelidos) VALUES (?,?,?,?)');
    const insAssunto = db.prepare('INSERT INTO busca_assunto (rowid, assunto) VALUES (?,?)');
    const docSt = db.prepare('SELECT titulo, ementa, assunto FROM doc_ WHERE rid = ?');
    const apSt = db.prepare('SELECT forma, exibicao FROM apelido_ WHERE rid = ? ORDER BY forma');
    for (const rid of ridAtual.values()) {
      const d = docSt.get(rid);
      insBusca.run(rid, d.titulo || '', d.ementa || '', textoDosApelidos(apSt.all(rid)));
      if (d.assunto) insAssunto.run(rid, d.assunto);
    }
    const hash = hashLogico(db);
    if (hash !== hashEsperado) {
      db.exec('ROLLBACK');
      return { ok: false, hash };
    }
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta (chave, valor) VALUES (?,?)');
    for (const [k, v] of Object.entries({ ...metaNova, sha256_conteudo: hash })) insMeta.run(k, String(v));
    db.exec('COMMIT');
    return { ok: true, hash, tocados: docs.length };
  } catch (erro) {
    try { db.exec('ROLLBACK'); } catch { /* já desfeita */ }
    throw erro;
  }
}

// ── assinatura ──────────────────────────────────────────────────────────────

/**
 * Confere a assinatura Ed25519 do manifesto (JSON canônico) contra o anel `{kid: pem}`. Kid que o
 * anel não conhece é recusa com a causa certa (atualize o motor), não "adulterado". Anel de chave
 * própria (`{ propria: pem }`, de `signing_public_key_path`) vale para qualquer kid.
 *
 * Este é o anel de PRODUÇÃO (índice, diferença, pacote). A chave dos artigos (`srv-2026-11`) não
 * está nele e portanto um manifesto assinado por ela é recusado aqui ("kid desconhecido").
 */
export function verificarAssinaturaDoManifesto(manifesto, assinaturaB64, anel) {
  const kid = manifesto?.signing_kid;
  const pem = (kid && Object.hasOwn(anel || {}, kid) && anel[kid]) || anel?.propria || null;
  if (!pem) return { ok: false, motivo: `manifesto assinado com a chave "${kid || '(sem kid)'}", que esta versão do motor não conhece; atualize o LegalSquad` };
  let ok;
  try {
    ok = verify(null, Buffer.from(jsonCanonico(manifesto), 'utf8'), createPublicKey(pem), Buffer.from(String(assinaturaB64 || ''), 'base64'));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, kid: kid || 'propria' } : { ok: false, motivo: 'assinatura do manifesto não confere com a chave do anel: recusado' };
}

// ── onde fica ───────────────────────────────────────────────────────────────

/**
 * A pasta da máquina que guarda índice e textos: `LEGALSQUAD_REF_DIR` (testes, disco externo) ›
 * `~/.legalsquad`. Um teste que caísse aqui sem a variável gravaria no `~/.legalsquad` real do
 * desenvolvedor: a mesma guarda do depósito.
 */
export function raizDaReferencia({ env = process.env, argv = process.argv } = {}) {
  if (env.LEGALSQUAD_REF_DIR) return resolve(env.LEGALSQUAD_REF_DIR);
  if (env.NODE_TEST_CONTEXT || argv.includes('--test') || argv.some((a) => /\.test\.m?js$/.test(String(a)))) {
    throw new Error('referência: teste sem LEGALSQUAD_REF_DIR. Rode pela suíte (`npm test`) ou defina a variável para uma pasta temporária.');
  }
  return join(homedir(), '.legalsquad');
}

export function caminhosDaReferencia(raiz) {
  const indice = join(raiz, 'indice');
  return { raiz, indice, estado: join(indice, 'estado.json'), textos: join(raiz, 'textos') };
}

export function arquivoDaCamada(camada) {
  return camada === CAMADA_NACIONAL ? 'legalsquad.sqlite' : `${camada}.sqlite`;
}

/** O id da instalação que vai no cabeçalho: o mesmo da contribuição (`~/.legalsquad/instalacao.json`). */
export function instalacaoDaReferencia(raiz, license) {
  return idDaInstalacao({ license, casa: basename(raiz) === '.legalsquad' ? dirname(raiz) : raiz });
}

/** Ordem de download: a nacional, as UFs, os TRFs, os TRTs e os reguladores; dentro de cada grupo, pelo nome. */
export function ordemDeDownload(camadas) {
  const grupo = (c) => (c === CAMADA_NACIONAL ? 0 : c.startsWith('uf-') ? 1 : /^trf\d/.test(c) ? 2 : /^trt\d/.test(c) ? 3 : 4);
  const numero = (c) => Number((/\d+$/.exec(c) || [0])[0]);
  return [...new Set(camadas)].sort((a, b) => grupo(a) - grupo(b) || numero(a) - numero(b) || a.localeCompare(b));
}

/** Rotas da camada no servidor. A nacional é a raiz de `/v1/indice`; as outras, `/v1/indice/camada/<c>`. */
export function rotasDaCamada(camada) {
  const base = camada === CAMADA_NACIONAL ? '/v1/indice' : `/v1/indice/camada/${encodeURIComponent(camada)}`;
  return { atual: `${base}/atual`, versao: (v) => `${base}/${v}`, delta: (de, para) => `${base}/delta/${de}..${para}`, cadeia: (de) => `${base}/cadeia/${de}` };
}

/**
 * A lista do servidor (`GET /v1/indice/camadas`): `{ ok, camadas: [{camada, versao, bytes, bytes_sqlite}] }`.
 * Não confere assinatura: só serve para escolher e dimensionar o que pedir (cada camada tem o manifesto
 * assinado conferido quando é baixada). Ignora o que não é camada do formato enxuto (grupos `juris-*`).
 */
export async function listarCamadasDoServidor({ servidorUrl, license, raiz, fetchImpl = globalThis.fetch, esperas, esperar } = {}) {
  const r = await chamarServidor(servidorUrl, '/v1/indice/camadas', { license, instalacao: instalacaoDaReferencia(raiz, license), fetchImpl, ...(esperas ? { esperas } : {}), ...(esperar ? { esperar } : {}) });
  if (!r.ok || !Array.isArray(r.json?.camadas)) return { ok: false, motivo: r.motivo || `HTTP ${r.status}`, camadas: [] };
  return {
    ok: true,
    camadas: r.json.camadas.filter((c) => RE_CAMADA.test(String(c?.camada || ''))).map((c) => ({
      camada: c.camada, versao: c.versao, bytes: Number(c.bytes) || null, bytes_sqlite: Number(c.manifesto?.bytes_sqlite) || null, formato: c.manifesto?.formato || null,
    })),
  };
}

/** Todas as camadas que o servidor publica, na ordem de download (regra 4: cobertura completa). */
export async function camadasParaSincronizar(opcoes = {}) {
  const lista = await listarCamadasDoServidor(opcoes);
  return lista.ok ? ordemDeDownload(lista.camadas.map((c) => c.camada)) : [];
}

// ── estado e trava ──────────────────────────────────────────────────────────

export function lerEstadoDaReferencia(raiz) {
  const { estado } = caminhosDaReferencia(raiz);
  if (!existsSync(estado)) return { formato: 2, camadas: {}, novo: true };
  try {
    const e = JSON.parse(readFileSync(estado, 'utf8'));
    return e && typeof e === 'object' && e.camadas && typeof e.camadas === 'object' ? e : { formato: 2, camadas: {}, novo: true };
  } catch (erro) {
    return { formato: 2, camadas: {}, novo: true, ilegivel: erro.message };
  }
}

function gravarAtomico(caminho, conteudo) {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = join(dirname(caminho), `.${basename(caminho)}.${process.pid}.tmp`);
  writeFileSync(tmp, conteudo);
  renameSync(tmp, caminho);
}

function gravarEstadoDaReferencia(raiz, estado) {
  const { novo, ilegivel, ...limpo } = estado;
  void novo;
  void ilegivel;
  gravarAtomico(caminhosDaReferencia(raiz).estado, `${JSON.stringify(limpo, null, 2)}\n`);
}

const pidVivo = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};

/** Trava do sync do índice: dois syncs ao mesmo tempo gravariam os mesmos temporários. Lock de pid morto é órfão e sai. */
function travarIndice(raiz) {
  const { indice } = caminhosDaReferencia(raiz);
  mkdirSync(indice, { recursive: true });
  const caminho = join(indice, '.sync.lock');
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const fd = openSync(caminho, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, em: new Date().toISOString() }));
      closeSync(fd);
      return { ok: true, orfao: tentativa > 0, soltar: () => rmSync(caminho, { force: true }) };
    } catch (erro) {
      if (erro?.code !== 'EEXIST') throw erro;
      let dono = null;
      let idade = 0;
      try { idade = Date.now() - statSync(caminho).mtimeMs; dono = JSON.parse(readFileSync(caminho, 'utf8')); } catch { /* sem dono legível */ }
      if (!pidVivo(dono?.pid) || idade > 12 * 60 * 60 * 1000) { rmSync(caminho, { force: true }); continue; }
      return { ok: false, motivo: `outro sync do índice está em andamento (pid ${dono?.pid}); aguarde` };
    }
  }
  return { ok: false, motivo: 'não consegui obter a trava do sync do índice' };
}

/**
 * Sob a trava: apaga o que um sync morto deixou (`.tmp`, `.gz.tmp`, `.part`) e o que o desenho novo
 * aposentou (índice de conteúdo local `*.conteudo.sqlite`, arquivos `juris-*.sqlite`). Devolve o que saiu.
 */
export function limparSobras(raiz) {
  const { indice } = caminhosDaReferencia(raiz);
  const saiu = [];
  let nomes;
  try { nomes = readdirSync(indice); } catch { return saiu; }
  for (const nome of nomes) {
    const sobra = (/^\..*\.(?:tmp|part)$/.test(nome) && nome !== '.sync.lock') || /\.conteudo\.sqlite$/.test(nome) || /^juris-[a-z-]+\.sqlite$/.test(nome);
    if (!sobra) continue;
    let bytes = 0;
    try { bytes = statSync(join(indice, nome)).size; } catch { /* sumiu */ }
    rmSync(join(indice, nome), { force: true });
    saiu.push({ nome, bytes });
  }
  return saiu;
}

/** Espaço livre (bytes) no volume de `dir`. */
export function espacoLivreEm(dir) {
  mkdirSync(dir, { recursive: true });
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

// ── baixar e conferir ──────────────────────────────────────────────────────

function conferirManifestoDoIndice(pub, camada, anel) {
  const m = pub?.manifesto;
  if (!m || typeof m !== 'object') return { ok: false, motivo: 'resposta sem manifesto' };
  const assinatura = verificarAssinaturaDoManifesto(m, pub.assinatura, anel);
  if (!assinatura.ok) return assinatura;
  if (FORMATOS_ANTIGOS.includes(m.formato)) return { ok: false, motivo: `o servidor publica a camada ${camada} no formato antigo (${m.formato}); este motor só lê ${FORMATO_INDICE}: atualize o servidor ou use a versão anterior do motor` };
  if (m.formato !== FORMATO_INDICE) return { ok: false, motivo: `formato do índice desconhecido: ${m.formato}` };
  if ((m.camada || CAMADA_NACIONAL) !== camada) return { ok: false, motivo: `o manifesto é da camada "${m.camada}", não de "${camada}"` };
  if (!RE_VERSAO.test(String(m.versao || ''))) return { ok: false, motivo: `versão fora do formato: ${m.versao}` };
  if (!/^[a-f0-9]{64}$/.test(String(m.sha256_arquivo || '')) || !/^[a-f0-9]{64}$/.test(String(m.sha256_conteudo || ''))) return { ok: false, motivo: 'manifesto sem os hashes do arquivo e do conteúdo' };
  return { ok: true, kid: assinatura.kid };
}

/**
 * Sem bytes por este tempo, o download é dado como travado e abortado (a camada fica para a próxima execução,
 * que retoma). Sem isso, uma conexão que para de mandar dados sem fechar segurava o sync até o teto de 30
 * minutos por tentativa (medido em 04/11/2026: 1h10 parado numa camada). `LEGALSQUAD_INDICE_OCIOSO_MS` muda.
 */
export const OCIOSO_DOWNLOAD_MS = Number(process.env.LEGALSQUAD_INDICE_OCIOSO_MS) || 90_000;

/** Baixa `caminho` em fluxo para `destino`, conferindo tamanho e sha256 contra o esperado. Nunca guarda o arquivo em memória. */
async function baixarConferido(servidorUrl, caminho, destino, { bytes, sha256, onProgresso, ociosoMs = OCIOSO_DOWNLOAD_MS, ...http }) {
  const r = await chamarServidor(servidorUrl, caminho, { ...http, binario: true, tempoMs: 30 * 60 * 1000 });
  if (!r.ok) return { ok: false, motivo: r.motivo || `HTTP ${r.status} em ${caminho}`, indisponivel: !!r.indisponivel };
  const h = createHash('sha256');
  let total = 0;
  let ultimoDado = Date.now();
  const contar = new Transform({
    transform(pedaco, _c, feito) {
      h.update(pedaco);
      total += pedaco.length;
      ultimoDado = Date.now();
      if (onProgresso) onProgresso(total);
      feito(null, pedaco);
    },
  });
  mkdirSync(dirname(destino), { recursive: true });
  const origem = Readable.fromWeb(r.resposta.body);
  const vigia = setInterval(() => {
    if (Date.now() - ultimoDado > ociosoMs) origem.destroy(new Error(`sem dados do servidor há ${Math.round(ociosoMs / 1000)} s (${total} bytes recebidos)`));
  }, Math.min(5000, Math.max(50, Math.floor(ociosoMs / 4))));
  vigia.unref?.();
  try {
    await pipeline(origem, contar, createWriteStream(destino));
  } catch (erro) {
    rmSync(destino, { force: true });
    return { ok: false, motivo: `download interrompido: ${erro.message}`, indisponivel: true };
  } finally {
    clearInterval(vigia);
  }
  const sha = h.digest('hex');
  if ((bytes !== undefined && total !== Number(bytes)) || sha !== sha256) {
    rmSync(destino, { force: true });
    return { ok: false, motivo: `bytes baixados não conferem com o manifesto assinado (${total} bytes, sha256 ${sha.slice(0, 12)}…)` };
  }
  return { ok: true, bytes: total };
}

/** Descomprime em fluxo e confere o sha256 do SQLite descomprimido. */
async function descomprimirConferido(origem, destino, sha256Esperado) {
  const h = createHash('sha256');
  const contar = new Transform({ transform(pedaco, _c, feito) { h.update(pedaco); feito(null, pedaco); } });
  await pipeline(createReadStream(origem), createGunzip(), contar, createWriteStream(destino));
  const sha = h.digest('hex');
  if (sha256Esperado && sha !== sha256Esperado) return { ok: false, motivo: `SQLite descomprimido não confere com o sha256_sqlite assinado (${sha.slice(0, 12)}…)` };
  return { ok: true, sha };
}

/** O arquivo da camada que está em disco é um índice enxuto íntegro de abrir? `false` para o formato antigo, ilegível ou ausente. */
async function arquivoEhEnxuto(arquivo) {
  if (!existsSync(arquivo)) return false;
  try {
    const { DatabaseSync } = await carregarSqlite();
    const db = new DatabaseSync(arquivo, { readOnly: true });
    try { return ehIndiceEnxuto(db); } finally { db.close(); }
  } catch {
    return false;
  }
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function baixarIndiceInteiro(ctx, camada, pub, { log }) {
  const { DatabaseSync } = await carregarSqlite();
  const m = pub.manifesto;
  const { indice } = caminhosDaReferencia(ctx.raiz);
  const final = join(indice, arquivoDaCamada(camada));
  const gz = join(indice, `.${arquivoDaCamada(camada)}.${process.pid}.gz.tmp`);
  const tmp = join(indice, `.${arquivoDaCamada(camada)}.${process.pid}.tmp`);
  // Espaço: o .gz e o SQLite descomprimido existem juntos por um momento; o índice vigente fica onde está até a troca.
  const precisa = Number(m.bytes || 0) + Number(m.bytes_sqlite || Number(m.bytes || 0) * 5) + ctx.margem;
  let livre = ctx.espacoLivre(indice);
  const antigo = existsSync(final) && !(await arquivoEhEnxuto(final));
  if (livre < precisa && antigo) {
    // O arquivo do formato antigo não serve a este motor (decisão de 04/11/2026: o enxuto o substitui): sai antes, para dar lugar ao novo.
    rmSync(final, { force: true });
    log(`  índice ${camada}: arquivo do formato antigo removido para dar espaço ao novo (não é lido por este motor)`);
    livre = ctx.espacoLivre(indice);
  }
  if (livre < precisa) {
    return { acao: 'sem-espaco', motivo: `faltou espaço em disco para a camada ${camada}: preciso de ${mb(precisa)} (arquivo comprimido ${mb(Number(m.bytes || 0))} + índice ${mb(Number(m.bytes_sqlite || 0))} + folga ${mb(ctx.margem)}) e há ${mb(livre)} livres em ${indice}. Nada foi alterado; libere espaço e rode \`legalsquad ref sync\` de novo (continua de onde parou)` };
  }
  const arquivo = typeof pub.arquivo === 'string' ? pub.arquivo : `${rotasDaCamada(camada).atual.replace(/\/atual$/, '')}/${m.versao}/arquivo`;
  let proximoAviso = 0.25;
  const onProgresso = (feito) => {
    const frac = feito / Number(m.bytes || feito || 1);
    if (frac >= proximoAviso && frac < 1) { log(`    ${camada}: ${Math.round(frac * 100)}% (${mb(feito)} de ${mb(Number(m.bytes))})`); proximoAviso += 0.25; }
  };
  try {
    const baixado = await baixarConferido(ctx.servidorUrl, arquivo, gz, { ...ctx.http, bytes: m.bytes, sha256: m.sha256_arquivo, onProgresso });
    if (!baixado.ok) return { acao: 'falhou', motivo: baixado.motivo, indisponivel: baixado.indisponivel };
    const desc = await descomprimirConferido(gz, tmp, m.sha256_sqlite);
    if (!desc.ok) return { acao: 'falhou', motivo: desc.motivo };
    rmSync(gz, { force: true }); // o .gz já cumpriu: libera o disco antes do hash lógico
    const db = new DatabaseSync(tmp, { readOnly: true });
    let hash;
    let meta;
    try {
      if (!ehIndiceEnxuto(db)) return { acao: 'falhou', motivo: 'o arquivo baixado não tem o esquema do índice enxuto (legalsquad-indice/3)' };
      hash = hashLogico(db);
      meta = lerMeta(db);
    } finally { db.close(); }
    if (hash !== m.sha256_conteudo) return { acao: 'falhou', motivo: `o conteúdo das tabelas não confere com o hash lógico assinado (${hash.slice(0, 12)}…)` };
    if (meta.sha256_conteudo && meta.sha256_conteudo !== hash) return { acao: 'falhou', motivo: 'a meta do SQLite declara outro hash lógico' };
    renameSync(tmp, final); // troca atômica: o vigente só sai do lugar com o novo verificado
    return { acao: 'baixado', versao: m.versao, bytes: baixado.bytes, bytes_sqlite: statSync(final).size, sha256_conteudo: hash, sha256_sqlite: desc.sha };
  } finally {
    rmSync(gz, { force: true });
    rmSync(tmp, { force: true });
  }
}

/**
 * Um passo da atualização: confere o manifesto assinado da diferença (assinatura pelo anel, formato,
 * camada, de/para do passo, hash lógico de partida igual ao do índice daqui), baixa o arquivo
 * conferindo o sha256, e aplica numa transação que só fica se chegar ao `sha256_conteudo_para`
 * assinado. `atual` é `{ versao, sha256_conteudo }` do índice local antes do passo.
 */
async function aplicarPassoConferido(ctx, camada, atual, { de, para, manifesto: md, assinatura: assinaturaB64, arquivo }) {
  const { DatabaseSync } = await carregarSqlite();
  const assinatura = verificarAssinaturaDoManifesto(md, assinaturaB64, ctx.anel);
  if (!assinatura.ok) return { ok: false, motivo: `diferença ${de}..${para} recusada: ${assinatura.motivo}` };
  if (md.formato !== FORMATO_DELTA_DOCS) return { ok: false, motivo: `formato de diferença desconhecido: ${md.formato}` };
  if (md.de !== de || md.para !== para || de !== atual.versao) return { ok: false, motivo: `o manifesto da diferença não é de/para ${atual.versao}..${para}` };
  if ((md.camada || CAMADA_NACIONAL) !== camada) return { ok: false, motivo: `o manifesto da diferença é da camada "${md.camada}", não de "${camada}"` };
  if (md.sha256_conteudo_de !== atual.sha256_conteudo) return { ok: false, motivo: `a diferença ${de}..${para} não parte do índice que está aqui (hash lógico)` };
  if (!/^[a-f0-9]{64}$/.test(String(md.sha256_conteudo_para || ''))) return { ok: false, motivo: 'manifesto da diferença sem o hash lógico de chegada' };
  if (Number(md.bytes) > TETO_DELTA_GZIP) return { ok: false, motivo: `a diferença ${de}..${para} é grande demais para aplicar em memória (${mb(Number(md.bytes))}): baixe a camada`, grande: true };
  const { indice } = caminhosDaReferencia(ctx.raiz);
  const gz = join(indice, `.delta-${camada}.${process.pid}.gz.tmp`);
  try {
    const caminho = typeof arquivo === 'string' ? arquivo : `${rotasDaCamada(camada).delta(de, para)}/arquivo`;
    const baixado = await baixarConferido(ctx.servidorUrl, caminho, gz, { ...ctx.http, bytes: md.bytes, sha256: md.sha256_arquivo });
    if (!baixado.ok) return { ok: false, motivo: baixado.motivo, indisponivel: baixado.indisponivel };
    let corpo;
    try {
      corpo = JSON.parse(gunzipSync(readFileSync(gz), { maxOutputLength: TETO_DELTA_JSON }).toString('utf8'));
    } catch (erro) {
      return { ok: false, motivo: `diferença ilegível ou grande demais: ${erro.message}`, grande: erro?.code === 'ERR_BUFFER_TOO_LARGE' };
    }
    if (corpo?.formato !== md.formato || corpo.de !== de || corpo.para !== para) return { ok: false, motivo: 'o corpo da diferença não é de/para as versões do manifesto' };
    const db = new DatabaseSync(join(indice, arquivoDaCamada(camada)));
    let resultado;
    try {
      resultado = aplicarDeltaDocsConferido(db, corpo, { hashEsperado: md.sha256_conteudo_para, metaNova: { versao: para } });
    } finally {
      db.close();
    }
    if (!resultado.ok) return { ok: false, motivo: `a diferença ${de}..${para} aplicada não chegou ao hash assinado: desfeita` };
    return { ok: true, hash: resultado.hash, bytes: baixado.bytes, contagens: md.contagens || {} };
  } finally {
    rmSync(gz, { force: true });
  }
}

/**
 * Da versão local à do manifesto assinado `pub`: pede o plano da cadeia ao servidor
 * (`/cadeia/<versão local>?para=<versão>`) e aplica as diferenças em sequência, conferindo a
 * assinatura e o hash lógico a cada passo. O motor não confia só no plano: recusa cadeia de mais de
 * 8 passos ou que some mais da metade da camada (gzip dos dois lados), e nesses casos, ou sem cadeia
 * publicada, devolve `sem-delta` e o chamador baixa a camada inteira UMA vez. `parcial` diz até onde o
 * índice local chegou quando um passo do meio falhou (os anteriores ficaram, conferidos).
 */
async function aplicarDiferenca(ctx, camada, local, pub) {
  const m = pub.manifesto;
  const r = await chamarServidor(ctx.servidorUrl, `${rotasDaCamada(camada).cadeia(local.versao)}?para=${encodeURIComponent(m.versao)}`, ctx.http);
  if (r.indisponivel) return { acao: 'falhou', motivo: r.motivo, indisponivel: true };
  let passos;
  let viaCadeia = false;
  if (r.ok && r.json?.formato === FORMATO_CADEIA) {
    const plano = r.json;
    if (plano.baixar_camada) return { acao: 'sem-delta', baixar_camada: true, motivo: plano.motivo || 'o servidor mandou baixar a camada inteira' };
    if (plano.para !== m.versao || (plano.camada || CAMADA_NACIONAL) !== camada) return { acao: 'sem-delta', motivo: 'o plano da cadeia não leva à versão assinada que o servidor anunciou' };
    passos = Array.isArray(plano.passos) ? plano.passos : [];
    if (!passos.length) return { acao: 'sem-delta', motivo: 'o plano da cadeia veio sem passos' };
    viaCadeia = true;
  } else if (r.status === 404 || (r.ok && r.json?.formato !== FORMATO_CADEIA)) {
    // Servidor sem a rota de cadeia: o par direto.
    const rd = await chamarServidor(ctx.servidorUrl, rotasDaCamada(camada).delta(local.versao, m.versao), ctx.http);
    if (rd.indisponivel) return { acao: 'falhou', motivo: rd.motivo, indisponivel: true };
    if (!rd.ok) return { acao: 'sem-delta', motivo: rd.status === 404 ? 'diferença não publicada entre essas versões' : rd.motivo || `HTTP ${rd.status}` };
    passos = [{ de: local.versao, para: m.versao, manifesto: rd.json?.manifesto, assinatura: rd.json?.assinatura, arquivo: rd.json?.arquivo }];
  } else {
    return { acao: 'sem-delta', motivo: r.motivo || `HTTP ${r.status} no plano da cadeia` };
  }
  if (passos.length > MAX_PASSOS_CADEIA) return { acao: 'sem-delta', motivo: `a cadeia tem ${passos.length} passos, mais que o teto de ${MAX_PASSOS_CADEIA}` };
  const soma = passos.reduce((s, p) => s + Number(p?.bytes || p?.manifesto?.bytes || 0), 0);
  if (Number(m.bytes) > 0 && soma > Number(m.bytes) * FRACAO_TETO_CADEIA) return { acao: 'sem-delta', motivo: `a cadeia soma ${mb(soma)}, mais da metade da camada (${mb(Number(m.bytes))})` };
  let atual = { versao: local.versao, sha256_conteudo: local.sha256_conteudo };
  let bytes = 0;
  const feitos = [];
  for (const passo of passos) {
    if (!passo?.manifesto || typeof passo.manifesto !== 'object') return { acao: 'sem-delta', motivo: 'passo da cadeia sem manifesto', ...(feitos.length ? { parcial: atual } : {}) };
    const t0 = Date.now();
    const p = await aplicarPassoConferido(ctx, camada, atual, passo);
    if (!p.ok) return { acao: p.indisponivel ? 'falhou' : 'sem-delta', motivo: p.motivo, indisponivel: p.indisponivel, ...(feitos.length ? { parcial: atual } : {}) };
    atual = { versao: passo.para, sha256_conteudo: p.hash };
    bytes += p.bytes;
    feitos.push({ de: passo.de, para: passo.para, bytes: p.bytes, ms: Date.now() - t0 });
  }
  if (atual.versao !== m.versao || atual.sha256_conteudo !== m.sha256_conteudo) return { acao: 'sem-delta', motivo: 'a cadeia aplicada não chegou ao hash lógico do índice assinado', parcial: atual };
  return { acao: 'delta', de: local.versao, versao: m.versao, bytes, sha256_conteudo: atual.sha256_conteudo, passos: feitos, via_cadeia: viaCadeia };
}

/** Uma camada: manifesto assinado, em dia / diferença em cadeia / camada inteira. Não grava o estado: devolve a ação. */
async function sincronizarCamada(ctx, camada, estado, { fixada, log, agora }) {
  const local = estado.camadas[camada];
  const arquivoLocal = join(caminhosDaReferencia(ctx.raiz).indice, arquivoDaCamada(camada));
  const temLocal = Boolean(local?.versao && local.formato === FORMATO_INDICE && existsSync(arquivoLocal));
  const legado = existsSync(arquivoLocal) && !temLocal && !(await arquivoEhEnxuto(arquivoLocal));
  const r = await chamarServidor(ctx.servidorUrl, fixada ? rotasDaCamada(camada).versao(fixada) : rotasDaCamada(camada).atual, ctx.http);
  if (r.indisponivel) return { acao: 'falhou', motivo: r.motivo, indisponivel: true };
  if (r.status === 404) return { acao: 'nao-publicada', motivo: camada === CAMADA_NACIONAL ? 'o servidor não publicou o índice nacional' : 'o servidor não publica esta camada (nome que ele não conhece, ou ainda sem índice)' };
  if (!r.ok) return { acao: 'falhou', motivo: `HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ''}` };
  const conferido = conferirManifestoDoIndice(r.json, camada, ctx.anel);
  if (!conferido.ok) return { acao: 'falhou', motivo: conferido.motivo };
  const m = r.json.manifesto;
  if (temLocal && local.versao === m.versao && local.sha256_conteudo === m.sha256_conteudo) return { acao: 'em-dia', versao: local.versao, kid: conferido.kid, manifesto: m };
  let res = null;
  if (temLocal) {
    res = await aplicarDiferenca(ctx, camada, local, r.json);
    if (res.acao === 'sem-delta') log(`  índice ${camada}: ${res.motivo}; baixando a camada inteira`);
  }
  if (!res || res.acao === 'sem-delta') {
    const motivoDoDelta = res?.motivo || (legado ? 'índice do formato antigo, substituído pelo enxuto' : null);
    const parcial = res?.parcial || null;
    res = await baixarIndiceInteiro(ctx, camada, r.json, { log });
    if (motivoDoDelta && res.acao === 'baixado') res.motivo_sem_delta = motivoDoDelta;
    if (res.acao === 'falhou' && parcial) res.parcial = parcial;
  }
  if (res.acao === 'falhou' && res.parcial && local) {
    // Passos da cadeia que ficaram (conferidos) antes de um que falhou: o estado diz onde o índice está.
    estado.camadas[camada] = { ...local, versao: res.parcial.versao, sha256_conteudo: res.parcial.sha256_conteudo, sha256_sqlite: undefined, aplicado_em: agora().toISOString() };
  }
  return { ...res, kid: conferido.kid, manifesto: m };
}

/** A camada nacional (a raiz de tudo) está aqui, verificada, no formato enxuto? */
function nacionalPresente(raiz, estado) {
  const nacional = estado.camadas[CAMADA_NACIONAL];
  return Boolean(nacional?.versao && !nacional.nao_publicada && nacional.formato === FORMATO_INDICE && existsSync(join(caminhosDaReferencia(raiz).indice, arquivoDaCamada(CAMADA_NACIONAL))));
}

/**
 * Sincroniza o índice. Sem `camadas`, TODAS as que o servidor publica (regra 4 do plano). Devolve
 * `{ ok, camadas: [{camada, acao, versao, motivo, ...}], estado, parou?, completo }`.
 * `acao`: `em-dia`, `baixado`, `delta`, `nao-publicada`, `sem-espaco` (para o sync, sem tocar no vigente),
 * `falhou` (o que estava aqui segue valendo), `adiada` (não tentada porque o sync parou antes).
 * `ok` é a camada nacional verificada (nova ou a que já estava).
 */
export async function sincronizarIndice({
  servidorUrl, license, anel, raiz = raizDaReferencia(), camadas = null, versoes = {},
  fetchImpl = globalThis.fetch, esperas, esperar, agora = () => new Date(), log = () => {},
  espacoLivre = espacoLivreEm, margem = MARGEM_DE_DISCO, ociosoMs,
} = {}) {
  const trava = travarIndice(raiz);
  if (!trava.ok) return { ok: false, motivo: trava.motivo, camadas: [], estado: lerEstadoDaReferencia(raiz) };
  const ctx = {
    raiz, servidorUrl, anel, margem, espacoLivre,
    http: { license, instalacao: instalacaoDaReferencia(raiz, license), fetchImpl, ...(esperas ? { esperas } : {}), ...(esperar ? { esperar } : {}), ...(ociosoMs ? { ociosoMs } : {}) },
  };
  const saida = [];
  let estado = lerEstadoDaReferencia(raiz);
  let parou = null;
  let publicadas = null;
  try {
    const sobras = limparSobras(raiz);
    if (trava.orfao) log('  sobra de um sync anterior: lock órfão (processo que já não existe) removido');
    if (sobras.length) log(`  sobras de um sync anterior apagadas: ${sobras.map((s) => `${s.nome} (${mb(s.bytes)})`).join(', ')}`);
    const interrompido = estado.progresso && !estado.progresso.concluido_em;
    if (interrompido) log(`  o último sync parou em ${estado.progresso.camada_atual || 'início'} (${estado.progresso.fase || '?'}); as camadas concluídas ficam, continuando das que faltam`);
    let alvo = camadas;
    if (!alvo) {
      const lista = await listarCamadasDoServidor({ servidorUrl, license, raiz, fetchImpl, esperas, esperar });
      if (!lista.ok) return { ok: nacionalPresente(raiz, estado), motivo: `não consegui a lista de camadas do servidor (${lista.motivo}); o que já estava aqui segue valendo`, camadas: [], estado };
      publicadas = lista.camadas;
      alvo = ordemDeDownload(lista.camadas.map((c) => c.camada));
      const tamanho = lista.camadas.reduce((s, c) => s + (c.bytes || 0), 0);
      log(`  ${alvo.length} camada(s) publicadas pelo servidor, até ${mb(tamanho)} no total (só baixa o que faltar ou mudou)`);
    } else {
      alvo = ordemDeDownload(alvo.filter((c) => RE_CAMADA.test(c)));
    }
    estado.progresso = { pid: process.pid, iniciado_em: agora().toISOString(), total: alvo.length, concluidas: 0 };
    for (const [i, camada] of alvo.entries()) {
      if (parou) { saida.push({ camada, acao: 'adiada', motivo: `o sync parou antes (${parou})` }); continue; }
      const t0 = Date.now();
      estado.progresso = { ...estado.progresso, camada_atual: camada, fase: 'sincronizando', posicao: i + 1 };
      gravarEstadoDaReferencia(raiz, estado);
      const fixada = versoes?.[camada] && RE_VERSAO.test(String(versoes[camada])) ? String(versoes[camada]) : null;
      const tam = publicadas?.find((c) => c.camada === camada);
      log(`  [${i + 1}/${alvo.length}] ${camada}${tam?.bytes ? ` (${mb(tam.bytes)} comprimido)` : ''}`);
      const res = await sincronizarCamada(ctx, camada, estado, { fixada, log, agora });
      if (res.acao === 'baixado' || res.acao === 'delta') {
        estado.camadas[camada] = {
          versao: res.versao,
          arquivo: arquivoDaCamada(camada),
          formato: FORMATO_INDICE,
          sha256_conteudo: res.sha256_conteudo,
          // O sha256 do arquivo só vale para o que foi baixado inteiro: a diferença muda as páginas.
          ...(res.sha256_sqlite ? { sha256_sqlite: res.sha256_sqlite } : {}),
          kid: res.kid,
          assinatura_conferida_em: agora().toISOString(),
          aplicado_em: agora().toISOString(),
          contagens: res.manifesto?.contagens || null,
          ...(res.acao === 'delta' ? { ultimo_delta: { de: res.de, para: res.versao, em: agora().toISOString(), passos: (res.passos || []).map((x) => `${x.de}..${x.para}`) } } : estado.camadas[camada]?.ultimo_delta ? { ultimo_delta: estado.camadas[camada].ultimo_delta } : {}),
        };
      }
      if (['em-dia', 'baixado', 'delta'].includes(res.acao)) {
        estado.camadas[camada] = { ...estado.camadas[camada], verificado_em: agora().toISOString(), servidor: servidorUrl };
        delete estado.camadas[camada].nao_publicada;
      }
      if (res.acao === 'nao-publicada') estado.camadas[camada] = { ...(estado.camadas[camada] || {}), nao_publicada: true, verificado_em: agora().toISOString() };
      const { manifesto, ...resto } = res;
      void manifesto;
      saida.push({ camada, ...resto, ms: Date.now() - t0 });
      estado.progresso = { ...estado.progresso, concluidas: i + 1, camada_atual: null, fase: null };
      // Gravar a cada camada: um sync morto no meio não perde o que já foi verificado.
      gravarEstadoDaReferencia(raiz, estado);
      if (res.acao === 'sem-espaco') { parou = 'sem espaço em disco'; log(`  ${res.motivo}`); }
    }
    estado.formato = 2;
    estado.servidor = servidorUrl;
    estado.atualizado_em = agora().toISOString();
    const faltam = alvo.filter((c) => !estado.camadas[c]?.versao || estado.camadas[c].formato !== FORMATO_INDICE || !existsSync(join(caminhosDaReferencia(raiz).indice, arquivoDaCamada(c))));
    const naoPub = alvo.filter((c) => estado.camadas[c]?.nao_publicada);
    estado.cobertura = { completa: !camadas && !faltam.some((c) => !naoPub.includes(c)), limitada_por_flag: Boolean(camadas), publicadas: alvo.length, presentes: alvo.length - faltam.length, faltam: faltam.filter((c) => !naoPub.includes(c)), verificada_em: agora().toISOString() };
    estado.progresso = { ...estado.progresso, concluido_em: agora().toISOString(), parou: parou || null };
    gravarEstadoDaReferencia(raiz, estado);
  } finally {
    trava.soltar();
  }
  return { ok: nacionalPresente(raiz, estado), camadas: saida, estado, parou, completo: Boolean(estado.cobertura?.completa) };
}

/** Uma linha por camada, para o `acervo sync` e o `ref sync` imprimirem igual. */
export function descreverSyncDoIndice(r) {
  const linhas = [];
  if (r.motivo && !r.camadas?.length) return [`  ⚠️  índice não sincronizado: ${r.motivo}`];
  const naoPublicadas = r.camadas.filter((c) => c.acao === 'nao-publicada').map((c) => c.camada);
  const emDia = r.camadas.filter((c) => c.acao === 'em-dia').length;
  for (const c of r.camadas) {
    if (c.acao === 'nao-publicada') continue;
    if (c.acao === 'em-dia') continue;
    if (c.acao === 'adiada') continue;
    if (c.acao === 'baixado') linhas.push(`  índice ${c.camada}: versão ${c.versao} baixada e verificada (assinatura, sha256 e hash das tabelas), ${(c.bytes / 1e6).toFixed(1)} MB em ${Math.round(c.ms / 1000)} s${c.motivo_sem_delta ? ` (${c.motivo_sem_delta})` : ''}`);
    else if (c.acao === 'delta') linhas.push((c.passos || []).length > 1
      ? `  índice ${c.camada}: de ${c.de} para ${c.versao} em ${c.passos.length} diferenças (${c.passos.map((x) => x.para).join(' → ')}), cada uma numa transação e conferida pelo hash assinado`
      : `  índice ${c.camada}: diferença de ${c.de} para ${c.versao} aplicada numa transação e conferida pelo hash da versão nova`);
    else if (c.acao === 'sem-espaco') linhas.push(`  ⚠️  índice ${c.camada}: ${c.motivo}`);
    else linhas.push(`  ⚠️  índice ${c.camada}: não atualizado (${c.motivo}); o que já estava aqui segue valendo`);
  }
  if (emDia) linhas.push(`  ${emDia} camada(s) já em dia`);
  const adiadas = r.camadas.filter((c) => c.acao === 'adiada').map((c) => c.camada);
  if (adiadas.length) linhas.push(`  ${adiadas.length} camada(s) ainda por baixar (o sync parou): ${adiadas.slice(0, 8).join(', ')}${adiadas.length > 8 ? '…' : ''}`);
  if (naoPublicadas.length) linhas.push(`  camadas pedidas que o servidor ainda não publica: ${naoPublicadas.join(', ')} (o servidor confere essas citações direto, sem índice local)`);
  const cob = r.estado?.cobertura;
  if (cob) linhas.push(cob.completa ? `  índice completo: ${cob.presentes} de ${cob.publicadas} camada(s) publicadas` : `  índice INCOMPLETO: ${cob.presentes} de ${cob.publicadas} camada(s)${cob.limitada_por_flag ? ' (sync limitado por --camadas)' : ''}${cob.faltam?.length ? `; faltam ${cob.faltam.slice(0, 8).join(', ')}${cob.faltam.length > 8 ? '…' : ''}` : ''}`);
  return linhas;
}

/** O que a máquina tem, para o `diagnostico` e o `ref estado`: versão e tamanho de cada camada e do cache de texto. */
export function resumoDaReferencia(raiz) {
  const { indice, textos } = caminhosDaReferencia(raiz);
  const estado = lerEstadoDaReferencia(raiz);
  const camadas = Object.entries(estado.camadas || {}).map(([camada, e]) => {
    const arquivo = join(indice, arquivoDaCamada(camada));
    let bytes;
    try { bytes = statSync(arquivo).size; } catch { bytes = null; }
    return { camada, versao: e.versao || null, formato: e.formato || FORMATO_INDICE_ANTIGO, nao_publicada: !!e.nao_publicada, bytes, verificado_em: e.verificado_em || null, presente: bytes !== null && e.formato === FORMATO_INDICE };
  });
  let arquivosDeTexto = 0;
  let bytesDeTexto = 0;
  try {
    for (const nome of readdirSync(textos)) {
      if (!/^(?:art-)?[a-f0-9]{64}(?:\.json)?$/.test(nome)) continue;
      arquivosDeTexto += 1;
      try { bytesDeTexto += statSync(join(textos, nome)).size; } catch { /* sumiu no meio */ }
    }
  } catch { /* sem cache ainda */ }
  return { raiz, estado, camadas, cobertura: estado.cobertura || null, progresso: estado.progresso || null, textos: { arquivos: arquivosDeTexto, bytes: bytesDeTexto }, ilegivel: estado.ilegivel || null };
}
