// Dupla contagem na contingência e no cálculo, por código: o mesmo risco, a mesma pessoa ou a mesma
// ação somada em duas linhas, e o mesmo valor descontado duas vezes.
//
// Medido na avaliação cega dos cinco relatórios da due diligence (0.9.80 a 0.9.83): o relatório que
// tirou 82 somou a ação de vínculo (ATOrd 0010733) por inteiro, R$ 231.967,68 no provável, em cima do
// grupo dos seis ex-empregados que a contém ("autor com o perfil dos 6"), e a própria contingência
// avisava "se estiver, tirar uma pessoa da linha 3.1" e somava assim mesmo. No rigoroso (m2g), o
// red-team achou o bloqueio da Ipê descontado na dívida líquida e pedido de novo como retenção. As
// três heurísticas abaixo saem das tabelas reais: o número do processo (CNJ ou o sequencial de sete
// dígitos), o tamanho do grupo ("6 ex-empregados", "Seis ex-empregados") e o valor bloqueado.
// Começa como aviso de gravidade alta ao revisor e ao conferente, nunca como recusa: é heurística.
//
// Módulo PURO (só texto recebido). SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo
// `scripts/sync-blocos.mjs` para o `squad-state` (raiz e templates).

// >>> dupla-contagem:begin
const semAcentoDaConta = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const NUMEROS_POR_EXTENSO = Object.freeze({ dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20 });
const NUMERO_DO_GRUPO = `(\\d{1,3}|${Object.keys(NUMEROS_POR_EXTENSO).join('|')})`;
const lerNumeroDoGrupo = (t) => (/^\d+$/.test(t) ? Number(t) : NUMEROS_POR_EXTENSO[t] || null);

/** Quem forma grupo numa contingência trabalhista ou cível: as pessoas que a linha multiplica. */
const PESSOAS_DO_GRUPO = '(?:ex-?empregad\\w*|empregad\\w*|representantes?|recontratad\\w*|pessoas?|trabalhador\\w*|operador\\w*|ex-?vendedor\\w*|vendedor\\w*|reclamantes?|autor\\w*|prestador\\w*|terceirizad\\w*|analistas?|motoristas?|funcionari\\w*|colaborador\\w*|socios?|clientes?|consumidor\\w*|segurad\\w*)';

/** A linha diz que a ação está dentro de um grupo de N ("perfil dos 6", "um dos seis", "entre os 16"). */
const DENTRO_DO_GRUPO = new RegExp(`\\b(?:perfil|um|uma|integrante|membro|parte)\\s+d[oa]s\\s+${NUMERO_DO_GRUPO}\\b|(?<!nao\\s(?:esta|estao)\\s)\\bentre\\s+os\\s+${NUMERO_DO_GRUPO}\\b`);
/** A linha diz que já tirou a sobreposição: só a parte própria, contado uma vez, não soma. */
const SOBREPOSICAO_TRATADA = /sem o autor|exceto o autor|menos o autor|sem a acao|parcelas? propri|so (?:a|as) (?:diferenc|parcela)|apenas (?:a|as) (?:diferenc|parcela)|nao soma|sem somar|nao somad|contad[oa] (?:como )?um d|contad[oa] uma vez|uma vez so|ja (?:esta |estao )?(?:incluid|contad|dentro)|excluid[oa] d[oa] linha|fora d[oa] linha|tirad[oa] d[oa] linha|descontad[oa] d[oa] grupo|nao entra|\(nao somar/;

/** Os números de processo da linha: o sequencial de sete dígitos do CNJ ("0010733" e "0010733-64.2026.5.03.0080"). */
function processosDaLinha(texto) {
  const out = new Set();
  for (const m of String(texto ?? '').matchAll(/\b(\d{7})(?:-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})?\b/g)) out.add(m[1]);
  return [...out];
}

/** Os valores em reais da linha, como texto ("231.967,68"), sem os zerados. */
function valoresDaLinha(texto) {
  return [...String(texto ?? '').matchAll(/R\$\s*([\d.]+,\d{2})/g)].map((m) => m[1]).filter((v) => !/^0(?:\.0+)*,00$/.test(v) && v !== '0,00');
}

