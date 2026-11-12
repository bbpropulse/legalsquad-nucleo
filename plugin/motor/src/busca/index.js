// Busca ÚNICA do índice local: legislação e jurisprudência numa chamada, sobre o MESMO índice (a
// jurisprudência é documento do índice, `tipo = jurisprudencia`; camada e grupo são detalhe interno de
// distribuição e não aparecem aqui: regra 3 do plano da Legis). Devolve duas listas, uma por tipo.
//
// Com `opcoes.servidor`, o diploma achado pelo título, ementa, apelido e sumário tem o texto lido do
// servidor (conferido pelo `sha256_texto` do índice) para achar o artigo certo (src/busca/enxuto.js).
import { areaDoDicionario, carregarDicionario } from './dicionario.js';
import { buscarLegislacao } from './legislacao.js';
import { refinarComServidor } from './enxuto.js';
import { avisoDeJulgadoAusente, documentosDoJulgado, julgadosNaConsulta, semDuplicatas, soCitacao } from './julgado.js';
import { docCols, lerDoc } from './legislacao.js';

function tentar(f) { try { return f(); } catch { return null; } }

export async function buscarTudoNoIndice(ref, q, opcoes = {}) {
  const dic = carregarDicionario(ref.raiz);
  const areaInfo = areaDoDicionario(dic, opcoes.area);
  const contexto = { bancos: ref.bancos, dic, areaInfo };
  const avisos = [];
  if (!ref.temIndice) return { legislacao: [], jurisprudencia: [], avisos: ['sem índice nesta máquina: rode `legalsquad ref sync`'] };
  const comServidor = Boolean(opcoes.servidor);
  const limite = Math.min(50, Math.max(1, Number(opcoes.limite) || 10));
  const limiteInterno = comServidor ? Math.max(30, limite) : opcoes.limite;
  const pesquisar = async (de) => {
    let r = buscarLegislacao(contexto, q, { ...opcoes, de, limite: limiteInterno, manterFoco: comServidor && de === 'norma' && opcoes.servidor.refinar !== false });
    if (comServidor && de === 'norma' && opcoes.servidor.refinar !== false) r = await refinarComServidor(ref, r, { quantos: opcoes.servidor.quantos ?? 8, soFoco: Boolean(opcoes.servidor.soFoco) });
    return { ...r, resultados: r.resultados.slice(0, limite) };
  };
  // O julgado, a súmula e o tema citados pelo número vêm primeiro, achados pelo título ou pela forma de
  // citar; o julgado que não está no índice é dito, e a consulta que é só o número não devolve outro no
  // lugar dele (11/11/2026: "REsp 1.978.268" devolvia a Súmula 268 do STJ).
  const julgados = julgadosNaConsulta(q);
  const porNumero = [];
  const ausentes = [];
  for (const j of julgados) {
    const docs = documentosDoJulgado(ref.bancos, j, { lerDoc, docCols });
    if (docs.length) porNumero.push(...docs); else ausentes.push(j);
  }
  const citacaoDeJuris = (() => {
    if (julgados.length || typeof ref.resolverLocal !== 'function') return null;
    const r = tentar(() => ref.resolverLocal(q));
    if (!r || !['sumula', 'tema', 'oj', 'precedente'].includes(r.tipo)) return null;
    return r;
  })();
  if (citacaoDeJuris && citacaoDeJuris.status === 'encontrada') { const d = tentar(() => ref.doc(citacaoDeJuris.doc_id)); if (d) porNumero.push({ ...d, foco: 'citado', nota: 10 }); }
  if (citacaoDeJuris && citacaoDeJuris.status === 'ambigua') for (const c of citacaoDeJuris.candidatos || []) { const d = tentar(() => ref.doc(c.id)); if (d && d.tipo === 'jurisprudencia') porNumero.push({ ...d, foco: 'citado', nota: 10 }); }
  for (const j of ausentes) avisos.push(avisoDeJulgadoAusente(j));
  if (citacaoDeJuris && citacaoDeJuris.status === 'nao_encontrada') avisos.push(`${citacaoDeJuris.chave || q} não está no índice desta máquina; confira na fonte oficial do tribunal`);
  const citacoes = [...julgados.map((j) => j.bruto), ...(citacaoDeJuris ? [q] : [])];
  // A súmula ou o tema pelo número, com o tribunal ("Súmula 437 do TST"): o resto da consulta decide se ela é só a citação.
  const daSumula = citacaoDeJuris ? (String(q).match(/(?:s[úu]mula(?:\s+vinculante)?|tema(?:\s+repetitivo|\s+de\s+repercuss[ãa]o\s+geral)?|oj(?:\s+[\w-]+)?)\s*(?:n[º°o.]\s*)?\d[\d.]*/iu) || [])[0] : null;
  const soONumero = citacoes.length > 0 && soCitacao(q, citacaoDeJuris ? [...julgados.map((j) => j.bruto), daSumula || q] : citacoes);
  if (soONumero) {
    const vistos = new Set();
    const jurisprudencia = semDuplicatas(porNumero.filter((d) => !vistos.has(d.id) && vistos.add(d.id))).slice(0, limite);
    return { legislacao: [], jurisprudencia, detalhe: { julgados, ausentes }, avisos, so_o_numero: true, ausentes: ausentes.map((j) => j.bruto) };
  }
  const leg = opcoes.so === 'juris' ? { resultados: [] } : await pesquisar('norma');
  const jur = opcoes.so === 'leg' ? { resultados: [] } : await pesquisar('juris');
  if (porNumero.length) {
    const ids = new Set(porNumero.map((d) => d.id));
    jur.resultados = semDuplicatas([...porNumero, ...jur.resultados.filter((d) => !ids.has(d.id))]).slice(0, limite);
  }
  if (comServidor && leg.refino?.erros) avisos.push(`servidor: ${leg.refino.erros} texto(s) de diploma não puderam ser lidos; a lista de legislação vem sem o refino por artigo nesses diplomas`);
  return { legislacao: leg.resultados, jurisprudencia: jur.resultados, detalhe: { leg, jur }, avisos };
}
