// Red-team que muda a peça: o retorno do contraditor lido por código, a oferta que diz o custo de
// não corrigir e recomenda corrigir quando há ataque sem resposta, e o fix de origem humana.
//
// Medido no m2g da 0.9.83 (due diligence, ritmo rigoroso): o contraditor achou dois ataques
// DESCOBERTOS (competência da Justiça Comum e suspensão pelo Tema 1389; o bloqueio da Ipê
// descontado duas vezes, na dívida líquida e na retenção) e um ANTECIPADO com resposta insuficiente.
// A parada reapresentada tinha "Aprovar e seguir" em primeiro lugar, sem dizer o que custava não
// corrigir, e nada mudou na peça. O red-team só vale se a oferta pós-ataque deixar o custo claro.
//
// Módulo PURO (só texto recebido). SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para o `squad-state` (que registra o retorno e a decisão no ledger) e
// para o `auditar-run` (que confere o que foi feito com cada ataque), raiz e templates.

// >>> red-team:begin
/** O que não fazer custa, por natureza do ataque, dito ao profissional na parada aprovação. */
const CUSTO_DE_NAO_CORRIGIR = Object.freeze({
  fato: 'a conclusão que depende desse fato fica exposta: quem está do outro lado aponta a prova que falta ou a que contradiz, e o ponto pode cair ou perder valor',
  direito: 'a tese fica sem resposta à leitura contrária: se ela prevalecer, o ponto cai, e com ele o valor, o pedido ou a recomendação que dependem dele',
  forma: 'o pressuposto (competência, prazo, legitimidade, preço ou garantia) pode derrubar, adiar ou encarecer o resultado inteiro sem chegar ao mérito',
  outra: 'o ataque fica sem resposta na entrega, e quem decide do outro lado o usa contra ela',
});

/** As opções da parada depois do red-team, na ordem: corrigir primeiro quando há ataque sem resposta. */
const OPCOES_DEPOIS_DO_RED_TEAM = Object.freeze({
  corrigir: ['Corrigir antes de aprovar (recomendado)', 'Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
  aprovar: ['Aprovar e seguir', 'Ajustar (diga o quê)', 'Parar aqui'],
});

const semAcentoDoRedTeam = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const celulasDoRedTeam = (linha) => linha.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** A natureza do ataque pela célula ("FATO", "FORMA (preço e retenção)"). */
function naturezaDoAtaque(celula) {
  const n = semAcentoDoRedTeam(celula);
  if (/\bfato\b/.test(n)) return 'fato';
  if (/\bdireito\b/.test(n)) return 'direito';
  if (/\bforma\b/.test(n)) return 'forma';
  return 'outra';
}

/**
 * O estado do ataque: `descoberto`, `insuficiente` (antecipado com resposta insuficiente, parcial ou
 * fraca), `antecipado` ou `a-responder` (pré-mortem). Lê a célula do estado e, para a suficiência da
 * resposta, também a do lugar na peça ("ANTECIPADO | II.b | resposta insuficiente: ...").
 */
function estadoDoAtaque(estado, onde = '') {
  const e = semAcentoDoRedTeam(estado);
  const o = semAcentoDoRedTeam(onde);
  if (/\bdescoberto\b/.test(e)) return 'descoberto';
  if (/\ba responder\b/.test(e)) return 'a-responder';
  if (/\bantecipad/.test(e)) return /insuficient|parcial|fraca|incomplet/.test(`${e} ${o}`) ? 'insuficiente' : 'antecipado';
  return null;
}

/**
 * Os ataques da tabela do contraditor, na ordem: `{ n, natureza, estado, ataque, onde, fix }`. As
 * colunas vêm do cabeçalho (Natureza, Ataque, Estado, Onde, Fix); sem cabeçalho reconhecível, a
 * célula com DESCOBERTO ou ANTECIPADO é o estado e a primeira é a natureza.
 */
function ataquesDoContraditor(texto) {
  const linhas = String(texto ?? '').split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  const ataques = [];
  let col = null;
  for (const linha of linhas) {
    const c = celulasDoRedTeam(linha);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue;
    const n = c.map(semAcentoDoRedTeam);
    if (n.some((x) => /^natureza\b/.test(x)) && n.some((x) => /^estado\b/.test(x))) {
      col = {
        natureza: n.findIndex((x) => /^natureza\b/.test(x)),
        ataque: n.findIndex((x) => /^ataque\b/.test(x)),
        estado: n.findIndex((x) => /^estado\b/.test(x)),
        onde: n.findIndex((x) => /^onde\b|o que falta/.test(x)),
        fix: n.findIndex((x) => /^fix\b/.test(x)),
      };
      continue;
    }
    const iEstado = col ? col.estado : n.findIndex((x) => /\b(?:descoberto|antecipad|a responder)\b/.test(x));
    if (iEstado < 0 || c[iEstado] === undefined) continue;
    const onde = col && col.onde >= 0 ? c[col.onde] || '' : c[iEstado + 1] || '';
    const estado = estadoDoAtaque(c[iEstado], onde);
    if (!estado) continue;
    const pega = (k, padrao) => (col && col[k] >= 0 ? c[col[k]] || '' : padrao);
    ataques.push({
      n: ataques.length + 1,
      natureza: naturezaDoAtaque(pega('natureza', c[0])),
      estado,
      ataque: pega('ataque', c[1] || '').replace(/^["“]|["”]$/g, '').trim(),
      onde: onde.trim(),
      fix: pega('fix', '').trim(),
    });
  }
  return ataques;
}

/** Ataque que a peça não responde: descoberto, ou antecipado com resposta insuficiente. */
const ataqueSemResposta = (a) => a && (a.estado === 'descoberto' || a.estado === 'insuficiente');

const cortarDoRedTeam = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };

