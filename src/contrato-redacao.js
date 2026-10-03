// Contrato de redação: o que os gates vão cobrar da minuta, entregue ao redator ANTES de ele
// escrever, e o pré-voo de persuasão que ele roda antes de devolver.
//
// Etapa 1 do plano "motor mais leve" (revisoes/MOTOR-LEVE-2026-10.md, §2): nos seis runs medidos de
// 0.9.76 a 0.9.80, a primeira minuta custou 3 a 4 minutos e o trecho até a aprovação, 48 a 74. A
// persuasão reprovou a primeira passada em 6 de 6 runs, o Redação Gate em 5 de 6, e em 15 das 19
// reprovações de primeira passada ao menos um motivo de peso era conhecível antes de escrever: a
// síntese com palavra que o gate não aceita, o documento sem a âncora que o índice exige, o pedido
// fora das dez linhas que o triador lê, o `[PREENCHER]` citado na nota. O runner repetia essas
// regras em prosa, e o squad ensinava outras ("## O essencial", "## Conclusão").
//
// FONTE ÚNICA: este módulo não tem regra própria. Lê as do gate pelo nome (ANDAIME e os exemplos
// dele, VICIOS_DE_REDACAO, LIMIAR_DE_FRENTE, PISO_DA_JANELA, a referência de folha por origem, as
// seções do "Contrato de saída", as palavras de síntese), e o que precisa de forma para mostrar
// (os marcadores de pendência) fica aqui com teste que prende cada forma à regex do gate.
//
// Módulo PURO (texto e listas recebidas). SINCRONIA: o bloco entre os marcadores é copiado VERBATIM
// pelo `scripts/sync-blocos.mjs` para o hook `verifica-redacao.mjs` (raiz, .codex e templates), onde
// os blocos `redacao-gate`, `sintese-marcador` e `nota-ao-revisor` já moram no mesmo arquivo; aqui,
// os nomes vêm pelos imports abaixo.
import {
  ANDAIME_EXEMPLOS, VICIOS_DE_REDACAO, LIMITE_DE_VICIOS, LIMIAR_DE_FRENTE, PISO_DA_JANELA, JANELA_ANTES, JANELA_DEPOIS,
  PERFIS_DA_NOTA_AO_REVISOR, doCliente, padraoDeMencao, perfilDoContrato, extrairSecoesDeSaida,
} from './redacao-gate.js';
import { PALAVRAS_DE_SINTESE, ehMarcadorDeSintese } from './sintese-marcador.js';
import { NOTA_AO_REVISOR_INICIO, NOTA_AO_REVISOR_FIM, separarNotaAoRevisor } from './nota-ao-revisor.js';
import { REGRA_DO_DADO_PUBLICO } from './dado-publico.js';

// >>> contrato-redacao:begin
/**
 * As formas dos marcadores de pendência, na ordem das alternativas do PENDING_MARKER
 * (`src/pendencia.js`). `dado`: o que o DATA_MARKER aceita na final, listado no manifesto com a
 * diligência; os outros travam a final. `tests/motor-leve-contrato.test.js` prende a correspondência.
 */
const MARCADORES_DE_PENDENCIA = Object.freeze([
  { forma: '[NÃO VERIFICADO]', dado: false },
  { forma: '[DIVERGENTE]', dado: false },
  { forma: '[CONFERIR]', dado: false },
  { forma: '[A CONFERIR]', dado: false },
  { forma: '[CONFIRMAR: o dado]', dado: true },
  { forma: '[A CONFIRMAR: o dado]', dado: true },
  { forma: '[VERIFICAR]', dado: false },
  { forma: '[HIPÓTESE]', dado: false },
  { forma: '[CITAÇÃO PENDENTE]', dado: false },
  { forma: '[FONTE PENDENTE]', dado: false },
  { forma: '[PENDENTE DE VERIFICAÇÃO]', dado: false },
  { forma: '[PREENCHER: o campo]', dado: true },
  { forma: '[A PREENCHER: o campo]', dado: true },
  { forma: '[DILIGÊNCIA: o documento]', dado: true },
]);

/**
 * Títulos que squads já ensinaram para a síntese e que o gate recusa. Não são regra: a regra é
 * `ehMarcadorDeSintese`, e o contrato só lista os que ELA recusa (filtrados na hora de montar).
 */
const TITULOS_DE_SINTESE_QUE_SQUADS_ENSINAM = Object.freeze(['O essencial', 'Conclusão', 'Conclusões', 'Visão geral', 'Panorama', 'Em resumo executivo', 'Recomendação']);

const semAcentoDoContrato = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const cortar = (t, n = 220) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const numeroDoDoc = (i) => `Doc. ${String(i + 1).padStart(2, '0')}`;

/** A forma da âncora que o sinal `folhas` aceita para o documento: a mesma decisão do `referenciaPara`. */
function formaDaAncora(doc, processo) {
  if (processo === 'administrativo') return 'fls. N, Doc. N ou ID N';
  return doCliente(doc, processo) ? 'Doc. N ou Doc. N, p. N' : 'fls. N, f. N, e-fls. N, ID N ou Num. N - Pág. N';
}

/** Como o gate reconhece a menção ao documento: o tipo, ou as palavras do nome juntas na mesma frase. */
function comoOGateReconhece(doc) {
  const padrao = padraoDeMencao(doc);
  if (!padrao) return null;
  if (padrao.re) return `pela palavra do tipo (${doc.tipo})`;
  return `pelas palavras ${padrao.palavras.map((p) => `"${p}"`).join(' + ')} juntas na mesma frase`;
}

