// `POST /v1/ref/conferir`: confere um lote de citações em poucas idas ao banco, sem modelo.
//
// Para cada citação: o leitor de citação dá as chaves de apelido e o caminho do dispositivo; uma
// consulta resolve todas as chaves do lote; outra traz os documentos; outra os dispositivos. Se a
// citação trouxe o trecho citado, o texto do dispositivo (com os filhos) é comparado ali mesmo.
//
// Resultado por citação (`status`):
// - `encontrada`: documento (e dispositivo, se citado) existe; `selo` diz o quanto confiar;
// - `ambigua`: a forma de citar aponta para mais de um documento (ex.: "Tema 1016" sem tribunal),
//   com os candidatos; também a norma estadual citada sem a UF ("Lei Estadual 10.261/1968"), com
//   as UFs em que a base tem a norma, mesmo que seja uma só: a citação não diz o estado, e a lei
//   federal de mesmo número nunca é candidata;
// - `dispositivo_nao_encontrado`: o documento existe, o dispositivo citado não;
// - `nao_encontrada`: a citação foi lida, mas não há documento com essa chave na base;
// - `nao_reconhecida`: o leitor não reconheceu uma citação no texto.
import { lerCitacao, rotuloDeCaminho } from './citacao.js';
import { normalizarBusca } from './normalizar.js';

export const LIMITE_LOTE = 200;