/**
 * A oferta da parada aprovação depois do red-team: cada ataque com o custo de não corrigir, a
 * recomendação (`corrigir` quando há ataque sem resposta) e as opções, nesta ordem.
 */
function ofertaDoRedTeam(ataques) {
  const lista = Array.isArray(ataques) ? ataques : [];
  const semResposta = lista.filter(ataqueSemResposta);
  const recomendacao = semResposta.length ? 'corrigir' : 'aprovar';
  return {
    recomendacao,
    opcoes: [...OPCOES_DEPOIS_DO_RED_TEAM[recomendacao]],
    sem_resposta: semResposta.length,
    ataques: lista.map((a) => ({
      n: a.n,
      natureza: a.natureza,
      estado: a.estado,
      ataque: cortarDoRedTeam(a.ataque, 400),
      ...(a.onde ? { o_que_falta: cortarDoRedTeam(a.onde, 400) } : {}),
      ...(ataqueSemResposta(a) ? { custo_de_nao_corrigir: CUSTO_DE_NAO_CORRIGIR[a.natureza] || CUSTO_DE_NAO_CORRIGIR.outra } : {}),
    })),
  };
}

/** O fix de origem humana que o ataque sem resposta vira, para a redação: gravidade alta. */
function fixDoAtaque(a) {
  const natureza = String(a.natureza || 'outra').toUpperCase();
  const estado = a.estado === 'insuficiente' ? 'antecipado com resposta insuficiente' : 'descoberto';
  const falta = a.fix || a.onde;
  return `alta: red-team, ataque de ${natureza} ${estado}: ${cortarDoRedTeam(a.ataque, 500)}${falta ? ` O que a peça precisa responder: ${cortarDoRedTeam(falta, 500)}` : ''}`;
}
// <<< red-team:end

export { CUSTO_DE_NAO_CORRIGIR, OPCOES_DEPOIS_DO_RED_TEAM, ataquesDoContraditor, ataqueSemResposta, ofertaDoRedTeam, fixDoAtaque, estadoDoAtaque, naturezaDoAtaque };