/** Seções de um markdown (`## Título` até o próximo título de nível igual ou maior), por regra no título. */
function secaoDoMarkdown(texto, regra) {
  const linhas = String(texto ?? '').split('\n');
  const out = [];
  for (let i = 0; i < linhas.length; i += 1) {
    const h = linhas[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!h || !regra.test(semAcentoDoContrato(h[2]))) continue;
    const nivel = h[1].length;
    const corpo = [];
    for (let j = i + 1; j < linhas.length; j += 1) {
      const outro = linhas[j].match(/^\s{0,3}(#{1,6})\s+/);
      if (outro && outro[1].length <= nivel) break;
      corpo.push(linhas[j]);
    }
    out.push(corpo.join('\n'));
  }
  return out.join('\n');
}

/** Itens de lista (ou parágrafos, se não houver lista) de um trecho, sem marca de lista. */
function itensDoTrecho(trecho, max = 12) {
  const linhas = String(trecho ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lista = linhas.filter((l) => /^(?:[-*+]|\d+[.)]|[a-z][.)])\s+/.test(l)).map((l) => l.replace(/^(?:[-*+]|\d+[.)]|[a-z][.)])\s+/, ''));
  return (lista.length ? lista : linhas.filter((l) => !/^\|/.test(l))).slice(0, max).map((l) => cortar(l.replace(/\*\*/g, '')));
}

/**
 * O que o foco aprovado (`diagnostico-foco.md`) decide e o redator não pode contrariar: a linha de
 * ataque (ou mensagem central), as teses ou pontos aprovados, o que a peça não deve fazer e os
 * critérios da meta decididos na parada. O foco é escrito pelo chefe com títulos que variam por
 * molde; a leitura é tolerante e o que não achar fica de fora, nunca inventado.
 */
function secoesDoFoco(foco) {
  const texto = String(foco ?? '');
  const linhaNegrito = texto.match(/^\s*\*\*(?:linha de ataque|mensagem central):\*\*\s*(.+)$/im);
  const secao = secaoDoMarkdown(texto, /^(?:\d+[.)]?\s*)?(?:linha de ataque|mensagem central)\b/).trim();
  const bruta = linhaNegrito ? linhaNegrito[1] : secao.split(/\n\s*\n/)[0] || '';
  const semLinha = /\bsem (?:linha de ataque|mensagem central)\b|seguir sem\b/i.test(semAcentoDoContrato(bruta));
  return {
    linhaDeAtaque: bruta && !semLinha ? cortar(bruta.replace(/^>\s*/, '').replace(/^["“]|["”]$/g, ''), 400) : null,
    semLinhaDeAtaque: Boolean(bruta) && semLinha,
    teses: itensDoTrecho(secaoDoMarkdown(texto, /\b(?:teses|pontos) aprovad/)),
    naoFazer: itensDoTrecho(secaoDoMarkdown(texto, /\bnao deve fazer\b/)),
    criteriosDecididos: itensDoTrecho(secaoDoMarkdown(texto, /\bcriterios da meta\b/)),
  };
}

/** A tabela "Tema que governa cada tese" da pesquisa: tese e autoridade de cada linha. */
function temasPorTese(pesquisa, max = 20) {
  const trecho = secaoDoMarkdown(pesquisa, /tema que governa/);
  const linhas = trecho.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-{3}/.test(l));
  const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => cortar(c.replace(/\*\*/g, ''), 160));
  return linhas.slice(1).map(celulas).filter((c) => c.length >= 2 && c[0]).slice(0, max).map((c) => ({ tese: c[0], autoridade: c[1] }));
}

/**
 * A regra legal supletiva que o material do run traz: o que a lei manda "na omissão do contrato",
 * "no silêncio", "salvo disposição em contrário", com o dispositivo como o material o escreve. Lida
 * linha a linha (a linha da tabela da base legal inteira), só de lei (nunca de julgado) e nunca a
 * marcada como não verificada. Medido no m6 da 0.9.81: a base legal da fase zero trazia o CPC, arts.
 * 605 e 606 (data da resolução e balanço de determinação, na omissão do contrato), e a cláusula de
 * haveres saiu com quatro [CONFIRMAR] em branco.
 */
const MARCA_SUPLETIVA = /\b(?:na omissao|nas omissoes|no silencio|omisso|salvo (?:disposicao|estipulacao|convencao|previsao|pacto|clausula)\b[^|.;]{0,30}?\bcontrari\w*|na falta de (?:clausula|estipulacao|previsao|disposicao)|a falta de (?:clausula|estipulacao|previsao|disposicao)|se o contrato (?:nao dispuser|for omisso|silenciar)|regencia supletiva|supletiv\w*)\b/;
const DISPOSITIVO_DE_LEI = /\b(?:cc|cpc|clt|cf|ctn|cdc|lc|lei|decreto|codigo)\b[^|]{0,40}?\barts?\b|\barts?\.?\s*\d/;
const JULGADO_OU_PENDENTE = /\b(?:resp|aresp|agint|agrg|hc|rhc|re|are|tema|sumula|informativo|inf\.)\b|nao verificad|nao encontrad|a conferir|divergente/;
function regrasSupletivasDoMaterial(material = []) {
  const out = [];
  for (const m of Array.isArray(material) ? material : []) {
    const texto = typeof m === 'string' ? m : String((m && m.texto) || '');
    const origem = (m && m.origem) || null;
    for (const linha of texto.split('\n')) {
      const l = semAcentoDoContrato(linha);
      if (!MARCA_SUPLETIVA.test(l) || !DISPOSITIVO_DE_LEI.test(l) || JULGADO_OU_PENDENTE.test(l)) continue;
      const regra = cortar(linha.replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ' · ').replace(/\*\*/g, ''), 320);
      if (!out.some((x) => x.regra === regra)) out.push({ regra, ...(origem ? { origem } : {}) });
    }
  }
  return out.slice(0, 20);
}

/**
 * Monta o contrato. Tudo é dado recebido: `contratos` são os "## Contrato de saída" das skills do
 * redator (`{texto, origem}`), `autos` o índice (`{arquivo, tipo, origem, num, titulo, folha_inicial}`),
 * `foco` e `pesquisa` os textos do run, `citacoesDaPesquisa` a listagem do hook de citações sobre a
 * pesquisa, `criterios` os `success_criteria` obrigatórios, `correcoes` o que o profissional mandou
 * corrigir fora do fluxo. Devolve o objeto que `contratoParaMarkdown` mostra.
 */
