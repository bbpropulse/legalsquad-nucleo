// Índice ENXUTO no motor (plano de arquitetura da Legis, 04/11/2026): o arquivo da camada não tem a
// tabela `dispositivo` nem trecho por artigo; o documento é uma linha pequena, com a lista compacta
// dos artigos que ele tem (`rotulos_artigos`, sem texto). O texto vive no servidor.
//
// O que este módulo faz:
//   - dá ao banco enxuto o que o resto do motor espera do `doc` (coluna `trecho`);
//   - lê a lista compacta de artigos (a mesma que o gerador do servidor grava) para validar "art. 312";
//   - parte o texto de um diploma (buscado no servidor e conferido pelo `sha256_texto` do índice) em
//     artigos, e acha o artigo certo por tema dentro do diploma (`refinarComServidor`). A leitura de um
//     artigo CITADO não passa por aqui: é `POST /v1/ref/artigos`, com prova assinada (src/ref-artigos.js).
import { cortarDispositivos } from '../ref-leitor/dispositivos.js';
import { cobertura } from './legislacao.js';
import { normalizar } from './texto.js';

/**
 * Dá ao `doc` do índice enxuto o que o resto do motor espera: uma view TEMP (o arquivo fica só de
 * leitura) com a coluna `trecho`, que aqui é o resumo do documento (`ementa`; nas súmulas e teses, o
 * enunciado, que o gerador do servidor junta à ementa).
 */
export function prepararBancoEnxuto(db) {
  db.exec('CREATE TEMP VIEW doc AS SELECT *, ementa AS trecho FROM main.doc');
}

// ── lista compacta de artigos (mesmo formato de src/indice-enxuto.js do servidor) ──────────────────

function artigoDoCaminho(caminho) {
  const segs = String(caminho || '').split('/');
  const i = segs.findIndex((s) => /^art-./.test(s));
  if (i < 0) return null;
  return { prefixo: segs.slice(0, i).join('/'), chave: segs[i].slice(4) };
}

/** O artigo (`art-312`, `art-312-a`) está na lista compacta? `null`: o documento não tem lista (o índice não sabe). */
export function temArtigo(codificado, caminhoDoArtigo) {
  if (!codificado) return null;
  const a = artigoDoCaminho(caminhoDoArtigo);
  if (!a) return null;
  for (const grupo of String(codificado).split(';')) {
    const barra = grupo.indexOf('|');
    const prefixo = barra < 0 ? '' : grupo.slice(0, barra);
    if (prefixo !== a.prefixo) continue;
    for (const item of (barra < 0 ? grupo : grupo.slice(barra + 1)).split(',')) {
      if (item === a.chave) return true;
      const m = /^(\d+):(\d+)$/.exec(item);
      if (m && /^\d+$/.test(a.chave) && Number(a.chave) >= Number(m[1]) && Number(a.chave) <= Number(m[2])) return true;
    }
  }
  return false;
}

// ── o texto do diploma, partido em artigos ─────────────────────────────────────────────────────────

/** As opções do corte são as da carga: a Constituição e os regimentos têm regra própria. */
function opcoesDeCorte(doc) {
  return { docId: doc.id, cf: doc.id === 'fed:cf:1988', regimento: /regiment/i.test(`${doc.subtipo || ''} ${doc.id}`) };
}

/**
 * Artigos de topo do texto do diploma: `[{ caminho, rotulo, texto }]`, com o texto do artigo e o dos
 * filhos (parágrafos, incisos) juntos. Usa o mesmo corte que montou o servidor, para o caminho bater
 * com o que `rotulos_artigos` guarda.
 */
const CORTES = new Map(); // sha256 do texto -> artigos (os últimos 40 diplomas: o mesmo código aparece em muitas consultas)
export function artigosDoTexto(texto, doc) {
  const chave = doc.sha256_texto || null;
  if (chave && CORTES.has(chave)) { const v = CORTES.get(chave); CORTES.delete(chave); CORTES.set(chave, v); return v; }
  const artigos = cortarEmArtigos(texto, doc);
  if (chave) { CORTES.set(chave, artigos); if (CORTES.size > 40) CORTES.delete(CORTES.keys().next().value); }
  return artigos;
}

