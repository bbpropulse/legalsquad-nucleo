// Busca ÚNICA do índice local: legislação e jurisprudência numa chamada, sobre o MESMO índice (a
// jurisprudência é documento do índice, `tipo = jurisprudencia`; camada e grupo são detalhe interno de
// distribuição e não aparecem aqui: regra 3 do plano da Legis). Devolve duas listas, uma por tipo.
//
// Com `opcoes.servidor`, o diploma achado pelo título, ementa, apelido e sumário tem o texto lido do
// servidor (conferido pelo `sha256_texto` do índice) para achar o artigo certo (src/busca/enxuto.js).
import { areaDoDicionario, carregarDicionario } from './dicionario.js';
import { buscarLegislacao } from './legislacao.js';
import { refinarComServidor } from './enxuto.js';

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
  const leg = opcoes.so === 'juris' ? { resultados: [] } : await pesquisar('norma');
  const jur = opcoes.so === 'leg' ? { resultados: [] } : await pesquisar('juris');
  if (comServidor && leg.refino?.erros) avisos.push(`servidor: ${leg.refino.erros} texto(s) de diploma não puderam ser lidos; a lista de legislação vem sem o refino por artigo nesses diplomas`);
  return { legislacao: leg.resultados, jurisprudencia: jur.resultados, detalhe: { leg, jur }, avisos };
}