function contratoDeRedacao({ contratos = [], autos = [], processo = null, reader = 'juiz', foco = '', pesquisa = '', citacoesDaPesquisa = [], criterios = [], correcoes = [], caminhos = {}, material = null } = {}) {
  const leitor = String(reader || 'juiz').toLowerCase();
  const comFrente = leitor !== 'contraparte' && leitor !== 'publico';
  const doFoco = secoesDoFoco(foco);

  const secoes = [];
  for (const c of contratos) {
    const texto = typeof c === 'string' ? c : String((c && c.texto) || '');
    const daNota = PERFIS_DA_NOTA_AO_REVISOR.has(perfilDoContrato(texto));
    for (const s of extrairSecoesDeSaida(texto)) {
      if (secoes.some((x) => semAcentoDoContrato(x.rotulo) === semAcentoDoContrato(s.rotulo))) continue;
      secoes.push({ rotulo: s.rotulo, nucleos: s.nucleos, valores: s.valores, onde: daNota ? 'nota ao revisor' : 'peça ou nota', origem: (c && c.origem) || null });
    }
  }

  const documentos = (Array.isArray(autos) ? autos : []).filter((d) => d && d.arquivo).map((d, i) => ({
    doc: numeroDoDoc(i),
    arquivo: String(d.arquivo).split('/').pop(),
    tipo: d.tipo || null,
    origem: doCliente(d, processo) ? 'cliente' : 'autos',
    ...(d.num ? { num: d.num, folha_inicial: d.folha_inicial ?? null } : {}),
    ancora: formaDaAncora(d, processo),
    reconhecido: comoOGateReconhece(d),
  }));

  const jurisprudencia = (Array.isArray(citacoesDaPesquisa) ? citacoesDaPesquisa : []).filter((c) => c && c.classe && c.classe !== 'lei');
  const vistas = new Set();
  const autoridades = [];
  for (const c of jurisprudencia) {
    const chave = c.chave || `${c.classe}:${c.numero}:${c.orgao || ''}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    autoridades.push({ citacao: cortar(c.bruto, 120), linha: c.linha ?? null, contexto: c.contexto ? cortar(c.contexto, 200) : null });
  }
  const diplomas = [...new Set((Array.isArray(citacoesDaPesquisa) ? citacoesDaPesquisa : []).filter((c) => c && c.classe === 'lei' && !c.sem_diploma).map((c) => (c.diploma || (c.numeroLei ? `Lei ${c.numeroLei}` : '')).toUpperCase()).filter(Boolean))];

  return {
    versao: 1,
    reader: leitor,
    processo: processo || 'judicial',
    caminhos,
    sintese: comFrente ? {
      palavras_aceitas: [...PALAVRAS_DE_SINTESE],
      formas: ['## Síntese', '## I. DA SÍNTESE', '**Síntese.** na abertura da linha'],
      recusadas: TITULOS_DE_SINTESE_QUE_SQUADS_ENSINAM.filter((t) => !ehMarcadorDeSintese(`## ${t}`)),
      limiar_linhas: LIMIAR_DE_FRENTE,
      janela: `com ${LIMIAR_DE_FRENTE} ou mais linhas redigidas (citação em bloco fora da conta), o título da síntese aparece nas primeiras max(${PISO_DA_JANELA}, N/5) linhas`,
      dez_linhas: 'o triador lê dez linhas, do começo para o fim, sem endereçamento nem qualificação: o título da peça, os itens da síntese e a primeira frase das seções seguintes. A síntese inteira cabe nelas',
      carrega: [
        'cada pedido do capítulo de pedidos, inclusive citação, audiência, provas, custas e honorários, e os requerimentos de rito, numa linha final da síntese se preciso',
        'cada tese com o Tema, a súmula ou o repetitivo que a governa, pelo número, quando a pesquisa o trouxe',
        'a linha de ataque (ou mensagem central), literal, como abertura',
        'datas e valores iguais aos do corpo',
      ],
      linha_de_ataque: doFoco.linhaDeAtaque,
      sem_linha_de_ataque: doFoco.semLinhaDeAtaque,
      teses_aprovadas: doFoco.teses,
      temas_por_tese: temasPorTese(pesquisa),
    } : null,
    cobertura: {
      secoes: secoes.map(({ rotulo, onde, origem, valores }) => ({ rotulo: cortar(rotulo, 160), onde, ...(valores ? { valores } : {}), ...(origem ? { origem } : {}) })),
      nota_inicio: NOTA_AO_REVISOR_INICIO,
      nota_fim: NOTA_AO_REVISOR_FIM,
      forma: 'cada elemento como título, rótulo em negrito (**Status:** partial) ou rótulo simples (Status: ready); palavra solta no corpo não conta',
    },
    folhas: {
      janela: `a âncora junto da menção: até ${JANELA_ANTES} caracteres antes ou ${JANELA_DEPOIS} depois, no mesmo parágrafo; citação em bloco e trecho entre aspas não contam; linha de lista ou de tabela aberta pela âncora vale inteira`,
      documentos,
    },
    andaime: { proibidos: [...ANDAIME_EXEMPLOS], tema_a_conferir: '[TEMA A CONFERIR] nunca na minuta: a tese sem Tema confirmado segue pela lei, e a pergunta vai à nota ao revisor' },
    marcadores: {
      de_dado: MARCADORES_DE_PENDENCIA.filter((m) => m.dado).map((m) => m.forma),
      de_citacao: MARCADORES_DE_PENDENCIA.filter((m) => !m.dado).map((m) => m.forma),
      regra: 'marcador de dado só com o dado procurado e não achado no índice e no sumário do caso, e com a diligência que o resolve; marcador de citação trava a final',
    },
    vicios: {
      travessao: 'zero travessão (U+2014, ou U+2013 entre espaços) na prosa redigida; vírgula, dois-pontos, parênteses ou ponto',
      limite: LIMITE_DE_VICIOS,
      lista: VICIOS_DE_REDACAO.map((v) => ({ id: v.id, rotulo: v.rotulo, exemplos: v.exemplos || [] })),
    },
    citacao: {
      autoridades_da_pesquisa: autoridades,
      diplomas_da_pesquisa: diplomas,
      regras: [
        'só cita o que está na pesquisa; nada de memória',
        'toda remissão a artigo leva o diploma na mesma oração (CC, art. 1.277; art. 300 do CPC); "arts. 14 e 15" sozinho sai sem diploma e volta do gate',
        'súmula, Tema e precedente com o tribunal e o número como a pesquisa os escreve; tese e data iguais às da pesquisa',
        'na nota ao revisor, nenhum número de artigo ou de precedente que a peça não cite',
      ],
    },
    pendencias: {
      regra: 'dado que está no índice dos documentos ou no sumário do caso se escreve com a âncora, nunca vira [CONFIRMAR]; o manifesto final recusa pendência sem diligência',
      // A mesma regra que o laço de revisão e a Verificação da Meta aplicam (src/dado-publico.js).
      dado_publico: REGRA_DO_DADO_PUBLICO,
      // Lacuna que a lei supre: a regra supletiva do material, como sugestão, no lugar do campo em branco.
      lacuna_que_a_lei_supre: 'campo que a lei preenche na falta de cláusula (o que ela manda "na omissão do contrato", "no silêncio", "salvo disposição em contrário") não fica [PREENCHER] em branco: redija com a regra legal supletiva que o material do run traz (a pesquisa ou a base legal da fase zero), com o dispositivo como o material o escreve, e marque a escolha como sugestão: [CONFIRMAR: adotar a regra legal supletiva ou pactuar outra]. Só a regra que está no material: nada de dispositivo de memória; sem a regra no material, o marcador fica',
      regras_supletivas: regrasSupletivasDoMaterial(material || (pesquisa ? [{ texto: pesquisa, origem: caminhos.pesquisa || null }] : [])),
    },
    meta: {
      criterios_obrigatorios: (Array.isArray(criterios) ? criterios : []).map((c) => cortar(c, 240)),
      decididos_no_foco: doFoco.criteriosDecididos,
      nao_fazer: doFoco.naoFazer,
    },
    // A correção do profissional vai inteira (o corte em 400 caracteres partia a palavra no meio).
    correcoes: (Array.isArray(correcoes) ? correcoes : []).map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  };
}