/** As linhas de tabela com valor, com a tabela a que pertencem e a chave do risco (a 1a coluna ou a coluna "R1"). */
function linhasDeValor(texto) {
  const linhas = String(texto ?? '').split('\n');
  const out = [];
  let tabela = 0;
  let dentro = false;
  linhas.forEach((l, i) => {
    if (!/^\s*\|.*\|\s*$/.test(l)) { dentro = false; return; }
    if (!dentro) { tabela += 1; dentro = true; }
    const celulas = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (celulas.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return;
    const valores = valoresDaLinha(l);
    if (!valores.length) return;
    // A chave do risco é o id de topo: "R5a" e "R5c" são o risco R5; "3.3a" e "3.1" são o risco 3.
    // Linha sem id de risco (tabela de recomendações, de processos) fica sem chave.
    const limpas = celulas.map((c) => c.replace(/\*\*/g, '').trim());
    const comR = limpas.find((c) => /^R\d{1,2}(?:[.\d]*[a-z]?)?(?=[\s:.,)-]|$)/i.test(c));
    const comNumero = /^\d{1,2}(?:\.\d+[a-z]?|[a-z])?(?=[\s:.)-]|$)/i.test(limpas[0] || '') && /\D/.test(limpas[0]) ? limpas[0] : null;
    const chave = comR ? comR.match(/^(R\d{1,2})/i)[1].toUpperCase() : comNumero ? comNumero.match(/^(\d{1,2})/)[1] : null;
    out.push({ linha: i + 1, tabela, chave, texto: l.trim(), valores, processos: processosDaLinha(l), n: semAcentoDaConta(l) });
  });
  return out;
}

const trechoDaConta = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > 180 ? `${s.slice(0, 179).trimEnd()}…` : s; };

/**
 * Os avisos de dupla contagem de um texto (contingência, cálculo ou a final): `{ tipo, gravidade:
 * 'alta', linhas, detalhe, fix }`. Três heurísticas: a mesma ação com valor em dois riscos da mesma
 * tabela; a ação que a própria linha põe dentro de um grupo de N somada por inteiro ao lado do
 * grupo, que não a desconta; e o valor bloqueado (ou depositado) pedido como retenção quando o mesmo
 * texto já o tira do caixa da dívida líquida.
 */