function cortarEmArtigos(texto, doc) {
  const { dispositivos } = cortarDispositivos(texto, opcoesDeCorte(doc));
  const porArtigo = new Map();
  for (const d of dispositivos) {
    const a = artigoDoCaminho(d.caminho);
    if (!a) continue;
    const chave = `${a.prefixo ? `${a.prefixo}/` : ''}art-${a.chave}`;
    let g = porArtigo.get(chave);
    if (!g) { g = { caminho: chave, partes: [] }; porArtigo.set(chave, g); }
    g.partes.push(d.texto || '');
  }
  return [...porArtigo.values()].map((g) => ({ caminho: g.caminho, texto: g.partes.join(' ') }));
}

const TETO_DO_ARTIGO = 1500; // caracteres lidos de cada artigo no ranking

/**
 * Refina a lista de legislação com o texto dos diplomas candidatos: busca o texto no servidor (cache
 * por sha256, conferido pelo hash do índice), parte em artigos, dá nota a cada artigo pela cobertura
 * ponderada dos termos e refaz a nota do documento com o melhor artigo (a mesma fórmula do índice de
 * conteúdo: 0,9 x cobertura do artigo, mais 0,3 ou 0,55 x quando o diploma foi citado ou é do assunto).
 *
 * `opcoes`: `quantos` (candidatos refinados, padrão 8), `soFoco` (só diplomas citados ou do assunto, e
 * os 2 primeiros), `concorrencia` (padrão 4). Devolve `{ resultados, buscas, bytes, erros }`.
 */
export async function refinarComServidor(ref, leg, { quantos = 8, soFoco = false, concorrencia = 4, texto: textoDe = null } = {}) {
  const interno = leg.interno;
  const stats = { docs_refinados: 0, do_cache: 0, do_servidor: 0, bytes: 0, erros: 0, sem_texto: 0 };
  if (!interno) return { ...leg, refino: stats };
  const { termos, acrescimo, pesos, formasCitadas } = interno;
  // Candidatos: os diplomas citados ou do assunto (a consulta aponta para eles) e os primeiros da lista.
  const comLista = leg.resultados.filter((d) => d.rotulos_artigos);
  const focados = comLista.filter((d) => d.foco).slice(0, 8);
  const primeiros = comLista.filter((d) => !d.foco).slice(0, soFoco ? 2 : quantos);
  const candidatos = [...focados, ...primeiros];
  const lerTexto = textoDe || ((d) => ref.textoDoDocumento(d));
  const fila = [...candidatos];
  const obtidos = new Map();
  await Promise.all(Array.from({ length: Math.min(concorrencia, fila.length) }, async () => {
    for (let d = fila.shift(); d; d = fila.shift()) {
      const r = await lerTexto(d);
      if (!r?.texto) { stats.sem_texto += 1; stats.erros += r?.motivo ? 1 : 0; continue; }
      stats.docs_refinados += 1;
      if (r.fonte === 'cache') stats.do_cache += 1; else { stats.do_servidor += 1; stats.bytes += r.texto.length; }
      obtidos.set(d.id, r.texto);
    }
  }));
  const refinados = leg.resultados.map((d) => {
    const texto = obtidos.get(d.id);
    if (!texto) return d;
    const alvo = termos.filter((t) => !formasCitadas.has(t.palavra) || t.numero);
    const termosAlvo = d.foco === 'citado' && alvo.length ? alvo : termos;
    const artigos = artigosDoTexto(texto, d).map((a) => {
      const t = a.texto.slice(0, TETO_DO_ARTIGO);
      const cob = cobertura(termosAlvo, pesos, t);
      const cobX = acrescimo.length ? cobertura(acrescimo, pesos, t) : 0;
      return { id: `${d.id}#${a.caminho}`, rotulo: a.caminho, trecho: t.slice(0, 200), nota: cob + 0.15 * cobX };
    }).filter((a) => a.nota > 0).sort((a, b) => b.nota - a.nota);
    const melhor = artigos[0]?.nota || 0;
    const extra = 0.9 * melhor + (d.foco === 'citado' ? 0.3 * melhor : d.foco === 'assunto' ? 0.55 * melhor : 0);
    return { ...d, nota: Number((d.nota + extra).toFixed(4)), cobertura_dispositivo: Number(melhor.toFixed(3)), dispositivos: artigos.slice(0, 3).map((a) => ({ ...a, nota: Number(a.nota.toFixed(3)) })) };
  });
  refinados.sort((a, b) => b.nota - a.nota);
  return { ...leg, resultados: refinados.slice(0, interno.limite), refino: stats };
}

export { normalizar };