/** O contrato em Markdown, para o redator ler antes de escrever. */
function contratoParaMarkdown(c) {
  const L = ['# Contrato de redação', '', 'Gerado por código a partir das regras dos gates deste run. Leia antes de escrever; antes de devolver, rode o pré-voo (fim deste arquivo). Os gates rodam depois, iguais: o pré-voo só tira o que se sabe de antemão.', ''];
  const lista = (itens) => itens.forEach((i) => L.push(`- ${i}`));
  if (c.sintese) {
    const s = c.sintese;
    L.push('## 1. Síntese (Redação Gate, sinal frente; gate de persuasão)');
    lista([
      `Título aceito: ${s.palavras_aceitas.join(', ')} (${s.formas.join('; ')}).${s.recusadas.length ? ` Recusados pelo gate: ${s.recusadas.join(', ')}.` : ''}`,
      `Posição: ${s.janela}.`,
      `Tamanho: ${s.dez_linhas}.`,
      `Carrega: ${s.carrega.join('; ')}.`,
      s.linha_de_ataque ? `Linha de ataque (do foco, literal): "${s.linha_de_ataque}"` : s.sem_linha_de_ataque ? 'Linha de ataque: o profissional seguiu sem ela; o gate confere pedidos e teses.' : 'Linha de ataque: não achada no foco; não a invente.',
    ]);
    if (s.teses_aprovadas.length) { L.push('', 'Teses ou pontos aprovados no foco:'); lista(s.teses_aprovadas); }
    if (s.temas_por_tese.length) { L.push('', 'Tema que governa cada tese (pesquisa):'); lista(s.temas_por_tese.map((t) => `${t.tese}: ${t.autoridade}`)); }
    L.push('');
  }
  L.push('## 2. Cobertura (Redação Gate)');
  if (c.cobertura.secoes.length) {
    lista(c.cobertura.secoes.map((s) => `${s.rotulo}${s.valores ? ` (valor: ${s.valores.join(', ')})` : ''}: na ${s.onde}${s.origem ? ` (${s.origem})` : ''}`));
    L.push(`- Forma: ${c.cobertura.forma}. A nota ao revisor vai no fim, entre \`${c.cobertura.nota_inicio}\` e \`${c.cobertura.nota_fim}\`, cada um sozinho na linha; nada de nota ao advogado fora dela.`);
  } else {
    L.push('- Nenhum "Contrato de saída" nas skills do redator: a cobertura não é medida. A nota ao revisor, se houver, vai entre as duas linhas de marcador.');
  }
  L.push('', '## 3. Documentos e âncoras (Redação Gate, sinal folhas)');
  if (c.folhas.documentos.length) {
    L.push(`- Regra: ${c.folhas.janela}.`);
    lista(c.folhas.documentos.map((d) => `${d.doc} (${d.arquivo}${d.num ? `, Num. ${d.num}, fls. ${d.folha_inicial}` : ''}): documento ${d.origem === 'cliente' ? 'do cliente' : 'dos autos'}; âncora ${d.ancora}${d.reconhecido ? `; o gate o reconhece ${d.reconhecido}` : ''}`));
  } else {
    L.push('- Sem índice dos documentos no squad: o sinal não é medido.');
  }
  L.push('', '## 4. Andaime e marcadores');
  lista([
    `Proibido em qualquer ponto do arquivo: ${c.andaime.proibidos.join('; ')}.`,
    c.andaime.tema_a_conferir,
    `Marcadores de dado (passam na final listados no manifesto, com a diligência): ${c.marcadores.de_dado.join(', ')}.`,
    `Marcadores que travam a final: ${c.marcadores.de_citacao.join(', ')}.`,
    `Regra: ${c.marcadores.regra}. ${c.pendencias.regra}.`,
    ...(c.pendencias.dado_publico ? [`${c.pendencias.dado_publico}.`] : []),
    ...(c.pendencias.lacuna_que_a_lei_supre ? [`Lacuna que a lei supre: ${c.pendencias.lacuna_que_a_lei_supre}.`] : []),
  ]);
  if (c.pendencias.regras_supletivas && c.pendencias.regras_supletivas.length) {
    L.push('', 'Regras legais supletivas do material deste run (use-as no lugar do campo em branco, como sugestão marcada):');
    lista(c.pendencias.regras_supletivas.map((r) => `${r.regra}${r.origem ? ` (${r.origem})` : ''}`));
  }
  L.push('', '## 5. Estilo (Redação Gate, sinal vícios)');
  lista([c.vicios.travessao, `Mais de ${c.vicios.limite} marcas fora de citação reprova: ${c.vicios.lista.map((v) => `${v.rotulo} (${v.exemplos.join(', ')})`).join('; ')}.`]);
  L.push('', '## 6. Citações (Citation Gate)');
  lista(c.citacao.regras);
  if (c.citacao.autoridades_da_pesquisa.length) { L.push('', 'Lista fechada de julgados, súmulas e Temas da pesquisa:'); lista(c.citacao.autoridades_da_pesquisa.map((a) => `${a.citacao}${a.contexto ? `: ${a.contexto}` : ''}`)); }
  if (c.citacao.diplomas_da_pesquisa.length) L.push(`- Diplomas abertos na pesquisa: ${c.citacao.diplomas_da_pesquisa.join(', ')}.`);
  if (c.meta.criterios_obrigatorios.length || c.meta.decididos_no_foco.length || c.meta.nao_fazer.length) {
    L.push('', '## 7. Meta e foco');
    if (c.meta.criterios_obrigatorios.length) { L.push('Critérios obrigatórios da rubrica:'); lista(c.meta.criterios_obrigatorios); }
    if (c.meta.decididos_no_foco.length) { L.push('Decididos na parada de diagnóstico:'); lista(c.meta.decididos_no_foco); }
    if (c.meta.nao_fazer.length) { L.push('A peça não pode:'); lista(c.meta.nao_fazer); }
  }
  if (c.correcoes.length) { L.push('', '## 8. Correções do profissional'); lista(c.correcoes); }
  L.push('', '## Pré-voo (antes de devolver a minuta)');
  const p = c.caminhos || {};
  lista([
    `\`node ${p.hook || '.claude/hooks/verifica-redacao.mjs'} --check <minuta> --json\`: o Redação Gate inteiro; \`ok: false\` é para corrigir agora.`,
    `\`node ${p.hook || '.claude/hooks/verifica-redacao.mjs'} --persuasao-previa <minuta> --json\`: as dez linhas do triador e o que ficou fora delas; item \`alta\` é para corrigir agora.`,
    `\`node scripts/squad-state.mjs citacoes-pendentes ${p.squad || 'squads/<nome>'} --peca <minuta> --previa\`: remissão sem diploma e citação fora da pesquisa.`,
  ]);
  return `${L.join('\n')}\n`;
}