function duplaContagem(texto) {
  const avisos = [];
  const linhas = linhasDeValor(texto);
  const visto = new Set();
  // 1. A mesma ação em dois riscos da mesma tabela, as duas com valor.
  for (const proc of new Set(linhas.flatMap((l) => l.processos))) {
    const porTabela = new Map();
    for (const l of linhas.filter((x) => x.chave && x.processos.includes(proc) && !SOBREPOSICAO_TRATADA.test(x.n))) {
      if (!porTabela.has(l.tabela)) porTabela.set(l.tabela, []);
      porTabela.get(l.tabela).push(l);
    }
    for (const doMesmo of porTabela.values()) {
      const chaves = [...new Set(doMesmo.map((l) => l.chave))];
      if (chaves.length < 2) continue;
      const k = `acao:${proc}:${chaves.join('|')}`;
      if (visto.has(k)) continue;
      visto.add(k);
      avisos.push({
        tipo: 'mesma-acao-em-dois-riscos', gravidade: 'alta', processo: proc, linhas: doMesmo.map((l) => l.linha),
        detalhe: `a ação ${proc} tem valor em ${chaves.length} riscos da mesma tabela (${chaves.join(', ')}; linhas ${doMesmo.map((l) => l.linha).join(', ')}), sem dizer que uma linha não soma`,
        fix: `alta: possível dupla contagem: a ação ${proc} tem valor em dois riscos da mesma tabela (linhas ${doMesmo.map((l) => l.linha).join(', ')}); some-a uma vez só, ou diga na linha que a outra não soma, e confira os totais`,
      });
    }
  }
  // 2. A ação dentro de um grupo de N, somada por inteiro ao lado da linha do grupo.
  for (const l of linhas) {
    const m = l.n.match(DENTRO_DO_GRUPO);
    if (!m || !l.processos.length || SOBREPOSICAO_TRATADA.test(l.n)) continue;
    const n = lerNumeroDoGrupo(m[1] || m[2]);
    if (!n || n < 2) continue;
    const grupo = new RegExp(`(?:^|[^\\d.,])(?:${n}|${Object.keys(NUMEROS_POR_EXTENSO).filter((p) => NUMEROS_POR_EXTENSO[p] === n).join('|') || n})\\s+${PESSOAS_DO_GRUPO}`);
    const doGrupo = linhas.filter((g) => g !== l && grupo.test(g.n) && !l.processos.some((p) => g.processos.includes(p)) && !/\bautor\b|\breclamante\b/.test(g.n) && !SOBREPOSICAO_TRATADA.test(g.n));
    if (!doGrupo.length) continue;
    const k = `grupo:${l.processos[0]}:${n}`;
    if (visto.has(k)) continue;
    visto.add(k);
    avisos.push({
      tipo: 'acao-dentro-do-grupo', gravidade: 'alta', processo: l.processos[0], grupo: n, linhas: [l.linha, ...doGrupo.map((g) => g.linha)],
      detalhe: `a linha ${l.linha} soma a ação ${l.processos[0]} e diz que ela é do grupo de ${n} ("${trechoDaConta(m[0])}"), e a linha ${doGrupo[0].linha} soma o grupo de ${n} sem descontá-la: "${trechoDaConta(doGrupo[0].texto)}"`,
      fix: `alta: possível dupla contagem: a ação ${l.processos[0]} (linha ${l.linha}) é de uma das ${n} pessoas que a linha ${doGrupo[0].linha} já soma; conte o autor dentro do grupo (e a ação só pelas parcelas próprias), ou diga, com o documento, que ele está fora do grupo, e refaça os totais`,
    });
  }
  // 3. O valor bloqueado tirado do caixa da dívida líquida e pedido de novo como retenção. Frase a
  // frase: o valor é o do bloqueio quando aparece colado à palavra, e é o da retenção quando vem logo
  // depois dela (até 120 caracteres); a frase que diz que a retenção é o que passa do bloqueio, ou
  // que a retém "sem os R$ X bloqueados", não conta.
  const BLOQUEIO = /\b(?:bloque\w*|constri\w*|constrit\w*|penhor\w*|deposit\w* judicia\w*|deposito recursal)\b/g;
  const RETENCAO = /\b(?:retenc\w*|retid\w*|reter|conta vinculada|escrow)\b/g;
  const RETENCAO_ALEM = /alem do (?:valor )?(?:bloque|constri)|\b(?:sem|menos|descontad\w*|deduzid\w*|abatid\w*|exclu\w*)\s+(?:(?:o|os|a|as)\s+)?(?:r\$ ?[\d.,]+ )?(?:valor(?:es)? )?(?:bloque|constri)|(?:debito|saldo) que faltar|liquid\w* do bloque/;
  const frases = [];
  String(texto ?? '').split('\n').forEach((l, i) => { for (const f of l.split(/(?<=[.;])\s+(?=\S)/)) frases.push({ linha: i + 1, texto: f, n: semAcentoDaConta(f) }); });
  // O valor é do bloqueio quando a palavra está colada a ele, sem outro valor no meio: logo antes
  // ("o bloqueio de R$ X") ou logo depois ("R$ X bloqueados"). A palavra depois de um valor e antes
  // do seguinte qualifica o primeiro, não o segundo.
  const perto = (f, re) => {
    const out = [];
    let fimDoAnterior = 0;
    for (const m of f.texto.matchAll(/R\$\s*([\d.]+,\d{2})/g)) {
      const antes = f.texto.slice(Math.max(fimDoAnterior, m.index - 40), m.index);
      fimDoAnterior = m.index + m[0].length;
      const depois = f.texto.slice(m.index + m[0].length, m.index + m[0].length + 30).split('R$')[0];
      re.lastIndex = 0;
      const a = re.test(semAcentoDaConta(antes));
      re.lastIndex = 0;
      if (a || re.test(semAcentoDaConta(depois))) out.push(m[1]);
    }
    return out;
  };
  // A frase do caixa que já diz que o valor não volta na retenção resolve a sobreposição.
  const caixa = frases.find((f) => { BLOQUEIO.lastIndex = 0; return BLOQUEIO.test(f.n) && /divida liquida/.test(f.n); });
  const resolvido = frases.some((f) => /divida liquida/.test(f.n) && /sem (?:o )?contar de novo|nao (?:somar|contar) de novo|nao (?:volta|entra) (?:de novo )?na retenc/.test(f.n));
  if (caixa && !resolvido) {
    const bloqueados = new Set(frases.flatMap((f) => perto(f, BLOQUEIO)));
    for (const f of frases) {
      RETENCAO.lastIndex = 0;
      if (!RETENCAO.test(f.n) || RETENCAO_ALEM.test(f.n)) continue;
      const retidos = [];
      for (const m of f.texto.matchAll(/R\$\s*([\d.]+,\d{2})/g)) {
        const antes = semAcentoDaConta(f.texto.slice(Math.max(0, m.index - 120), m.index));
        RETENCAO.lastIndex = 0;
        if (RETENCAO.test(antes)) retidos.push(m[1]);
      }
      const v = retidos.find((x) => bloqueados.has(x));
      if (!v || visto.has(`bloqueio:${v}`)) continue;
      visto.add(`bloqueio:${v}`);
      avisos.push({
        tipo: 'bloqueio-descontado-duas-vezes', gravidade: 'alta', valor: v, linhas: [f.linha, caixa.linha],
        detalhe: `o valor bloqueado R$ ${v} sai do caixa da dívida líquida (linha ${caixa.linha}) e é pedido de novo como retenção (linha ${f.linha}): o mesmo valor descontado duas vezes do preço`,
        fix: `alta: possível dupla contagem: o bloqueio de R$ ${v} já sai do caixa na dívida líquida (linha ${caixa.linha}) e volta como retenção (linha ${f.linha}); a retenção é o débito além do bloqueio, ou o bloqueio fica no caixa, e o texto diz qual`,
      });
    }
  }
  return avisos;
}
// <<< dupla-contagem:end

export { duplaContagem, linhasDeValor, processosDaLinha, valoresDaLinha };