/** Forma de comparar trecho: sem acento, sem pontuação, sem notas de alteração entre parênteses. */
export function formaDeTrecho(texto) {
  return normalizarBusca(
    String(texto || '')
      .replace(/\((?:reda[cç][aã]o|inclu[ií]d|acrescid|revogad|renumerad|vide|vig[eê]ncia)[^()]*\)/gi, ' ')
      .replace(/\[[^\]]*\]/g, ' '),
  )
    .replace(/(\d)\s*[ºo°ª](?![a-z])/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Ordinais e números por extenso do jeito que o motor e a peça escrevem: tolerância mínima. */
export function trechoConfere(trecho, textoDispositivo) {
  const t = formaDeTrecho(trecho);
  if (t.length < 8) return null;
  return formaDeTrecho(textoDispositivo).includes(t);
}

function entradaDaCitacao(c) {
  if (typeof c === 'string') return { texto: c };
  if (c && typeof c === 'object' && typeof c.texto === 'string') return c;
  return null;
}

/**
 * `repo` precisa de: apelidos(formas), docs(ids), dispositivos(ids), subarvores(pares), e devolve
 * linhas simples (ver repositorio.js). `opcoes.incluirTexto` devolve o texto do dispositivo.
 */
export async function conferirLote(citacoes, repo, { incluirTexto = false, versaoIndice = null } = {}) {
  const entradas = citacoes.map(entradaDaCitacao);
  const lidas = entradas.map((e) => (e ? lerCitacao(e.texto) : null));
  const formas = [...new Set(lidas.flatMap((l) => (l?.reconhecida ? [...l.chaves, ...(l.chaves_candidatas || [])] : [])))];
  const porForma = new Map();
  for (const a of formas.length ? await repo.apelidos(formas) : []) {
    if (!porForma.has(a.forma)) porForma.set(a.forma, []);
    porForma.get(a.forma).push(a);
  }

  // Primeira chave com resultado vence ("acordao tcu 2256/2019 2c" antes de "acordao tcu 2256/2019").
  const alvo = lidas.map((l) => {
    if (!l?.reconhecida) return null;
    if (l.exige_uf) {
      const docs = [...new Set((l.chaves_candidatas || []).flatMap((k) => (porForma.get(k) || []).map((a) => a.doc_id)))];
      return { forma: null, docs, exigeUf: true };
    }
    for (const k of l.chaves) if (porForma.get(k)?.length) return { forma: k, docs: porForma.get(k).map((a) => a.doc_id) };
    return { forma: l.chaves[0], docs: [] };
  });
  const docIds = [...new Set(alvo.flatMap((a) => a?.docs || []))];
  const docs = new Map((docIds.length ? await repo.docs(docIds) : []).map((d) => [d.id, d]));
  const dispIds = [];
  alvo.forEach((a, i) => {
    if (a?.docs.length === 1 && lidas[i].caminho) dispIds.push(`${a.docs[0]}#${lidas[i].caminho}`);
  });
  const disps = new Map((dispIds.length ? await repo.dispositivos([...new Set(dispIds)]) : []).map((d) => [d.id, d]));

  // Trecho citado: compara com o dispositivo e os filhos (o caput sozinho não tem os incisos).
  const pedirArvore = [];
  entradas.forEach((e, i) => {
    const id = alvo[i]?.docs.length === 1 && lidas[i].caminho ? `${alvo[i].docs[0]}#${lidas[i].caminho}` : null;
    if (e?.trecho && id && disps.has(id)) pedirArvore.push({ doc_id: alvo[i].docs[0], caminho: lidas[i].caminho });
  });
  const arvores = pedirArvore.length ? await repo.subarvores(pedirArvore) : new Map();

  const resultados = entradas.map((e, i) => {
    if (!e) return { status: 'invalida', motivo: 'cada citação é um texto ou {texto, trecho?}' };
    const l = lidas[i];
    const base = { texto: e.texto };
    if (!l.reconhecida) return { ...base, status: 'nao_reconhecida' };
    const a = alvo[i];
    base.chave = a.forma;
    if (a.exigeUf) {
      if (!a.docs.length) return { ...base, status: 'nao_encontrada', tipo: l.tipo, motivo: `${l.motivo}; nenhuma UF da base tem essa norma` };
      return {
        ...base,
        status: 'ambigua',
        tipo: l.tipo,
        motivo: `${l.motivo}; diga a UF (ex.: "(SP)" ou "do Estado de São Paulo")`,
        candidatos: a.docs.map((id) => docs.get(id)).filter(Boolean).map((d) => ({ id: d.id, titulo: d.titulo, orgao: d.orgao, uf: d.uf ?? null, selo: d.selo })),
      };
    }
    if (!a.docs.length) return { ...base, status: 'nao_encontrada', tipo: l.tipo, motivo: l.motivo || 'nenhum documento com essa forma de citar na base' };
    if (a.docs.length > 1) {
      return {
        ...base,
        status: 'ambigua',
        tipo: l.tipo,
        candidatos: a.docs.map((id) => docs.get(id)).filter(Boolean).map((d) => ({ id: d.id, titulo: d.titulo, orgao: d.orgao, selo: d.selo })),
      };
    }
    const d = docs.get(a.docs[0]);
    const out = {
      ...base,
      status: 'encontrada',
      tipo: l.tipo,
      doc_id: d.id,
      titulo: d.titulo,
      vigencia: d.vigencia,
      selo: d.selo,
      selo_motivo: d.selo_motivo,
      url_oficial: d.url_oficial,
      conferido_em: d.conferido_em,
      sha256: d.sha256_texto,
    };
    if (!l.caminho) {
      out.id = d.id;
      if (e.trecho && d.trecho) out.trecho = trechoConfere(e.trecho, d.trecho) ? 'confere' : 'nao_confere_no_resumo';
      return out;
    }
    const idDisp = `${d.id}#${l.caminho}`;
    const disp = disps.get(idDisp);
    if (!disp) {
      return { ...out, status: 'dispositivo_nao_encontrado', id: idDisp, rotulo: rotuloDeCaminho(l.caminho), motivo: 'o documento existe, mas o dispositivo citado não está no texto conferido' };
    }
    Object.assign(out, {
      id: disp.id,
      rotulo: disp.rotulo,
      situacao: disp.situacao,
      selo: disp.selo,
      selo_motivo: disp.selo_motivo || d.selo_motivo,
      sha256: disp.sha256,
    });
    if (e.trecho) {
      const arvore = arvores.get(idDisp);
      const textoArvore = arvore ? arvore.map((x) => x.texto).join('\n') : disp.texto;
      const r = trechoConfere(e.trecho, textoArvore);
      out.trecho = r === null ? 'curto_demais' : r ? 'confere' : 'nao_confere';
    }
    if (incluirTexto) out.texto_dispositivo = disp.texto;
    return out;
  });

  const resumo = {};
  for (const r of resultados) resumo[r.status] = (resumo[r.status] || 0) + 1;
  return { versao_indice: versaoIndice, total: resultados.length, resumo, resultados };
}