// ── Pré-voo de persuasão ──────────────────────────────────────────────────────────────────────
// Um resumo extrativo determinístico, com as regras de mão do método do `verificador-persuasao`
// (§1): sem endereçamento nem qualificação, títulos que dizem algo, cada item de lista, a primeira
// frase de cada parágrafo, até dez. Não é o verificador (que segue rodando depois): é o que se sabe
// sem ler como juiz, os pedidos do capítulo de pedidos e os itens da própria síntese que não cabem
// nas dez linhas, a linha de ataque do foco e a data da síntese que o corpo não repete.

const PALAVRAS_VAZIAS_DO_PEDIDO = new Set(('a o as os e ou de da do das dos em no na nos nas um uma por pelo pela pelos pelas para com sem que se sua seu suas seus ao aos '
  + 'requer requerer requerimento seja sejam sendo ser condenacao condenar condenada condenado condenados determinacao determinar concessao conceder deferimento deferir '
  + 'procedencia julgamento julgar pedido pedidos reu reus re autor autora autores apelante apelado apelada parte partes mesmo mesma presente diante exposto '
  + 'termos item itens forma modo caso fim art arts cpc cc cf lei sobre qual quais desde ate bem como tambem ainda nao sim pagar pague pagamento solidariamente '
  + 'liminarmente preliminarmente subsidiariamente merito provimento querendo').split(' '));

function tronco(palavra) {
  const p = semAcentoDoContrato(palavra);
  if (/^\d/.test(p)) return p.replace(/[.,]/g, '');
  // "anulação" e "nulidade" pedem a mesma coisa.
  if (/^a?nul(?:a|i|o)/.test(p)) return 'nul';
  return p.length > 5 ? p.slice(0, 5) : p;
}
function troncosDe(texto) {
  return (semAcentoDoContrato(String(texto ?? '').replace(/\*\*/g, ' ')).match(/[a-z]{3,}|\d[\d.,]*\d|\d+/g) || [])
    .filter((w) => !PALAVRAS_VAZIAS_DO_PEDIDO.has(w))
    .map(tronco);
}

const ABREVIATURAS = /(?:\b(?:art|arts|fls?|doc|docs|p|pp|n|nº|min|rel|des|dr|dra|sr|sra|inc|al|cf|ex|v|vs|ltda|s\.a|e-fls|id|num|pág|pag|resp|ag|agrg|edcl|hc|rhc|re|are|ms)\.|\b[A-Z]\.|\d\.)$/i;
/** A primeira frase de um texto, sem cortar em abreviatura ("art.", "fls.", "Doc.", "n.") nem em número. */
function primeiraFrase(texto) {
  const t = String(texto ?? '').trim();
  const negrito = t.match(/^\*\*[^*]+\*\*\s*/);
  const base = negrito ? t.slice(negrito[0].length) : t;
  const re = /[.!?](?=\s+["“(]?[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9])/g;
  let m;
  while ((m = re.exec(base))) {
    if (!ABREVIATURAS.test(base.slice(Math.max(0, m.index - 8), m.index + 1))) return `${negrito ? negrito[0] : ''}${base.slice(0, m.index + 1)}`;
  }
  return t;
}

const ENDERECAMENTO = /^(?:excelentissim|exm[oa]|ao juizo|ao juiz|a(?:o)? (?:senhor|senhora|ilustrissim)|ilustrissim|egregi|colend|meritissim|ao ministerio|a vara|juizo de direito)/;
const QUALIFICACAO = /\b(?:qualificad[oa]s?|brasileir[oa]s?|solteir[oa]|casad[oa]|divorciad[oa]|viuv[oa]|inscrit[oa]s?|cpf|cnpj|residente|domiciliad[oa]|portador[a]?|pessoa juridica|com sede|nacionalidade|estado civil|profissao)\b/;
const TITULO_GENERICO = /^(?:(?:[ivxlc]+|\d+(?:\.\d+)*)[.)]?\s*[-:]?\s*)?(?:d[aeo]s?\s+)?(?:[a-z]+(?:\s+(?:d[aeo]s?|e)\s+[a-z]+)?)$/;
// Cabeçalho de recurso e fecho (local e data, assinatura): o triador não os lê como argumento.
const CABECALHO_OU_FECHO = /^(?:apelante|apelad[oa]|recorrente|recorrid[oa]|agravante|agravad[oa]|impetrante|impetrad[oa]|paciente|embargante|embargad[oa]|origem|autos|processo|comarca|vara|relator[a]?)\b|^[a-z ]+, \d{1,2}o? de [a-z]+ de \d{4}|\boab\b/;
const NOTA_FORA_DO_BLOCO = /\bnota ao (?:advogado|revisor|profissional)\b|\bnao integra a peca\b|\bretirar antes do protocolo\b/;

/** As unidades que o triador lê, em ordem, com a linha (1-based) de cada uma. */
function unidadesDeTriagem(peca) {
  const linhas = String(peca ?? '').split('\n');
  const out = [];
  let i = 0;
  if (/^\uFEFF?---\s*$/.test(linhas[0] || '')) { i = 1; while (i < linhas.length && !/^---\s*$/.test(linhas[i])) i += 1; i += 1; }
  // Documento em partes (a petição de juntada e as razões, no mesmo arquivo): o triador lê a parte
  // que traz a síntese, a partir do título de primeiro nível dela.
  const sintese = linhas.findIndex((l) => !/^\s*>/.test(l) && ehMarcadorDeSintese(l));
  if (sintese > 0) {
    for (let k = sintese - 1; k >= i; k -= 1) if (/^#\s+\S/.test(linhas[k])) { i = k; break; }
  }
  let pularAte = 0;
  while (i < linhas.length) {
    const bruta = linhas[i];
    const t = bruta.trim();
    if (!t || /^\s*>/.test(bruta) || /^\s*\|/.test(bruta) || /^<!--/.test(t)) { i += 1; continue; }
    const h = bruta.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (pularAte) {
      if (h && h[1].length <= pularAte) pularAte = 0;
      else { i += 1; continue; }
    }
    if (h) {
      const n = semAcentoDoContrato(h[2]).replace(/[*_`]/g, '').trim();
      if (NOTA_FORA_DO_BLOCO.test(n)) { pularAte = h[1].length; i += 1; continue; }
      if (!/\bminuta\b|\brascunho\b/.test(n) && !TITULO_GENERICO.test(n) && n.split(/\s+/).length >= 5) out.push({ texto: h[2].replace(/[*_]/g, ''), linha: i + 1, tipo: 'titulo' });
      i += 1;
      continue;
    }
    const item = bruta.match(/^\s*(?:[-*+]|\d+(?:\.\d+)*[.)]|[a-z][.)]|[ivxlc]+[.)])\s+(.+)$/i);
    if (item) { out.push({ texto: item[1], linha: i + 1, tipo: 'item' }); i += 1; continue; }
    const ini = i;
    const par = [];
    while (i < linhas.length && linhas[i].trim() && !/^\s{0,3}#{1,6}\s/.test(linhas[i]) && !/^\s*(?:[-*+]|\d+(?:\.\d+)*[.)]|[a-z][.)])\s+/.test(linhas[i]) && !/^\s*[>|]/.test(linhas[i])) { par.push(linhas[i].trim()); i += 1; }
    out.push({ texto: primeiraFrase(par.join(' ')), linha: ini + 1, tipo: 'paragrafo' });
  }
  return out.filter((u) => {
    const n = semAcentoDoContrato(u.texto).replace(/[*_`]/g, '').trim();
    // Linha de passagem ("pelo procedimento comum, em face de:") e marcador solto não dizem nada ao triador.
    if (/^\[/.test(n) || (u.tipo === 'paragrafo' && troncosDe(u.texto).length < 4) || CABECALHO_OU_FECHO.test(n)) return false;
    if (ENDERECAMENTO.test(n)) return false;
    if (QUALIFICACAO.test(n) && /^(?:\d+[.)]\s*)?[A-ZÁÉÍÓÚÂÊÔÃÕÇ*]{2,}/.test(u.texto.replace(/^\*\*/, '').trim())) return false;
    if (/^(?:em face de|contra)\b/.test(n) && n.length < 40) return false;
    return true;
  });
}

/**
 * O bloco de síntese: as unidades entre o título de síntese e o próximo título. Sem título aceito,
 * o bloco aberto por um título que squads ensinam e o gate recusa ("## Conclusão", "## O essencial")
 * faz as vezes dele, com `recusado`: o pré-voo mede o que ele carrega e avisa do título.
 */
function itensDaSintese(peca) {
  const linhas = String(peca ?? '').split('\n');
  let ini = linhas.findIndex((l) => !/^\s*>/.test(l) && ehMarcadorDeSintese(l));
  let recusado = null;
  if (ini < 0) {
    const ensinados = new Set(TITULOS_DE_SINTESE_QUE_SQUADS_ENSINAM.map(semAcentoDoContrato));
    ini = linhas.findIndex((l) => {
      const h = l.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
      return h && ensinados.has(semAcentoDoContrato(h[1]).replace(/[*_]/g, '').replace(/^(?:[ivxlc]+|\d+)[.)]\s*/, '').trim());
    });
    if (ini >= 0) recusado = linhas[ini].replace(/^\s*#+\s*/, '').trim();
  }
  if (ini < 0) return { linha: null, itens: [], recusado: null };
  const itens = [];
  for (let j = ini + 1; j < linhas.length; j += 1) {
    if (/^\s{0,3}#{1,6}\s/.test(linhas[j])) break;
    const item = linhas[j].match(/^\s*(?:[-*+]|\d+(?:\.\d+)*[.)]|[a-z][.)])\s+(.+)$/);
    if (item) itens.push({ texto: item[1], linha: j + 1 });
    else if (linhas[j].trim() && !itens.length && !/^\s*[>|]/.test(linhas[j])) itens.push({ texto: linhas[j].trim(), linha: j + 1 });
  }
  return { linha: ini + 1, itens, recusado };
}

const TITULO_DE_PEDIDOS = /\b(?:pedidos?|requerimentos?|dos requerimentos|do pedido)\b/;
/**
 * Os pedidos do capítulo de pedidos: cada item de primeiro nível; o item que só rotula (`**No
 * mérito:**`) e tem subitens vira os subitens. Os núcleos são os trechos em negrito do item (a peça
 * marca assim o que pede) ou, sem negrito, as quatro primeiras palavras que dizem o quê.
 */
function pedidosDaPeca(peca) {
  const linhas = String(peca ?? '').split('\n');
  let ini = -1;
  let nivel = 7;
  for (let i = 0; i < linhas.length; i += 1) {
    const h = linhas[i].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/) || linhas[i].match(/^\s*\*\*([^*]{3,60})\*\*\s*$/);
    if (!h) continue;
    const titulo = semAcentoDoContrato(h[2] ?? h[1]);
    if (TITULO_DE_PEDIDOS.test(titulo) && !/sintese|resumo/.test(titulo)) { ini = i; nivel = h[2] ? h[1].length : 7; }
  }
  if (ini < 0) return [];
  const itens = [];
  for (let j = ini + 1; j < linhas.length; j += 1) {
    const h = linhas[j].match(/^\s{0,3}(#{1,6})\s/);
    if (h && h[1].length <= nivel) break;
    if (/^\s*\*\*valor da causa/i.test(linhas[j]) || /^\s*(?:termos em que|nestes termos|pede deferimento)/i.test(linhas[j])) break;
    const m = linhas[j].match(/^(\s*)(?:[-*+]|\d+(?:\.\d+)*[.)]|[a-z][.)]|[ivxlc]+[.)])\s+(.+)$/i);
    if (m) itens.push({ recuo: m[1].replace(/\t/g, '    ').length, texto: m[2], linha: j + 1 });
  }
  if (!itens.length) return [];
  const raiz = Math.min(...itens.map((x) => x.recuo));
  const out = [];
  for (let k = 0; k < itens.length; k += 1) {
    const it = itens[k];
    if (it.recuo !== raiz) continue;
    const filhos = [];
    for (let q = k + 1; q < itens.length && itens[q].recuo > raiz; q += 1) filhos.push(itens[q]);
    const semRotulo = it.texto.replace(/\*\*[^*]+\*\*/g, ' ');
    if (filhos.length && troncosDe(semRotulo).length < 4) out.push(...filhos);
    else out.push(it);
  }
  return out.map((p) => {
    const negritos = [...p.texto.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => troncosDe(m[1])).filter((g) => g.length);
    return { texto: p.texto, linha: p.linha, grupos: negritos.length ? negritos : [troncosDe(p.texto).slice(0, 4)] };
  }).filter((p) => p.grupos.some((g) => g.length));
}

/** O grupo de troncos está nas dez linhas? Dois deles (ou todos, se forem menos). */
function grupoPresente(grupo, alvo) {
  return grupo.filter((t) => alvo.has(t)).length >= Math.min(2, grupo.length);
}

const AUTORIDADE_NUMERADA = /\b(s[uú]mula(?:\s+vinculante)?|tema|sv|oj)\s*(?:n[º°.]\s*)?(\d[\d.]*)/gi;
const DATA_COMPLETA = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

/**
 * O pré-voo. `texto` é a minuta inteira (a nota ao revisor sai antes); `linhaDeAtaque`, a do foco.
 * Devolve `{ aplica, dez_linhas, itens, ok }`: cada item `{tipo, item, linha, sobrevive, gravidade,
 * fix}`; `ok` é nenhum item `alta`. Contrato e conteúdo de autoridade não têm síntese de peça.
 */
function persuasaoPrevia(texto, { linhaDeAtaque = null, reader = 'juiz' } = {}) {
  const leitor = String(reader || 'juiz').toLowerCase();
  if (leitor === 'contraparte' || leitor === 'publico') return { aplica: false, motivo: `reader ${leitor}: sem síntese de peça`, dez_linhas: [], itens: [], ok: true };
  const separado = separarNotaAoRevisor(texto);
  const peca = separado.erro ? String(texto ?? '') : separado.peca;
  const unidades = unidadesDeTriagem(peca);
  const dez = unidades.slice(0, 10);
  const alvo = new Set(troncosDe(dez.map((u) => u.texto).join(' ')));
  const alvoTexto = semAcentoDoContrato(dez.map((u) => u.texto).join(' '));
  const ultimaLida = dez.length ? dez[dez.length - 1].linha : 0;
  const itens = [];
  const add = (i) => itens.push(i);

  for (const p of pedidosDaPeca(peca)) {
    const perdidos = p.grupos.filter((g) => !grupoPresente(g, alvo));
    const sobrevive = !perdidos.length;
    const rotulo = cortar(p.texto.replace(/\*\*/g, ''), 110);
    add({ tipo: 'pedido', item: rotulo, linha: p.linha, sobrevive, gravidade: sobrevive ? null : 'alta', ...(sobrevive ? {} : { fix: `alta: leve à síntese o pedido da linha ${p.linha} ("${rotulo}"); numa linha final da síntese, se for requerimento de rito` }) });
  }

  const sintese = itensDaSintese(peca);
  if (sintese.recusado) add({ tipo: 'titulo-da-sintese', item: sintese.recusado, linha: sintese.linha, sobrevive: false, gravidade: 'alta', fix: `alta: o título "${sintese.recusado}" (linha ${sintese.linha}) não abre síntese para o gate; use ${PALAVRAS_DE_SINTESE.slice(0, 3).join(', ')}` });
  for (const [k, it] of sintese.itens.entries()) {
    if (it.linha <= ultimaLida) continue;
    add({ tipo: 'item-da-sintese', item: cortar(it.texto.replace(/\*\*/g, ''), 110), linha: it.linha, sobrevive: false, gravidade: 'alta', fix: `alta: o item ${k + 1} da síntese (linha ${it.linha}) fica fora das dez linhas que o triador lê; funda itens ou encurte a síntese` });
  }

  if (linhaDeAtaque) {
    // A linha de ataque abre a síntese: tem de estar nas três primeiras unidades, não só nas dez.
    const troncos = [...new Set(troncosDe(linhaDeAtaque))];
    const onde = dez.findIndex((u) => { const t = new Set(troncosDe(u.texto)); return troncos.length > 0 && troncos.filter((x) => t.has(x)).length / troncos.length >= 0.6; });
    const sobrevive = onde >= 0 && onde < 3;
    add({ tipo: 'linha-de-ataque', item: cortar(linhaDeAtaque, 110), linha: onde >= 0 ? dez[onde].linha : null, sobrevive, gravidade: sobrevive ? null : 'alta', ...(sobrevive ? {} : { fix: onde >= 0 ? `alta: abra a síntese com a linha de ataque, hoje na linha ${dez[onde].linha}, depois de ${onde} unidade(s)` : 'alta: abra a síntese com a linha de ataque do foco, literal' }) });
  }

  const corpo = sintese.linha ? peca.split('\n').filter((_, i) => i + 1 < sintese.linha || i + 1 > (sintese.itens.length ? sintese.itens[sintese.itens.length - 1].linha : sintese.linha)).join('\n') : peca;
  // Data da síntese que o corpo não repete, com outra data do mesmo mês a até dois dias no corpo:
  // é a divergência de digitação (31/10 na síntese, 30/10 no corpo), e o resumo leva a errada.
  const datasDoCorpo = [...corpo.matchAll(DATA_COMPLETA)].map((d) => Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1])));
  const vistasNaSintese = new Set();
  for (const it of sintese.itens) {
    for (const d of it.texto.matchAll(DATA_COMPLETA)) {
      const t = Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1]));
      if (datasDoCorpo.includes(t) || vistasNaSintese.has(t)) continue;
      vistasNaSintese.add(t);
      const vizinha = datasDoCorpo.find((x) => Math.abs(x - t) <= 2 * 86400000);
      if (vizinha === undefined) continue;
      const v = new Date(vizinha);
      const outra = `${String(v.getUTCDate()).padStart(2, '0')}/${String(v.getUTCMonth() + 1).padStart(2, '0')}/${v.getUTCFullYear()}`;
      add({ tipo: 'data-da-sintese', item: d[0], linha: it.linha, sobrevive: false, gravidade: 'alta', fix: `alta: a síntese (linha ${it.linha}) diz ${d[0]} e o corpo, ${outra}; confira e iguale` });
    }
  }

  const vistas = new Set();
  for (const m of peca.matchAll(AUTORIDADE_NUMERADA)) {
    const tipo = semAcentoDoContrato(m[1]).replace(/\s+/g, ' ');
    const numero = m[2].replace(/\./g, '').replace(/\D+$/, '');
    const chave = `${tipo} ${numero}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const sobrevive = new RegExp(`\\b${tipo.replace(/ /g, '\\s+')}\\s*(?:n[º°.]\\s*)?${numero.replace(/(\d)(?=(\d{3})+$)/g, '$1\\.?')}\\b`).test(alvoTexto);
    add({ tipo: 'autoridade', item: `${m[1]} ${m[2]}`, linha: null, sobrevive, gravidade: sobrevive ? null : 'media', ...(sobrevive ? {} : { fix: `media: nomeie ${m[1]} ${m[2]} na síntese, ao lado da tese que governa` }) });
  }

  if (/\[TEMA A CONFERIR[^\]]*\]/i.test(peca)) add({ tipo: 'tema-a-conferir', item: '[TEMA A CONFERIR]', linha: null, sobrevive: false, gravidade: 'alta', fix: 'alta: tire [TEMA A CONFERIR] da peça; a tese segue pela lei, e a pergunta vai à nota ao revisor' });

  return {
    aplica: true,
    dez_linhas: dez.map((u) => ({ linha: u.linha, texto: cortar(u.texto.replace(/\*\*/g, ''), 200) })),
    itens,
    perdidos: itens.filter((i) => !i.sobrevive).length,
    ok: !itens.some((i) => i.gravidade === 'alta'),
    limite: 'Este pré-voo aproxima o triador; não o reproduz. O verificador de persuasão roda depois.',
  };
}
// <<< contrato-redacao:end

export { regrasSupletivasDoMaterial,
  MARCADORES_DE_PENDENCIA, TITULOS_DE_SINTESE_QUE_SQUADS_ENSINAM, secoesDoFoco, temasPorTese, contratoDeRedacao, contratoParaMarkdown,
  unidadesDeTriagem, itensDaSintese, pedidosDaPeca, persuasaoPrevia, primeiraFrase,
};
