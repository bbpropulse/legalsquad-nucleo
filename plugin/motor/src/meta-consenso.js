// Consenso da Verificação da Meta: combina as N avaliações do `avaliador-squad`
// critério a critério, em código, sem parsear prosa.
//
// Medido em 24/09/2026 (8 squads-modelo, ritmo equilibrado): 58 dos 200 pontos
// perdidos vieram do avaliador medindo fora da rubrica, com um votante só,
// porque o ritmo rebaixava `meta_verifiers: 3` para 1; a mesma evidência foi
// punida num run e aceita em outro. Daqui em diante:
//
// - o número de avaliadores é o que o squad declara (`meta_verifiers` no
//   squad.yaml ou no step), e o ritmo NÃO o rebaixa: o comando recusa consenso
//   com menos avaliações do que o squad exige;
// - cada avaliação é um JSON (`avaliacao_meta`) com o veredito por critério e as
//   exigências do critério uma a uma, cada qual com evidência (trecho e local)
//   ou falta, e a classe da perda;
// - ATENDE sem evidência em alguma exigência é rebaixado a PARCIAL pelo código
//   (o ceticismo do avaliador, conferido aqui);
// - com N avaliações, o critério fica no nível mais alto que MAIS DA METADE dos
//   votos alcança: ATENDE só com maioria de ATENDE; maioria de PARCIAL ou NAO
//   rebaixa. É o consenso conservador do runner, sem margem para leitura;
// - nota na escala de sempre (ATENDE 2, PARCIAL 1, NAO 0; nota = soma / 2N x
//   100) e veredito pela REGRA de entrega do squad, o campo estruturado
//   `meta_limiar` do squad.yaml (quantos NAO e PARCIAL cabem, quais critérios
//   têm de ser ATENDE, onde PARCIAL é admitido, nota mínima). O "Limiar" do
//   `quality-criteria.md` é texto para o avaliador e para o curador; o código não
//   extrai número de prosa. Medido em 24/09/2026: nos 8 squads da medição o
//   limiar é regra estrutural ("ATENDE nos critérios 1, 4 e 6"), e ler número
//   do texto dava null em 7 e, no mandado de segurança, um 85 de outra frase.
//   Sem `meta_limiar`, o padrão do motor: nenhum NAO e nota 85, avisando.
//
// Dado que não está na pasta do caso não pune (C5 da medição, 24/09/2026: 28 dos
// 200 pontos eram qualificação mascarada, holerite com a parte contrária, decisão do
// cliente, sistema que os autos não nomeiam). A exigência sai `atendida` com
// `classe: dado-ausente` quando a peça marca o dado como ausente e a diligência
// está em `pendencias_do_profissional[]` do manifesto da final; o código confere
// as três coisas (marcador de dado, entrada no manifesto, exigência que não é de
// conteúdo jurídico) e, faltando uma, a exigência volta a `falta` e o ATENDE cai.
// Não é válvula de escape: tese, fundamento, citação, súmula, precedente e Tema
// nunca são dado ausente.
//
// Reavaliação das 8 finais com o avaliador novo (24/09/2026): a precisão subiu
// (87,5% dos critérios unânimes), mas entrou leniência que o código pode fechar em
// parte:
//
// - `posterior` só vale para artefato de step DEPOIS da meta, citado na evidência:
//   exigência `posterior` cuja evidência ou local aponta a própria peça (o arquivo da
//   final, ou um trecho literal dela) ou que não cita um step posterior do pipeline
//   volta a `falta` (`recusada_por_codigo`) e o ATENDE cai. Medido: "data e
//   assinatura" da reclamação saiu `posterior` apontando o fecho da peça;
// - ATENDE exige que toda exigência listada esteja `atendida` com trecho e local (ou
//   `dado-ausente` aceito, ou `posterior` aceito) e pelo menos uma `atendida`;
// - a falta que o avaliador escreve como sugestão, com as exigências todas `atendida`
//   (medido: apelação C3 "nulidade sem dizer absoluta ou relativa", mandado de
//   segurança C1 "procuradoria sem o órgão nomeado", HC C3 "período fora do quadro de
//   autoria"), o código confere contra a rubrica: o texto do critério e as cláusulas
//   PARCIAL e NÃO do quality-criteria.md daquele critério viram exigências (um trecho
//   por vírgula, "e", "ou", parênteses; na cláusula, o Y de "X sem Y"), e a sugestão
//   que casa com uma delas pela regra da deduplicação de faltas (`metaSemelhanca`)
//   vira `falta` com `recusada_por_codigo: "sugestao-repete-exigencia"` e o ATENDE
//   cai. A que cita o critério ("Critério 3: ...") só se compara com ele; a da lista
//   geral fica com o maior casamento. Em `sugestoes_fora_da_rubrica`, só a cláusula
//   PARCIAL ou NÃO desmente o avaliador (o texto do critério casava com "data por
//   extenso no preâmbulo", que a contestação cumpre na ficha de prazos). O que o
//   código não pega, e o texto do agente continua evitando: a falta de uma palavra só
//   ("comando sem prazo": o Y é "prazo") e a mesma falta dita com outras palavras
//   ("com a autoria" contra "sem autoria atribuída"). Nos votos reais: apelação a1 e
//   a3, mandado de segurança a1 a a3 e HC a2 caem; HC a1 e a3 não;
// - `limiar`, `limiar_fonte`, `nota` e `verdict` do avaliador são ignorados (e
//   listados em `campos_ignorados`): votos do mesmo squad declararam limiares
//   diferentes para a mesma regra; a nota e o veredito são os do código;
// - no consenso, as faltas com redação diferente para o mesmo defeito se juntam por
//   semelhança simples de texto (`metaMesmaExigencia`), e a classe da perda do
//   critério sai por maioria dos votos que perderam; no empate, `peca`, de propósito:
//   a peça volta à redação, que é o lado seguro (antes, o empate caía na ordem da lista).
//
// Segunda reavaliação (novo2, 24/09/2026, avaliador ajustado): 44 de 48 critérios
// unânimes, mas o destino das faltas ainda saía errado em quatro pontos, fechados aqui:
//
// - `dado-ausente` só vale para dado do cliente ou do caso fora da pasta. A falta com
//   essa classe cuja exigência é dado público (índice oficial, órgão de representação
//   de ente público, lei, tabela) ou elemento que a peça produz (data, assinatura,
//   pedido, cálculo) é reclassificada como `peca` (`reclassificada_por_codigo`), e a
//   classe do voto segue (`classe_reclassificada_por_codigo`). Lista e limite em
//   `META_NAO_E_DADO_DO_CLIENTE`. Medido: mandado de segurança C1, reclamação C1 (data)
//   e despejo C3 (IPCA), 3 de 3 cada, iam ao profissional em vez do redator;
// - o consenso não junta faltas de classes diferentes nem de núcleos diferentes (e-mail
//   e CPF), e junta com metade dos termos as que dividem um núcleo (`metaMesmaFalta`,
//   `metaFaltasIncompativeis`, `META_NUCLEOS`). Medido: despejo C1 juntava e-mail
//   (`peca`) e CPF (`dado-ausente`); negativação C1, alimentos C1, despejo C3, reclamação
//   C5 e contestação C3 ficavam com duplicatas;
// - `posterior` que cita só parada humana (checkpoint) ou que é do que a conferência
//   produz (relatório de entrega, nota de conferência, manifesto) sem step de agente que
//   grave o arquivo volta a falta; o pipeline dá o tipo e as saídas de cada step
//   (`stepsPosterioresDoPipeline(..., { detalhe: true })`). Medido: alimentos C5 e
//   reclamação C5 citavam o step-12-aprovacao para o relatório de entrega;
// - a checagem de sugestão cobre também o critério já abaixo de ATENDE (só por regra
//   própria, sem mudar o veredito), com a regra `citacao-sem-pedido`, e ignora a nota de
//   alcance ("não está na lista fechada e não foi aberto"). Medido: a Súmula 389, II sem
//   o pedido (reclamação a2 e a3) não virava falta porque o C5 já estava em NAO e porque
//   as palavras não batiam com a cláusula; o HC C2 caía em dois votos por nota de alcance;
// - quem não leu não contradiz quem leu (decisão do dono): a falta `fora-do-alcance` de um
//   voto cuja exigência outro avaliador deu `atendida` com trecho e local conta como
//   atendida (`superada_por_evidencia`), e o voto sem outra falta volta a ATENDE; falta
//   `peca` ou `dado-ausente` decide por maioria (`metaSuperarPorEvidencia`). Medido:
//   alimentos C5, a1 conferiu, a2 e a3 não leram o relatório.
//
// Primeiro par da medição do motor 0.9.49 (24/09/2026): formato não é nota. Na negativação, os
// três avaliadores deram ATENDE nos seis critérios e a nota saiu 50 (REPROVADO): ninguém
// preencheu `local` nem `pendencia`, e o código rebaixava cada ATENDE a PARCIAL em silêncio,
// com o local escrito na evidência ("linha 11: ...") e o marcador ([CONFIRMAR]) também, e as
// entradas em `pendencias_do_profissional[]`. Na contestação, a rodada 1 saiu 50 em parte pelo
// mesmo motivo e a peça voltou à redação. Daqui em diante:
//
// - o código deriva o que a evidência mostra: `local` pela linha, seção, capítulo, documento,
//   folha ou arquivo citado nela (`metaLocalDaEvidencia`); `pendencia` pelo marcador literal
//   ou pelo tipo do marcador no mesmo lugar (linha ou seção) de uma entrada do manifesto
//   (`metaPendenciaDaEvidencia`), marcando `local_derivado_por_codigo` e
//   `pendencia_derivada_por_codigo`;
// - o que não se deriva, num voto ATENDE que não cai pela peça, é `fora_do_formato` (o avaliador,
//   o critério, a exigência e os campos); o comando devolve `refazer-avaliacao` e não combina
//   nada; o runner redespacha aquele avaliador uma vez com o formato;
// - as travas de antes ficam: posterior, dado ausente só de dado do cliente, marcador fora do
//   manifesto, sugestão que repete exigência. Essas são da peça e continuam derrubando o voto.
//
// A lógica vive no bloco abaixo, copiado VERBATIM para `scripts/squad-state.mjs`
// e `templates/scripts/squad-state.mjs` (guardado por `sync-blocos`); o comando
// `squad-state meta-consenso` faz só a leitura dos arquivos.

// >>> meta-consenso:begin
/** A escala da rubrica: não muda (repontuar a série antiga seria obrigatório). */
const META_PONTOS = { ATENDE: 2, PARCIAL: 1, NAO: 0 };
const META_NIVEL_POR_PONTOS = ['NAO', 'PARCIAL', 'ATENDE'];
/** De onde vem a perda: da peça, de dado que não está na pasta do caso, ou de algo fora do alcance da meta. */
const META_CLASSES = ['peca', 'dado-ausente', 'fora-do-alcance'];
/** Estado de cada exigência do critério; `posterior` é artefato de step depois da meta, e não pune. */
const META_STATUS = ['atendida', 'falta', 'posterior'];
/** A régua do dono quando o squad não declara `meta_limiar`. */
const META_LIMIAR_PADRAO = 85;
/** As partes da regra de entrega (`meta_limiar` do squad.yaml). */
const META_LIMIAR_CHAVES = ['nao_max', 'parcial_max', 'atende_obrigatorios', 'parcial_permitidos', 'nota_min'];
/** O padrão do motor, como regra: nenhum NAO e nota mínima 85. */
const META_REGRA_PADRAO = { nao_max: 0, parcial_max: null, atende_obrigatorios: [], parcial_permitidos: null, nota_min: META_LIMIAR_PADRAO };
/**
 * Marcador de DADO (o mesmo `DATA_MARKER` de `src/pendencia.js`): o fato que depende
 * do profissional ou do cliente. Só ele sustenta uma exigência `dado-ausente`;
 * marcador de citação nunca.
 */
const META_MARCADOR_DE_DADO = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:\u2013\u2014-]|\])/;
/**
 * Exigência de conteúdo jurídico (lida sem acento e em minúsculas): nunca é dado
 * ausente. A tese, o fundamento e a citação de lei ou precedente são trabalho da
 * peça, não diligência. "Citação do réu" (o ato processual, que depende do endereço)
 * não entra: é o dado que a pasta pode não ter.
 */
const META_EXIGENCIA_JURIDICA = /\b(?:teses?|fundament\w*|citacoes|citacao\b(?! (?:do|da|dos|das|ao|a|aos|as) (?:reu|re|reus|res|parte|partes|requerid\w*|executad\w*|demandad\w*|impetrad\w*|autoridade|devedor\w*)| por edital| postal| pessoal| por oficial)|sumulas?|precedentes?|jurisprudenc\w*|temas?|repetitivos?)\b/;

/**
 * O que NÃO é dado do cliente nem do caso, lido na redação da exigência (sem acento,
 * em minúsculas): dado público, que a peça obtém sozinha, e elemento que a própria
 * peça produz. Nenhum dos dois é `dado-ausente`, nem em `falta`: a exigência em falta
 * com essa classe é reclassificada como `peca` (volta à redação, não vira pendência do
 * profissional), e a `atendida` com essa classe é recusada. `dado-ausente` fica só para
 * o que só o cliente ou o caso têm e a pasta não traz: qualificação da parte (CPF, RG,
 * e-mail, endereço), documento que só o cliente tem, fato da vida dele, decisão dele.
 *
 * Medido na reavaliação de 24/09/2026 (novo2): mandado de segurança C1 (nome do órgão de
 * representação do Município, 3 de 3), reclamação C1 (data da peça em branco, 3 de 3) e
 * despejo C3 (correção pela série do IPCA, 3 de 3) saíram `dado-ausente` e iriam ao
 * profissional, não ao redator.
 *
 * Limite: o código lê a exigência, não o mundo. A exigência escrita como o documento que
 * falta ("holerites de 03/2024 a 01/2025", "extrato do FGTS") continua `dado-ausente`;
 * escrita como a conta que depende dele ("memória das horas extras"), vira `peca`: o
 * cálculo é da peça, que marca a parte que depende do documento. "Conta" sozinha não
 * entra (conta bancária é dado do cliente); "valor" sozinho também não.
 */
const META_NAO_E_DADO_DO_CLIENTE = [
  { tipo: 'indice-oficial', padrao: /\b(?:ipca(?:-e)?|inpc|igp-?m|igp-?di|ipc-?fipe|selic|taxa referencial|indices?|correcao|correcoes|atualizacao monetaria|juros)\b/, motivo: 'índice oficial, correção e juros são dado público: a peça obtém a série e aplica' },
  { tipo: 'orgao-publico', padrao: /\b(?:orgaos? de representacao|representacao judicial|procuradori\w*|advocacia[ -]geral|defensoria publica|agu|pgfn|pge|pgm)\b/, motivo: 'o órgão de representação de ente público é dado público: a peça o nomeia' },
  { tipo: 'norma-ou-tabela', padrao: /\b(?:lei|leis|decreto|decretos|resolucao|portaria|instrucao normativa|tabelas?|salario minimo|teto)\b/, motivo: 'lei, norma e tabela oficial são dado público' },
  { tipo: 'data-ou-assinatura', padrao: /(?:^data$|\bdata da (?:peca|peticao|inicial|contestacao|impetracao|assinatura|distribuicao|protocolo)\b|\blocal e data\b|\bdata e (?:local|assinatura)\b|\bassinaturas?\b|\bfecho\b)/, motivo: 'data, assinatura e fecho são elementos que a própria peça produz' },
  { tipo: 'pedido', padrao: /\bpedidos?\b/, motivo: 'o pedido é elemento que a própria peça produz' },
  { tipo: 'calculo', padrao: /\b(?:calculos?|memoria|memorias|liquidacao|valor da causa)\b/, motivo: 'o cálculo é elemento que a própria peça produz' },
];

/**
 * Por que a exigência NÃO é dado do cliente nem do caso (dado público ou elemento da
 * peça, `META_NAO_E_DADO_DO_CLIENTE`; ou conteúdo jurídico), ou null.
 * Devolve `{ tipo, motivo }`.
 */
function metaNaoEDadoDoCliente(exigencia) {
  const t = metaSemAcento(exigencia).toLowerCase();
  if (META_EXIGENCIA_JURIDICA.test(t)) return { tipo: 'conteudo-juridico', motivo: 'exigência de conteúdo jurídico (tese, fundamento, citação, súmula, precedente, Tema) nunca é dado ausente' };
  const achado = META_NAO_E_DADO_DO_CLIENTE.find((p) => p.padrao.test(t));
  return achado ? { tipo: achado.tipo, motivo: achado.motivo } : null;
}

/** O que o avaliador declara e o código ignora: a nota e o veredito são do código, pela regra do squad. */
const META_CAMPOS_DO_CODIGO = ['limiar', 'limiar_fonte', 'nota', 'verdict'];
/**
 * A própria peça na evidência de uma exigência `posterior`: o arquivo da final ou da
 * minuta. A peça já existe quando a meta roda; o que ela traz se avalia agora.
 */
const META_ARQUIVO_DA_PECA = /[\w.-]*-(?:final|minuta)(?:-v\d+)?\.md\b/i;
/** Palavras que não distinguem uma exigência de outra na semelhança do consenso. */
const META_PALAVRAS_VAZIAS = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'com', 'por', 'pela', 'pelo', 'pelas', 'pelos', 'para', 'um', 'uma', 'que', 'se', 'ou', 'cada', 'todo', 'toda', 'todos', 'todas', 'como', 'ser', 'sua', 'seu']);
/** Fração mínima dos termos da redação menor que está na maior para duas faltas serem a mesma. */
const META_SEMELHANCA_MIN = 0.75;

function metaMarcadorNormalizado(valor) {
  return String(valor ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Os marcadores de dado listados em `pendencias_do_profissional[]` do manifesto da
 * final (`<peça>-final.md.citation-gate.json`), normalizados. Sem manifesto, `null`:
 * aí nenhuma exigência se aceita como dado ausente.
 */
function pendenciasDoManifesto(manifesto, { detalhe = false } = {}) {
  if (!manifesto || typeof manifesto !== 'object') return null;
  const lista = Array.isArray(manifesto.pendencias_do_profissional) ? manifesto.pendencias_do_profissional : [];
  const entradas = lista
    .map((p) => ({ marcador: metaMarcadorNormalizado(p && p.marcador), onde: metaMarcadorNormalizado(p && p.onde) }))
    .filter((p) => META_MARCADOR_DE_DADO.test(p.marcador));
  return detalhe ? entradas : entradas.map((p) => p.marcador);
}

/**
 * Localização lida na própria evidência, quando o avaliador não preencheu `local`: linha
 * ("linha 11", "l. 36", "l.82"), seção ("§ 1", "capítulo VII", "IV.1", "IX:" no começo,
 * "Nota técnica", "tabela"), documento ou folha ("Doc. 04", "fls. 12", "p. 2") ou arquivo
 * ("prazo-fatal.md"), e o arquivo avaliado nomeado ("na peça", "na final"). Devolve o trecho
 * que localiza, ou null. Medido em 24/09/2026 (negativação, 3 de 3 avaliadores, e contestação,
 * rodada 1): nenhum avaliador preencheu `local`, a evidência dizia "linha 11: ..." e o código
 * rebaixava cada ATENDE a PARCIAL; a nota saiu 50 com 18 votos ATENDE.
 */
const META_LOCAL_NA_EVIDENCIA = [
  /\blinhas?\s+\d+/i,
  /(?:^|[^\p{L}])ll?\.\s*\d+/iu,
  /§\s*\d+/,
  /(?:^|[^\p{L}])(?:cap[íi]tulos?|caps?\.|se[çc][ãa]o|se[çc][õo]es|t[íi]tulo|t[óo]pico|par[áa]grafo|itens|item|anexos?|tabela|quadro|nota t[ée]cnica|s[íi]ntese|pre[âa]mbulo|fecho|rodap[ée])(?![\p{L}])(?:\s+(?:[IVXL]+|\d+)(?:\.\d+)*(?![\p{L}\p{N}]))?/iu,
  /\bdocs?\.\s*(?:n[ºo°.]*\s*)?(?:\d|[A-Z]-?\d)/i,
  /(?:^|[^\p{L}])(?:e-)?fls?\.\s*\d+|\bfolhas?\s+\d+|(?:^|[^\p{L}])pp?\.\s*\d+/iu,
  /[\w.-]+\.(?:md|json|jsonl|ya?ml|txt|docx|pdf)\b/i,
  /(?:^|[\s(;,])[IVXL]+\.\d+/,
  /^\s*[IVXL]+(?:\.\d+)*\s*[:,(]/,
  /(?:^|[^\p{L}])na\s+(?:peça|final|versão final|minuta)(?![\p{L}])/iu,
];

function metaLocalDaEvidencia(evidencia) {
  const texto = metaTextoCorrido(evidencia);
  if (!texto) return null;
  // O primeiro lugar que a evidência cita, na ordem do texto (não na da lista de padrões).
  let melhor = null;
  for (const re of META_LOCAL_NA_EVIDENCIA) {
    const m = texto.match(re);
    if (m && (!melhor || m.index < melhor.index)) melhor = m;
  }
  return melhor ? melhor[0].replace(/^[^\p{L}\p{N}§]+/u, '').trim() : null;
}

/** O tipo do marcador de dado ("CONFIRMAR", "PREENCHER", "DILIGENCIA"), sem acento. */
const META_TIPO_DE_MARCADOR = /\[(?:A[ _])?(CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?=[\s:\]\u2013\u2014-])/g;
const metaTipoDeMarcador = (m) => metaSemAcento(String(m).match(/(CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)/)?.[1] || '').toUpperCase();
const META_MARCADOR_SO_TIPO = /^\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)\]$/;

/** Os números de linha que a evidência cita ("linha 11", "l.82, 110, 130 e 184", "l. 177 a 182"). */
function metaLinhasCitadas(texto) {
  const linhas = new Set();
  for (const m of String(texto).matchAll(/(?:\blinhas?|(?:^|[^\p{L}])ll?\.)\s*(\d+(?:\s*(?:,|e|a)\s*\d+)*)/giu)) {
    const partes = m[1].split(/\s*(,|e|a)\s*/);
    let anterior = null;
    let intervalo = false;
    for (const p of partes) {
      if (p === 'a') { intervalo = true; continue; }
      if (p === ',' || p === 'e') continue;
      const n = Number(p);
      if (intervalo && anterior !== null && n > anterior && n - anterior <= 60) for (let i = anterior; i <= n; i += 1) linhas.add(i);
      linhas.add(n);
      anterior = n;
      intervalo = false;
    }
  }
  return linhas;
}

/** As seções em romano que a evidência cita ("capítulo VII", "VII, final", "VIII.3:", "Cap. X"). */
function metaSecoesCitadas(texto) {
  const secoes = new Set();
  const t = String(texto);
  for (const m of t.matchAll(/(?:cap[íi]tulos?|caps?\.|se[çc][ãa]o)\s+([IVXL]+)\b/giu)) secoes.add(m[1].toUpperCase());
  for (const m of t.matchAll(/(?:^|[\s(;,])([IVXL]+)\.\d+/g)) secoes.add(m[1]);
  const inicio = t.match(/^\s*([IVXL]+)(?:\.\d+)*\s*[:,(]/);
  if (inicio) secoes.add(inicio[1]);
  return secoes;
}

/**
 * O marcador de `pendencias_do_profissional[]` que a evidência mostra, quando o avaliador não
 * preencheu `pendencia`: o marcador literal inteiro na evidência; ou o tipo do marcador
 * ("[CONFIRMAR]", "[DILIGÊNCIA: ...]") na evidência e, no manifesto, uma entrada do mesmo tipo
 * no mesmo lugar (a linha que a evidência cita, ou a seção em romano). Entrada só com o tipo
 * ("[CONFIRMAR]" sozinho, nota ao advogado) não conta: não diz qual dado. Entre várias, fica a
 * que divide mais termos com a exigência. Devolve `{ marcador, como }` ou null. Medido em
 * 24/09/2026 (negativação): "linha 11: ... união estável, RG, CPF, e-mail e CEP marcados
 * [CONFIRMAR] e listados em pendencias_do_profissional[]", e as cinco entradas da linha 11
 * estavam no manifesto; sem `pendencia`, o código recusava o dado ausente.
 */
function metaPendenciaDaEvidencia(e, entradas) {
  const lista = (Array.isArray(entradas) ? entradas : [])
    .map((p) => (typeof p === 'string' ? { marcador: p, onde: '' } : p))
    .filter((p) => p && p.marcador && !META_MARCADOR_SO_TIPO.test(p.marcador));
  if (!lista.length) return null;
  const evidencia = metaMarcadorNormalizado(e.evidencia);
  const literal = lista.find((p) => evidencia.includes(p.marcador));
  if (literal) return { marcador: literal.marcador, como: 'marcador literal na evidência' };
  const tipos = new Set([...evidencia.matchAll(META_TIPO_DE_MARCADOR)].map((m) => metaTipoDeMarcador(m[0])));
  if (!tipos.size) return null;
  const linhas = metaLinhasCitadas(evidencia);
  const secoes = metaSecoesCitadas(evidencia);
  const alvo = metaTermos(`${e.exigencia} ${evidencia}`);
  let melhor = null;
  for (const p of lista) {
    if (!tipos.has(metaTipoDeMarcador(p.marcador))) continue;
    const linha = Number(String(p.onde).match(/\blinha\s+(\d+)/i)?.[1]);
    const secao = String(p.onde).match(/^\s*([IVXL]+)\./)?.[1];
    const como = linha && linhas.has(linha) ? `mesmo tipo de marcador na linha ${linha}` : secao && secoes.has(secao) ? `mesmo tipo de marcador na seção ${secao}` : null;
    if (!como) continue;
    let comum = 0;
    for (const t of metaTermos(p.marcador)) if (alvo.has(t)) comum += 1;
    if (!melhor || comum > melhor.comum) melhor = { marcador: p.marcador, como, comum };
  }
  return melhor && { marcador: melhor.marcador, como: melhor.como };
}

/**
 * Os campos que faltam numa exigência de voto ATENDE para ela valer, quando não dá para
 * derivá-los: `status`; na atendida, `evidencia` e `local`; no dado ausente atendido que é dado
 * do cliente, `pendencia`. É falha de FORMATO do avaliador, não da peça: o consenso não a
 * transforma em nota; o comando devolve `refazer-avaliacao`.
 */
function metaCamposFaltantes(e) {
  if (!e.status) return ['status'];
  if (e.status !== 'atendida') return [];
  const campos = [];
  if (!e.evidencia) campos.push('evidencia');
  if (!e.local) campos.push('local');
  if (e.classe === 'dado-ausente' && !e.pendencia && !metaNaoEDadoDoCliente(e.exigencia)) campos.push('pendencia');
  return campos;
}

/**
 * Por que a exigência `atendida` com `classe: dado-ausente` NÃO se aceita, ou null
 * quando se aceita: exigência de conteúdo jurídico, de dado público ou de elemento da
 * própria peça (`metaNaoEDadoDoCliente`), sem o marcador de dado que a peça traz, ou
 * marcador fora de `pendencias_do_profissional[]` (ou sem manifesto).
 */
/**
 * Os marcadores de dado que `pendencia` traz, um ou vários ("[PREENCHER: RG] e [PREENCHER: CPF]"),
 * normalizados. Medido em 26/09/2026 (despejo, motor 0.9.54): a exigência de qualificação do réu
 * pedia RG e CPF, o avaliador escreveu os dois marcadores, e o código lia a frase inteira como um
 * marcador só, que não estava no manifesto; a avaliação virou `apresentar-falhas`.
 */
const META_MARCADORES_NA_PENDENCIA = /\[(?:A[ _])?(?:CONFIRMAR|PREENCHER|DILIG[ÊE]NCIA)(?:[\s:\u2013\u2014-][^\]]*)?\]/g;
function metaMarcadoresDaPendencia(valor) {
  const texto = metaMarcadorNormalizado(valor);
  return [...new Set((texto.match(META_MARCADORES_NA_PENDENCIA) || []).map(metaMarcadorNormalizado))];
}

function motivoDadoAusenteRecusado(e, pendencias) {
  const naoEDado = metaNaoEDadoDoCliente(e.exigencia);
  if (naoEDado) return naoEDado.motivo;
  const marcadores = metaMarcadoresDaPendencia(e.pendencia);
  if (!marcadores.length) return 'sem o marcador de dado ([CONFIRMAR], [PREENCHER], [DILIGÊNCIA]) com que a peça marca o dado como ausente';
  if (!Array.isArray(pendencias)) return 'sem o manifesto da final para conferir `pendencias_do_profissional[]`';
  // Vários marcadores numa exigência valem todos juntos: cada um tem de estar na lista.
  const fora = marcadores.filter((m) => !pendencias.includes(m));
  if (fora.length) return `${fora.join(', ')} não ${fora.length > 1 ? 'estão' : 'está'} em \`pendencias_do_profissional[]\` do manifesto: a diligência não foi listada`;
  return null;
}

/**
 * Os steps posteriores à meta, pelo `pipeline.yaml`: os que vêm depois do step que
 * declara `meta_verifiers` (sem ele, depois do step que grava a `*-final.md`), na
 * ordem do pipeline. `null` quando o pipeline não tem `steps:` legível (aí a
 * exigência `posterior` só se aceita citando algum step); `[]` quando não há step
 * depois da meta (aí nenhuma se aceita). Com `detalhe`, cada step vem como
 * `{ id, tipo, checkpoint, saidas }`: o `type` do step, se é parada humana (`type:
 * checkpoint` ou listado em `checkpoints:` do pipeline) e os arquivos que ele grava.
 */
function stepsPosterioresDoPipeline(pipelineYaml, { detalhe = false } = {}) {
  const linhas = String(pipelineYaml ?? '').split(/\r?\n/);
  const inicio = linhas.findIndex((l) => /^steps:[ \t]*$/.test(l));
  if (inicio < 0) return null;
  const steps = [];
  let fim = linhas.length;
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (/^\S/.test(linha) && !/^-/.test(linha)) { fim = i; break; }
    const id = linha.match(/^[ \t]*-[ \t]+id:[ \t]*["']?([\w.-]+)/);
    if (id) { steps.push({ id: id[1], tipo: null, meta: false, final: false, saidas: [] }); continue; }
    const atual = steps[steps.length - 1];
    if (!atual) continue;
    if (/^[ \t]+meta_verifiers:/.test(linha)) atual.meta = true;
    if (/-final\.md\b/.test(linha)) atual.final = true;
    const tipo = linha.match(/^[ \t]+type:[ \t]*["']?([\w-]+)/);
    if (tipo && !atual.tipo) atual.tipo = tipo[1];
    const saida = linha.match(/^[ \t]+-[ \t]+["']?([^\s"']+\.[a-z0-9]+)["']?[ \t]*$/i);
    if (saida && saida[1].includes('/')) atual.saidas.push(saida[1]);
  }
  if (!steps.length) return null;
  // As paradas humanas declaradas no nível de cima (`checkpoints:`, uma por linha).
  const paradas = new Set();
  const bloco = linhas.findIndex((l, i) => i >= fim && /^checkpoints:[ \t]*$/.test(l));
  if (bloco >= 0) {
    for (const linha of linhas.slice(bloco + 1)) {
      const item = linha.match(/^[ \t]+-[ \t]+["']?([\w.-]+)/);
      if (item) paradas.add(item[1]);
      else if (/^\S/.test(linha)) break;
    }
  }
  let ancora = -1;
  steps.forEach((st, i) => { if (st.meta) ancora = i; });
  if (ancora < 0) steps.forEach((st, i) => { if (st.final) ancora = i; });
  const depois = ancora < 0 ? [] : steps.slice(ancora + 1);
  if (!detalhe) return depois.map((st) => st.id);
  return depois.map((st) => ({ id: st.id, tipo: st.tipo, checkpoint: st.tipo === 'checkpoint' || paradas.has(st.id), saidas: st.saidas }));
}

/**
 * O que a conferência (o step da meta) produz, lido na exigência sem acento: o
 * relatório de entrega, a nota ou o termo de conferência e o manifesto do Citation
 * Gate. Não é artefato de step posterior: o que eles registram se confere agora, pelo
 * manifesto da final e pela peça. Medido na reavaliação de 24/09/2026 (novo2): "não
 * verificado nomeado no relatório de entrega" saiu `posterior` do step-12-aprovacao em
 * alimentos C5 (a2, a3) e reclamação C5 (a1, a2).
 */
const META_ARTEFATO_DA_CONFERENCIA = /\b(relatorio|nota de conferencia|termo de conferencia|manifesto|citation[ -]gate)\b/;

/** O step posterior como objeto: da lista de ids (sem tipo nem saídas) ou do `detalhe` do pipeline. */
function metaStepPosterior(st) {
  return typeof st === 'string' ? { id: st, tipo: null, checkpoint: null, saidas: null } : { id: String(st && st.id), tipo: st.tipo ?? null, checkpoint: st.checkpoint ?? null, saidas: Array.isArray(st.saidas) ? st.saidas : null };
}

function metaTextoCorrido(valor) {
  return String(valor ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Por que a exigência `posterior` NÃO se aceita, ou null quando se aceita. Posterior
 * é artefato de step depois da meta (checklist, pacote), nunca a própria peça: a
 * evidência ou o local que aponta o arquivo da final, ou que é um trecho literal
 * dela (`peca.texto`), recusa; e a evidência tem de citar um dos `stepsPosteriores`
 * (pelo id ou pelo número, "step-13"). Sem a lista (`null`), basta citar um step.
 * O step citado tem de ser de agente e gerar o artefato: com o `detalhe` do pipeline
 * (`stepsPosterioresDoPipeline(..., { detalhe: true })`), parada humana (checkpoint,
 * como o step de aprovação) não cumpre exigência nenhuma; e exigência do que a
 * conferência produz (`META_ARTEFATO_DA_CONFERENCIA`: relatório de entrega, nota de
 * conferência, manifesto) só se aceita citando step de agente que grava arquivo com
 * esse nome (sem as saídas do step, nunca). A recusa pelo artefato da conferência leva
 * `classe: fora-do-alcance` quando o avaliador não deu classe: o relatório não é da
 * peça, e o redator não o conserta. Devolve o motivo (texto) ou null.
 */
function motivoPosteriorRecusado(e, { stepsPosteriores = null, peca = null } = {}) {
  const texto = `${e.evidencia} ${e.local}`;
  const nomeDaPeca = peca && peca.nome ? String(peca.nome) : '';
  if (META_ARQUIVO_DA_PECA.test(texto) || (nomeDaPeca && texto.includes(nomeDaPeca))) {
    return 'posterior aponta a própria peça, que já existe e se avalia agora: posterior é só artefato de step depois da meta';
  }
  const trecho = metaTextoCorrido(e.evidencia);
  if (peca && peca.texto && trecho.length >= 12 && metaTextoCorrido(peca.texto).includes(trecho)) {
    return 'posterior com evidência que é trecho da própria peça: o que a peça traz se avalia agora';
  }
  const citados = [...texto.matchAll(/\bstep-0*(\d+)/gi)].map((m) => Number(m[1]));
  const artefato = metaSemAcento(e.exigencia).toLowerCase().match(META_ARTEFATO_DA_CONFERENCIA);
  const rotulo = artefato && ({ relatorio: 'o relatório', 'nota de conferencia': 'a nota de conferência', 'termo de conferencia': 'o termo de conferência', manifesto: 'o manifesto' }[artefato[1]] || 'o manifesto do Citation Gate');
  const doArtefato = artefato ? `posterior para ${rotulo}, que a conferência (o step da meta) produz: o que ali se registra se confere agora, pelo manifesto da final e pela peça` : null;
  if (!Array.isArray(stepsPosteriores)) {
    if (!citados.length) return 'posterior sem citar o step posterior à meta que cumpre a exigência';
    return doArtefato ? `${doArtefato}; sem o pipeline, não há step de agente que o grave` : null;
  }
  if (!stepsPosteriores.length) return 'posterior num squad sem step depois da meta';
  const steps = stepsPosteriores.map(metaStepPosterior);
  const numero = (id) => { const m = String(id).match(/^step-0*(\d+)/i); return m ? Number(m[1]) : null; };
  const citadosSteps = steps.filter((st) => texto.includes(st.id) || (numero(st.id) !== null && citados.includes(numero(st.id))));
  if (!citadosSteps.length) return `posterior sem citar um step posterior à meta (${steps.map((st) => st.id).join(', ')})`;
  const deAgente = citadosSteps.filter((st) => st.checkpoint !== true);
  if (!deAgente.length) return `posterior citando parada humana (${citadosSteps.map((st) => st.id).join(', ')}, checkpoint): aprovação não gera artefato que cumpra a exigência; só vale step de agente posterior que o gere${doArtefato ? `; e ${doArtefato.replace(/^posterior para /, '')}` : ''}`;
  if (doArtefato) {
    const palavra = artefato[1].split(/[ -]/)[0];
    const gera = deAgente.some((st) => Array.isArray(st.saidas) && st.saidas.some((s) => metaSemAcento(s.split('/').pop()).toLowerCase().includes(palavra)));
    if (!gera) return `${doArtefato}; ${deAgente.map((st) => st.id).join(', ')} não grava esse arquivo`;
  }
  return null;
}

function metaSemAcento(valor) {
  return String(valor ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/** ATENDE, PARCIAL ou NAO a partir do que o avaliador escreveu ("NÃO ATENDE", "nao"...), ou null. */
function metaVeredito(valor) {
  const v = metaSemAcento(valor).toUpperCase().replace(/[\s_-]+/g, ' ');
  if (v === 'ATENDE') return 'ATENDE';
  if (v === 'PARCIAL') return 'PARCIAL';
  if (v === 'NAO' || v === 'NAO ATENDE') return 'NAO';
  return null;
}

function metaClasse(valor) {
  const v = metaSemAcento(valor).toLowerCase().replace(/[\s_]+/g, '-');
  if (META_CLASSES.includes(v)) return v;
  if (v === 'dado-ausente-na-pasta') return 'dado-ausente';
  if (v === 'fora-do-alcance-da-meta') return 'fora-do-alcance';
  return null;
}

/**
 * O objeto `avaliacao_meta` de um retorno do avaliador: o arquivo inteiro como
 * JSON, ou o primeiro bloco ```json que o traga. Nunca a prosa. null se não há.
 */
function extrairAvaliacaoMeta(texto) {
  const bruto = String(texto ?? '').trim();
  const candidatos = [bruto];
  for (const m of bruto.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)) candidatos.push(m[1]);
  for (const candidato of candidatos) {
    let obj;
    try { obj = JSON.parse(candidato); } catch { continue; }
    const av = obj && typeof obj === 'object' ? (obj.avaliacao_meta || obj) : null;
    if (av && Array.isArray(av.criterios)) return av;
  }
  return null;
}

/** Os `success_criteria` do squad.yaml, na ordem (lista em bloco, aspas retiradas). */
function criteriosDoSquadYaml(yaml) {
  const bloco = String(yaml ?? '').match(/^success_criteria:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m);
  if (!bloco) return [];
  return [...bloco[1].matchAll(/^[ \t]+- (.+?)[ \t]*$/gm)].map((m) => {
    const v = m[1].trim();
    const a = v[0];
    return (a === '"' || a === "'") && v.endsWith(a) ? v.slice(1, -1) : v;
  }).filter(Boolean);
}

/**
 * Quantos avaliadores a meta exige: o maior `meta_verifiers` do squad.yaml ou de
 * um step do pipeline; sem declaração, 1. O ritmo do run não entra nesta conta.
 */
function avaliadoresDaMeta(squadYaml, pipelineYaml) {
  const valores = [String(squadYaml ?? ''), String(pipelineYaml ?? '')]
    .flatMap((t) => [...t.matchAll(/^[ \t]*meta_verifiers:[ \t]*["']?(\d+)/gm)].map((m) => Number(m[1])))
    .filter((n) => Number.isInteger(n) && n >= 1);
  return valores.length ? Math.max(...valores) : 1;
}

/** A rubrica em texto fala de limiar? Só para avisar que o código não leu; nunca para extrair número. */
function rubricaDeclaraLimiarEmTexto(texto) {
  return /\blimiar\b/i.test(String(texto ?? ''));
}

/**
 * Normaliza a regra de entrega (`meta_limiar`) a partir de um objeto já lido
 * (valores em número ou em texto, como o parser YAML do motor os devolve), contra
 * `nCriterios` (0 = não conferir índices). Devolve `{ regra, erros }`. Chave
 * desconhecida é erro: uma regra lida pela metade aprovaria o que o squad barra.
 * `nao_max` ausente é 0 (NAO reprova); as demais ausentes não restringem.
 */
function normalizarRegraMeta(bruto, nCriterios = 0) {
  const erros = [];
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { regra: null, erros: ['meta_limiar tem de ser um mapa (ex.: { nao_max: 0, atende_obrigatorios: [1, 4, 6] })'] };
  const vazio = (v) => v === null || v === undefined || (typeof v === 'string' && /^(?:|null|~)$/i.test(v.trim()));
  const inteiro = (v, chave) => {
    if (vazio(v)) return null;
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (!Number.isInteger(n) || n < 0) { erros.push(`meta_limiar.${chave}: "${v}" não é inteiro >= 0`); return null; }
    return n;
  };
  const indices = (v, chave) => {
    if (vazio(v)) return null;
    const lista = Array.isArray(v) ? v : String(v).replace(/^\[|\]$/g, '').split(',').filter((x) => x.trim());
    const saida = [];
    for (const item of lista) {
      const n = Number(typeof item === 'string' ? item.trim() : item);
      if (!Number.isInteger(n) || n < 1 || (nCriterios && n > nCriterios)) erros.push(`meta_limiar.${chave}: "${String(item).trim()}" não é critério de 1 a ${nCriterios || 'N'}`);
      else if (!saida.includes(n)) saida.push(n);
    }
    return saida.sort((a, b) => a - b);
  };
  for (const chave of Object.keys(bruto)) if (!META_LIMIAR_CHAVES.includes(chave)) erros.push(`meta_limiar.${chave}: chave desconhecida (use ${META_LIMIAR_CHAVES.join(', ')})`);
  const regra = {
    nao_max: inteiro(bruto.nao_max, 'nao_max') ?? 0,
    parcial_max: inteiro(bruto.parcial_max, 'parcial_max'),
    atende_obrigatorios: indices(bruto.atende_obrigatorios, 'atende_obrigatorios') ?? [],
    parcial_permitidos: indices(bruto.parcial_permitidos, 'parcial_permitidos'),
    nota_min: inteiro(bruto.nota_min, 'nota_min'),
  };
  // Lista vazia de onde PARCIAL cabe é "em nenhum": a mesma regra que parcial_max 0.
  if (regra.parcial_permitidos && !regra.parcial_permitidos.length) {
    regra.parcial_permitidos = null;
    regra.parcial_max = 0;
  }
  if (regra.nota_min !== null && regra.nota_min > 100) erros.push(`meta_limiar.nota_min: ${regra.nota_min} acima de 100`);
  if (regra.parcial_permitidos) {
    const conflito = regra.parcial_permitidos.filter((n) => regra.atende_obrigatorios.includes(n));
    if (conflito.length) erros.push(`meta_limiar: critério ${conflito.join(', ')} está em atende_obrigatorios e em parcial_permitidos`);
  }
  return { regra: erros.length ? null : regra, erros };
}

/**
 * Lê `meta_limiar` do texto do squad.yaml, nas duas formas que o motor escreve e
 * aceita: bloco indentado (o que o compilador emite) ou mapa inline
 * (`meta_limiar: { nao_max: 0, atende_obrigatorios: [1, 4, 6] }`). Devolve
 * `{ presente, regra, erros }`; ausente é `{ presente: false }`.
 */
function metaLimiarDoSquadYaml(yaml, nCriterios = 0) {
  const texto = String(yaml ?? '');
  const m = texto.match(/^meta_limiar:[ \t]*(.*)$/m);
  if (!m) return { presente: false, regra: null, erros: [] };
  const semComentario = (v) => v.replace(/[ \t]+#.*$/, '').trim();
  const resto = semComentario(m[1]);
  const bruto = {};
  const erros = [];
  if (resto.startsWith('{')) {
    if (!resto.endsWith('}')) return { presente: true, regra: null, erros: ['meta_limiar: mapa inline sem "}" na mesma linha'] };
    const partes = [];
    let atual = '';
    let colchete = 0;
    for (const c of resto.slice(1, -1)) {
      if (c === '[') colchete += 1;
      if (c === ']') colchete -= 1;
      if (c === ',' && colchete === 0) { partes.push(atual); atual = ''; } else atual += c;
    }
    if (atual.trim()) partes.push(atual);
    for (const parte of partes) {
      const kv = parte.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
      if (!kv) { erros.push(`meta_limiar: "${parte.trim()}" não é chave: valor`); continue; }
      bruto[kv[1]] = kv[2];
    }
  } else if (resto) {
    return { presente: true, regra: null, erros: [`meta_limiar: "${resto}" não é mapa`] };
  } else {
    const depois = texto.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
    let chave = null;
    for (const linha of depois) {
      if (!linha.trim() || /^\s*#/.test(linha)) continue;
      if (!/^[ \t]/.test(linha)) break;
      const item = linha.match(/^[ \t]+-[ \t]+(.+)$/);
      if (item && chave) { bruto[chave] = [...(Array.isArray(bruto[chave]) ? bruto[chave] : []), semComentario(item[1])]; continue; }
      const kv = linha.match(/^[ \t]+([a-z_]+):[ \t]*(.*)$/i);
      if (!kv) { erros.push(`meta_limiar: linha "${linha.trim()}" ilegível`); continue; }
      chave = kv[1];
      const valor = semComentario(kv[2]);
      bruto[chave] = valor === '' ? [] : valor;
    }
    for (const [k, v] of Object.entries(bruto)) if (Array.isArray(v) && !v.length) bruto[k] = null;
  }
  const r = normalizarRegraMeta(bruto, nCriterios);
  return { presente: true, regra: r.regra, erros: [...erros, ...r.erros] };
}

/**
 * Normaliza UMA avaliação contra os N critérios do squad. Devolve `{ erros, criterios,
 * sugestoes, sugestoes_fora_da_rubrica }`; com `erros`, a avaliação não entra no consenso.
 * ATENDE sem a lista de exigências, ou com exigência em falta, sem estado, ou atendida
 * sem trecho e local, é rebaixado a PARCIAL (`rebaixado_por_codigo` diz por quê).
 * `pendencias` são os marcadores de `pendencias_do_profissional[]` do manifesto da
 * final (`pendenciasDoManifesto`): exigência `atendida` com `classe: dado-ausente` só
 * fica atendida se o `pendencia` dela está nessa lista (e não é conteúdo jurídico);
 * senão volta a `falta`, com `recusada_por_codigo`.
 * `stepsPosteriores` (`stepsPosterioresDoPipeline`) e `peca` (`{ nome, texto }` da
 * final) conferem cada exigência `posterior` (`motivoPosteriorRecusado`): a que aponta
 * a peça ou não cita um step posterior volta a `falta`, com `recusada_por_codigo`.
 * ATENDE fica ATENDE só com toda exigência `atendida` com trecho e local (ou dado
 * ausente aceito, ou posterior aceito) e pelo menos uma `atendida`.
 * `rubrica` (`{ criterios, qualityCriteria }`: os `success_criteria` e o texto do
 * `quality-criteria.md`) confere as sugestões: a que repete uma exigência de critério
 * ATENDE (`sugestaoRepeteExigencia`) sai da lista e entra como `falta` daquele
 * critério, com `recusada_por_codigo: "sugestao-repete-exigencia"`, `local` com o nome
 * da lista e `repete` com a fonte; o critério cai para PARCIAL. Sem `rubrica`, nada disso.
 * `limiar`, `limiar_fonte`, `nota` e `verdict` do avaliador não entram em conta
 * nenhuma; `campos_ignorados` diz quais vieram.
 */
function normalizarAvaliacaoMeta(av, nCriterios, { pendencias = null, pendenciasOnde = null, stepsPosteriores = null, peca = null, rubrica = null } = {}) {
  const erros = [];
  if (!av || !Array.isArray(av.criterios)) return { erros: ['sem a lista `criterios`'], criterios: [], fora_do_formato: [] };
  const camposIgnorados = META_CAMPOS_DO_CODIGO.filter((k) => av[k] !== undefined && av[k] !== null);
  const foraDoFormato = [];
  const porN = new Map();
  av.criterios.forEach((c, i) => {
    const n = Number(c && c.n !== undefined ? c.n : i + 1);
    if (!Number.isInteger(n) || n < 1 || n > nCriterios) { erros.push(`critério com n inválido (${c && c.n})`); return; }
    if (porN.has(n)) { erros.push(`critério ${n} repetido`); return; }
    const declarado = metaVeredito(c.veredito);
    // Sem o campo, a mensagem diz o que falta: medido em 26/09/2026 (mandado de segurança, motor
    // 0.9.54), três avaliadores leram "não declare limiar, nota final nem veredito final" como
    // proibição do voto por critério, e o erro era `veredito "undefined"`.
    if (!declarado) {
      erros.push(c.veredito === undefined || c.veredito === null || c.veredito === ''
        ? `critério ${n}: sem \`veredito\` (ATENDE, PARCIAL ou NAO): o veredito de cada critério é o voto do avaliador e é obrigatório; o que ele não declara é o limiar, a nota geral e o veredito final da entrega`
        : `critério ${n}: veredito "${c.veredito}" não é ATENDE, PARCIAL nem NAO`);
      return;
    }
    const exigencias = (Array.isArray(c.exigencias) ? c.exigencias : []).map((e) => {
      const status = metaSemAcento(e && e.status).toLowerCase();
      return {
        exigencia: String((e && e.exigencia) ?? '').trim(),
        status: META_STATUS.includes(status) ? status : null,
        evidencia: String((e && e.evidencia) ?? '').trim(),
        local: String((e && e.local) ?? '').trim(),
        classe: metaClasse(e && e.classe),
        pendencia: metaMarcadorNormalizado(e && e.pendencia),
      };
    }).map((e) => {
      // Derivação honesta do que o avaliador deixou de preencher: o local e o marcador que a
      // própria evidência mostra. O que não se deriva é falha de formato (`fora_do_formato`).
      if (e.status !== 'atendida') return e;
      let saida = e;
      if (!saida.local) {
        const local = metaLocalDaEvidencia(saida.evidencia);
        if (local) saida = { ...saida, local, local_derivado_por_codigo: `da evidência: "${local}"` };
      }
      if (saida.classe === 'dado-ausente' && !saida.pendencia) {
        const achada = metaPendenciaDaEvidencia(saida, pendenciasOnde || pendencias);
        if (achada) saida = { ...saida, pendencia: achada.marcador, pendencia_derivada_por_codigo: `da evidência: ${achada.como}` };
      }
      return saida;
    }).map((e) => {
      if (e.status === 'posterior') {
        const motivo = motivoPosteriorRecusado(e, { stepsPosteriores, peca });
        if (!motivo) return e;
        // O relatório de entrega, a nota de conferência e o manifesto não são da peça: o redator não os conserta.
        const daConferencia = META_ARTEFATO_DA_CONFERENCIA.test(metaSemAcento(e.exigencia).toLowerCase());
        return { ...e, status: 'falta', classe: e.classe || (daConferencia ? 'fora-do-alcance' : 'peca'), recusada_por_codigo: motivo, recusada_como: 'posterior' };
      }
      if (e.classe !== 'dado-ausente') return e;
      if (e.status === 'falta') {
        // Falta de dado público ou de elemento da peça volta à redação, não vira pendência do profissional.
        const naoEDado = metaNaoEDadoDoCliente(e.exigencia);
        return naoEDado ? { ...e, classe: 'peca', reclassificada_por_codigo: `dado-ausente para peca: ${naoEDado.motivo}; dado-ausente é só o dado do cliente ou do caso fora da pasta` } : e;
      }
      if (e.status !== 'atendida') return e;
      const motivo = motivoDadoAusenteRecusado(e, pendencias);
      if (!motivo) return e;
      // Recusada por não ser dado do cliente (conteúdo jurídico, dado público, elemento da peça): a falta é da peça.
      return metaNaoEDadoDoCliente(e.exigencia) ? { ...e, status: 'falta', classe: 'peca', recusada_por_codigo: motivo, reclassificada_por_codigo: `dado-ausente para peca: ${motivo}` } : { ...e, status: 'falta', recusada_por_codigo: motivo };
    });
    let veredito = declarado;
    let rebaixado = null;
    // Só no voto ATENDE o formato decide o voto: abaixo dele, o campo que falta não muda nota.
    if (declarado === 'ATENDE') {
      // O dado ausente recusado só por não trazer `pendencia` é formato; recusado por marcador
      // fora do manifesto, por não ser dado do cliente, ou o posterior recusado, é a peça.
      const soFormato = (e) => e.recusada_por_codigo && !e.recusada_como && !e.pendencia && !e.reclassificada_por_codigo;
      const pelaPeca = exigencias.some((e) => (e.status === 'falta' && !e.recusada_por_codigo) || (e.recusada_por_codigo && !soFormato(e)));
      const faltantes = !exigencias.length
        ? [{ n, exigencia: null, campos: ['exigencias'] }]
        : exigencias.map((e) => ({ n, exigencia: e.exigencia || null, campos: metaCamposFaltantes(soFormato(e) ? { ...e, status: 'atendida' } : e) })).filter((f) => f.campos.length);
      // Critério que cai pela peça cai de qualquer jeito: refazer o formato dele não muda o voto.
      if (!pelaPeca) foraDoFormato.push(...faltantes);
    }
    if (declarado === 'ATENDE') {
      const recusada = exigencias.find((e) => e.recusada_por_codigo);
      const semProva = exigencias.find((e) => e.status !== 'atendida' && e.status !== 'posterior')
        || exigencias.find((e) => e.status === 'atendida' && (!e.evidencia || !e.local));
      if (!exigencias.length) rebaixado = 'ATENDE sem as exigências do critério listadas uma a uma';
      else if (recusada) rebaixado = `ATENDE com ${recusada.recusada_como === 'posterior' ? 'posterior' : 'dado ausente'} não aceito (${recusada.recusada_por_codigo}): ${recusada.exigencia || '(exigência sem texto)'}`;
      else if (semProva) rebaixado = `ATENDE com exigência sem evidência (trecho e local): ${semProva.exigencia || '(exigência sem texto)'}`;
      else if (!exigencias.some((e) => e.status === 'atendida')) rebaixado = 'ATENDE sem nenhuma exigência atendida agora (todas posteriores à meta)';
      if (rebaixado) veredito = 'PARCIAL';
    }
    const perdida = exigencias.find((e) => e.status === 'falta' && e.classe);
    let classe = veredito === 'ATENDE' ? null : (metaClasse(c.classe_da_perda) || (perdida && perdida.classe) || 'peca');
    // O voto que chamou de dado ausente o que é da peça: a classe do critério segue a falta reclassificada.
    const reclassificada = exigencias.find((e) => e.reclassificada_por_codigo);
    let classeReclassificada = null;
    if (classe === 'dado-ausente' && reclassificada) {
      classe = 'peca';
      classeReclassificada = `dado-ausente para peca: ${reclassificada.exigencia || '(exigência sem texto)'} não é dado do cliente nem do caso`;
    }
    porN.set(n, { n, veredito, veredito_declarado: declarado, rebaixado_por_codigo: rebaixado, exigencias, classe_da_perda: classe, ...(classeReclassificada ? { classe_reclassificada_por_codigo: classeReclassificada } : {}) });
  });
  for (let n = 1; n <= nCriterios; n += 1) if (!porN.has(n) && !erros.some((e) => e.startsWith(`critério ${n}:`))) erros.push(`falta o critério ${n}`);
  const lista = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  const sugestoes = { sugestoes: lista(av.sugestoes), sugestoes_fora_da_rubrica: lista(av.sugestoes_fora_da_rubrica) };
  // Sugestão que repete uma exigência de critério ATENDE é a falta escrita no lugar
  // errado: vira `falta` daquele critério e o ATENDE cai (sai da lista de sugestões).
  if (rubrica && Array.isArray(rubrica.criterios) && rubrica.criterios.length === nCriterios && !erros.length) {
    const exigencias = metaExigenciasDaRubrica(rubrica.criterios, rubrica.qualityCriteria || '');
    for (const campo of ['sugestoes', 'sugestoes_fora_da_rubrica']) {
      sugestoes[campo] = sugestoes[campo].filter((s) => {
        const atende = [...porN.values()].filter((c) => c.veredito === 'ATENDE').map((c) => c.n);
        const abaixo = [...porN.values()].filter((c) => c.veredito !== 'ATENDE').map((c) => c.n);
        // Em `sugestoes_fora_da_rubrica` o avaliador afirma que a rubrica não pede o item;
        // o código só o desmente quando o item descreve a falta que uma cláusula PARCIAL ou
        // NÃO nomeia. Medido: "data de recebimento da notificação por extenso no preâmbulo"
        // (contestação a3) casa com o texto do C6, que se cumpre na ficha de prazos.
        const fontes = campo === 'sugestoes_fora_da_rubrica' ? ['quality-criteria'] : null;
        // Nota de alcance ("não está na lista fechada e não foi aberto"), que o agente manda
        // escrever aqui, não é falta: medido (novo2), o HC C2 caía por ela em dois votos.
        if (META_NOTA_DE_ALCANCE.test(metaSemAcento(s).toLowerCase())) return true;
        // Primeiro os critérios ATENDE (a falta derruba o voto); sem casamento, os que já
        // estão abaixo, só pelas regras próprias (`regra`): a falta entra na lista (volta à
        // redação) e o veredito não muda. Medido (novo2): reclamação a2 pôs a Súmula 389, II
        // sem o pedido em `sugestoes_fora_da_rubrica` com o C5 já em NAO, e o defeito sumia
        // da lista. Semelhança de termos contra critério já abaixo não entra: nos votos
        // reais, casava melhoria ("juntar captura do sítio da empresa daria âncora ao local
        // de trabalho") com exigência já cumprida.
        const achada = (atende.length ? sugestaoRepeteExigencia(s, exigencias, atende, { fontes }) : null)
          || (abaixo.length ? sugestaoRepeteExigencia(s, exigencias, abaixo, { fontes, soRegra: true }) : null);
        if (!achada) return true;
        const c = porN.get(achada.n);
        c.exigencias.push({
          exigencia: achada.exigencia,
          status: 'falta',
          evidencia: s,
          local: campo,
          classe: 'peca',
          pendencia: '',
          recusada_por_codigo: 'sugestao-repete-exigencia',
          recusada_como: 'sugestao',
          repete: { fonte: achada.fonte, cobertura: achada.cobertura, ...(achada.regra ? { regra: achada.regra } : {}) },
        });
        if (c.veredito !== 'ATENDE') return false;
        c.veredito = 'PARCIAL';
        c.rebaixado_por_codigo = `ATENDE com sugestão que repete exigência do critério (${achada.fonte === 'criterio' ? 'texto do critério' : 'cláusula PARCIAL ou NÃO do quality-criteria.md'}: "${achada.exigencia}"): ${s}`;
        c.classe_da_perda = metaClasse(c.classe_da_perda) || 'peca';
        return false;
      });
    }
  }
  return {
    erros,
    criterios: [...porN.values()].sort((a, b) => a.n - b.n),
    sugestoes: sugestoes.sugestoes,
    sugestoes_fora_da_rubrica: sugestoes.sugestoes_fora_da_rubrica,
    campos_ignorados: camposIgnorados,
    // O critério que a sugestão derrubou caiu pela peça: o formato dele não muda o voto.
    fora_do_formato: foraDoFormato.filter((f) => !/^ATENDE com sugestão/.test((porN.get(f.n) || {}).rebaixado_por_codigo || '')),
  };
}

function metaChave(texto) {
  return metaSemAcento(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Terminações retiradas antes de comparar termos (a mais longa primeiro), para a
 * mesma palavra flexionada contar como uma só: "atribuída" e "atribuindo",
 * "classificação" e "classificada". Depois, as vogais finais saem ("preclui",
 * "precluiu" e "preclusão" dão "precl"; "autoria" e "autor" dão "autor"). Só em
 * termo de 5 letras ou mais, e o radical fica com pelo menos 4.
 */
const META_TERMINACOES = ['amentos', 'imentos', 'amento', 'imento', 'mente', 'idades', 'idade', 'acoe', 'icoe', 'acao', 'icao', 'coe', 'cao', 'soe', 'sao', 'ncia', 'indo', 'ando', 'endo', 'ida', 'ido', 'ada', 'ado', 'avel', 'ivel'];

function metaRadical(termo) {
  if (/^\d+$/.test(termo) || termo.length < 5) return termo;
  let r = termo;
  const fim = META_TERMINACOES.find((s) => r.endsWith(s) && r.length - s.length >= 4);
  if (fim) r = r.slice(0, -fim.length);
  r = r.replace(/[aeiou]+$/, '');
  return r.length >= 4 ? r : termo;
}

/** Um termo normalizado (plural simples e terminação retirados), ou null quando não distingue nada. */
function metaTermo(t) {
  if (!t || META_PALAVRAS_VAZIAS.has(t)) return null;
  if (!/^\d+$/.test(t) && t.length < 2) return null;
  return metaRadical(t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
}

/** Os termos que distinguem uma exigência: sem acento, sem palavra vazia, plural e terminação retirados. */
function metaTermos(texto) {
  const termos = new Set();
  for (const t of metaChave(texto).split(' ')) {
    const n = metaTermo(t);
    if (n) termos.add(n);
  }
  return termos;
}

/**
 * Quanto `a` e `b` se sobrepõem: termos em comum e a fração dos termos da redação
 * menor que está na maior; `bloqueio` diz por que não podem ser a mesma exigência
 * (números diferentes, redação curta demais), e aí `mesma` é false.
 */
function metaSemelhanca(a, b) {
  if (metaChave(a) && metaChave(a) === metaChave(b)) return { mesma: true, comum: metaTermos(a).size, cobertura: 1, bloqueio: null };
  const ta = metaTermos(a);
  const tb = metaTermos(b);
  const numeros = (t) => [...t].filter((x) => /^\d+$/.test(x)).sort().join(' ');
  let comum = 0;
  for (const t of ta) if (tb.has(t)) comum += 1;
  const menor = Math.min(ta.size, tb.size);
  const cobertura = menor ? comum / menor : 0;
  let bloqueio = null;
  if (numeros(ta) && numeros(tb) && numeros(ta) !== numeros(tb)) bloqueio = 'numeros';
  else if (menor < 2) bloqueio = 'curta';
  return { mesma: !bloqueio && comum >= 2 && cobertura >= META_SEMELHANCA_MIN, comum, cobertura, bloqueio };
}

/**
 * Semelhança simples entre duas redações da mesma exigência (o consenso junta as
 * faltas que três avaliadores escreveram de jeitos diferentes): mesma chave
 * normalizada, ou pelo menos dois termos em comum cobrindo 75% dos termos da redação
 * menor, com os mesmos números quando as duas citam número ("pedido 1" e "pedido 4"
 * são faltas diferentes). Medido na reavaliação: despejo C1 com 5 faltas para 2 defeitos.
 */
function metaMesmaExigencia(a, b) {
  return metaSemelhanca(a, b).mesma;
}

/**
 * Os núcleos de uma falta: o dado ou o elemento de que ela fala, lido na exigência
 * sem acento. Duas faltas com núcleos e nenhum em comum são defeitos diferentes, por
 * mais termos que dividam ("Endereço eletrônico das partes na qualificação (CPC 319,
 * II)" e "CPF das partes na qualificação (CPC 319, II)" dividem 5 de 6 termos); com um
 * núcleo em comum, basta metade dos termos da redação menor (e dois em comum) para
 * serem a mesma ("Correção apurada por competência no cálculo" e "Correção discriminada
 * por competência (valor na memória)"). "Pedido 4" é núcleo próprio, pelo número.
 * A lista é fechada, de propósito: são os dados de qualificação e os elementos que se
 * repetem nas faltas da meta (medido na reavaliação de 24/09/2026, novo2).
 */
const META_NUCLEOS = [
  ['cpf', /\bcpf\b/], ['cnpj', /\bcnpj\b/], ['rg', /\b(?:rg|carteira de identidade)\b/], ['pis', /\b(?:pis|pasep|nit)\b/],
  ['oab', /\boab\b/], ['cep', /\bcep\b/], ['email', /\b(?:e ?mail|endereco eletronico|correio eletronico)\b/],
  ['endereco', /\b(?:endereco(?! eletronico)|domicilio|residencia)\b/], ['estado-civil', /\b(?:estado civil|uniao estavel)\b/],
  ['profissao', /\bprofissao\b/], ['data', /\bdata\b/], ['assinatura', /\bassinaturas?\b/],
  ['correcao', /\b(?:correcao|ipca|inpc|igp ?m|indices?|atualizacao monetaria)\b/], ['juros', /\bjuros\b/],
  ['reflexos', /\breflexos?\b/], ['deducao', /\b(?:deducao|abatimento)\b/], ['audiencia', /\b(?:audiencia|conciliacao|mediacao)\b/],
  ['manifesto', /\b(?:manifesto|citation gate)\b/], ['relatorio', /\brelatorio\b/],
];

function metaNucleos(texto) {
  const t = metaChave(texto);
  const nucleos = new Set(META_NUCLEOS.filter(([, re]) => re.test(t)).map(([nome]) => nome));
  for (const m of t.matchAll(/\bpedidos? (\d+)\b/g)) nucleos.add(`pedido-${m[1]}`);
  return nucleos;
}

/** Fração mínima dos termos da redação menor quando as duas faltas dividem um núcleo. */
const META_SEMELHANCA_COM_NUCLEO = 0.5;

/**
 * Duas faltas (ou dois posteriores) do consenso são o mesmo item? Nunca com classes
 * diferentes (o destino muda: `peca` volta à redação, `dado-ausente` vira pendência),
 * nunca com núcleos disjuntos (e-mail e CPF) nem números diferentes ("pedido 1" e
 * "pedido 4"); sim pela semelhança de sempre (`metaSemelhanca`) ou, com um núcleo em
 * comum, com metade dos termos da redação menor e dois em comum.
 */
function metaMesmaFalta(a, b) {
  if (metaFaltasIncompativeis(a, b)) return false;
  if (metaMesmaExigencia(a.exigencia, b.exigencia)) return true;
  const na = metaNucleos(a.exigencia);
  if (![...metaNucleos(b.exigencia)].some((x) => na.has(x))) return false;
  const s = metaSemelhanca(a.exigencia, b.exigencia);
  return s.comum >= 2 && s.cobertura >= META_SEMELHANCA_COM_NUCLEO;
}

/**
 * Duas faltas que nunca são o mesmo item, por mais parecidas: classes diferentes,
 * núcleos disjuntos (as duas com núcleo) ou números diferentes (as duas com número).
 * O consenso não põe no mesmo grupo uma falta incompatível com QUALQUER membro dele:
 * uma redação larga ("qualificação das partes: CPF/CNPJ, e-mail") não emenda dois
 * defeitos (CPF da autora, CNPJ do réu) num item só.
 */
function metaFaltasIncompativeis(a, b) {
  if (a.classe && b.classe && a.classe !== b.classe) return true;
  const na = metaNucleos(a.exigencia);
  const nb = metaNucleos(b.exigencia);
  if (na.size && nb.size && ![...na].some((x) => nb.has(x))) return true;
  return metaSemelhanca(a.exigencia, b.exigencia).bloqueio === 'numeros';
}

/**
 * As cláusulas de nível do `quality-criteria.md` por critério: o texto de cada
 * "PARCIAL" e de cada "NÃO" (o que o critério NÃO aceita; o contrário é exigência).
 * Lê as três formas que os squads usam: tabela com colunas PARCIAL e NÃO (primeira
 * coluna numerada, "1.", "| 1 |" ou "Título (1)"; sem número, pela posição só quando
 * há uma linha por critério), seção "### Critério N" ou "**N. título**" com itens "- PARCIAL:" e
 * "- NÃO:" (também "PARCIAL quando…"). Devolve uma lista por critério, na ordem.
 * Linha de tabela sem número numa tabela com mais linhas que critérios não se liga
 * a critério nenhum (o código não adivinha qual é).
 */
function clausulasDoQualityCriteria(md, nCriterios) {
  const linhas = String(md ?? '').split(/\r?\n/);
  const porCriterio = Array.from({ length: nCriterios }, () => []);
  const celulas = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const numero = (cs) => {
    const c = String(cs[0] ?? '').replace(/\*/g, '').trim();
    const m = c.match(/^(?:crit[eé]rio\s+)?(\d+)(?:[.):]|\s|$)/i) || c.match(/\((\d+)\)$/);
    return m ? Number(m[1]) : null;
  };
  for (let i = 0; i < linhas.length; i += 1) {
    if (!/^\s*\|/.test(linhas[i])) continue;
    const cab = celulas(linhas[i]).map((c) => metaSemAcento(c.replace(/\*/g, '')).toUpperCase());
    const colunas = [cab.indexOf('PARCIAL'), cab.findIndex((c) => c === 'NAO' || c === 'NAO ATENDE')].filter((k) => k >= 0);
    if (!colunas.length) continue;
    const dados = [];
    let j = i + 1;
    for (; j < linhas.length && /^\s*\|/.test(linhas[j]); j += 1) {
      if (/^\s*\|[\s:|-]*$/.test(linhas[j])) continue;
      dados.push(celulas(linhas[j]));
    }
    const numeradas = dados.some((cs) => numero(cs) !== null);
    dados.forEach((cs, k) => {
      const n = numeradas ? numero(cs) : (dados.length === nCriterios ? k + 1 : null);
      if (!n || n > nCriterios) return;
      for (const col of colunas) if (cs[col]) porCriterio[n - 1].push(cs[col]);
    });
    i = j - 1;
  }
  let atual = null;
  for (const linha of linhas) {
    const cab = linha.match(/^\s*(?:#{2,6}\s*|\*\*\s*)(?:crit[eé]rio\s+)?(\d+)\s*[.:)\u2013-]/i);
    if (cab) { const n = Number(cab[1]); atual = n >= 1 && n <= nCriterios ? n : null; continue; }
    if (/^\s*#{1,6}\s/.test(linha) || /^\s*\*\*[^*]+\*\*\s*$/.test(linha)) { atual = null; continue; }
    if (!atual) continue;
    const item = linha.match(/^\s*(?:[-*]\s*)?\**\s*(PARCIAL|N[ÃA]O)(?![\wÀ-ÿ])\s*(?:quando\b)?\s*\**\s*[.:]?\s*\**\s*(.+)$/);
    if (item && item[2].trim()) porCriterio[atual - 1].push(item[2].trim());
  }
  return porCriterio;
}

/** Remissão legal e numeral romano: localizam, não dizem o que se exige. */
const META_TERMO_DE_REMISSAO = /^(?:art|arts|artigo|artigos|cpc|cpp|clt|cf|cc|cdc|lei|leis|inciso|incisos|alinea|alineas|paragrafo|paragrafos|unico|caput|[ivxl]+)$/;

/** Os termos de conteúdo de um texto: sem número e sem remissão legal (quantos dizem o que se exige). */
function metaTermosDeConteudo(texto) {
  const termos = new Set();
  for (const t of metaChave(texto).split(' ')) {
    if (/^\d+$/.test(t) || META_TERMO_DE_REMISSAO.test(t)) continue;
    const n = metaTermo(t);
    if (n) termos.add(n);
  }
  return termos;
}

/**
 * As exigências de um texto da rubrica, uma por trecho: o texto se parte em ";",
 * ":", fim de frase, vírgula (fora de número), "ou", "mas" e "nem", e o que está
 * entre parênteses vira trecho próprio. Numa cláusula de falta (PARCIAL ou NÃO,
 * `daFalta`), o trecho "X sem Y" ou "falta Y" fica só com o Y: é o que falta, e o
 * contrário da falta é a exigência. Trecho com menos de dois termos de conteúdo (só
 * remissão, número ou uma palavra) não é exigência que se compare.
 */
function metaExigenciasDoTexto(texto, { daFalta = false } = {}) {
  const limpo = String(texto ?? '').replace(/[`*]/g, ' ');
  const parenteses = [...limpo.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]);
  const pedacos = [limpo.replace(/\([^()]*\)/g, ' '), ...parenteses]
    .flatMap((p) => p.split(/[;:]|\.\s+(?=[A-ZÀ-Ý"“])|,(?!\d)|\s(?:e|ou|mas|nem)\s/));
  const saida = [];
  for (const pedaco of pedacos) {
    let p = pedaco;
    if (daFalta) {
      const m = p.match(/(?:^|\s)(?:sem|falta|faltam|faltando)\s+(.+)$/i);
      if (m) p = m[1];
    }
    p = p.replace(/\s+/g, ' ').replace(/^[\s.,"'“”]+|[\s.,"'“”]+$/g, '');
    if (metaTermosDeConteudo(p).size >= 2 && !saida.includes(p)) saida.push(p);
  }
  return saida;
}

/**
 * As exigências de cada critério para conferir as sugestões do avaliador: as do
 * texto literal do critério (`success_criteria`) e as das cláusulas PARCIAL e NÃO
 * do `quality-criteria.md` daquele critério. Uma lista por critério, cada item
 * `{ texto, fonte }` (`criterio` ou `quality-criteria`).
 */
function metaExigenciasDaRubrica(criterios, qualityCriteria = '') {
  const lista = Array.isArray(criterios) ? criterios : [];
  const clausulas = clausulasDoQualityCriteria(qualityCriteria, lista.length);
  return lista.map((texto, i) => {
    const itens = metaExigenciasDoTexto(texto).map((t) => ({ texto: t, fonte: 'criterio' }));
    for (const clausula of clausulas[i]) {
      for (const t of metaExigenciasDoTexto(clausula, { daFalta: true })) {
        if (!itens.some((x) => metaChave(x.texto) === metaChave(t))) itens.push({ texto: t, fonte: 'quality-criteria' });
      }
      // A cláusula de citação sem o pedido que ela sustenta se confere por regra própria
      // (`META_SUGESTAO_CITACAO_SEM_PEDIDO`), com o texto inteiro da cláusula.
      if (META_CLAUSULA_CITACAO_SEM_PEDIDO.test(metaSemAcento(clausula).toLowerCase())) {
        itens.push({ texto: clausula.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim(), fonte: 'quality-criteria', regra: 'citacao-sem-pedido' });
      }
    }
    return itens;
  });
}

/**
 * Cláusula PARCIAL ou NÃO sobre citação que não sustenta pedido da peça ("Citação
 * verificada, mas fora do pedido que sustenta", "citação sem o pedido"), lida sem acento.
 */
const META_CLAUSULA_CITACAO_SEM_PEDIDO = /\bcitac(?:ao|oes)\b[^|]*\b(?:fora d[oa]s?|sem (?:o |os )?|desligad\w* d[oa]s?|alhei\w* a[os]?)\s*pedidos?\b/;
/**
 * A sugestão que descreve essa falta: nomeia uma citação (súmula, OJ, Tema, artigo,
 * lei, precedente, com número) E diz que a peça não formula o pedido. A mesma falta
 * dita com outras palavras que a cláusula, por isso regra própria e não semelhança de
 * termos. Medido na reavaliação de 24/09/2026 (novo2): reclamação a2 ("(Súmula 389, II);
 * a peça pede só a obrigação de fazer, sem o pedido alternativo liquidado. Nenhum
 * critério cobra essa correspondência") e a3 ("cita a Súmula 389, II, mas não formula o
 * pedido sucessivo"), contra a cláusula PARCIAL do C5.
 */
/**
 * Nota de alcance: o avaliador diz que o arquivo está fora da lista fechada, ou que não o
 * abriu. O agente manda escrevê-la em `sugestoes_fora_da_rubrica`; ela não descreve falta
 * da peça, e o código não a compara com a rubrica.
 */
const META_NOTA_DE_ALCANCE = /\b(?:lista fechada|fora da lista|nao (?:esta|estava|estavam|estao) na lista)\b|\bnao (?:foi|foram) abert[oa]s?\b|\bnao abert[oa]s?\b|\bnao (?:o |a )?abri\b/;
const META_SUGESTAO_CITACAO = /\b(?:sumulas?|oj|orientac\w* jurisprudencia\w*|temas?|arts?\.?|artigos?|leis?|precedentes?|resp|re|hc)\s*(?:n[.o]*\s*)?\d+/;
const META_SUGESTAO_SEM_PEDIDO = /\b(?:sem (?:o |os |a |as )?pedidos?|nao (?:formula|faz|traz|deduz)\w* (?:o |os |a |as )?pedidos?|pede (?:so|apenas|somente)|falta (?:o |a )?pedidos?)\b/;

/**
 * Os critérios que a sugestão cita ("Critério 3", "(critério 1)", "critérios 2 e 3")
 * e o texto dela sem a citação, que é endereço e não conteúdo.
 */
function metaSugestaoSemCitacao(sugestao) {
  const citados = [];
  const texto = String(sugestao ?? '').replace(/\(?\bcrit[eé]rios?\s+(\d+(?:\s*(?:,|e)\s*\d+)*)\)?/gi, (_, lista) => {
    for (const n of lista.split(/\s*(?:,|e)\s*/)) if (/^\d+$/.test(n)) citados.push(Number(n));
    return ' ';
  });
  return { citados: [...new Set(citados)], texto };
}

/**
 * A exigência da rubrica que a sugestão repete, ou null. A sugestão que cita
 * critério se compara só com as exigências dele; a que não cita, com as de todos os
 * critérios em `candidatos`, e fica com o maior casamento. Casar é a mesma regra da
 * deduplicação de faltas (`metaSemelhanca`: mesma normalização, 75% dos termos da
 * redação menor, pelo menos dois em comum, números iguais quando os dois citam).
 * A exigência com `regra` (hoje só `citacao-sem-pedido`) não se compara por termos: casa
 * quando a sugestão nomeia uma citação e diz que o pedido não está na peça. `soRegra`
 * deixa só essas. Devolve `{ n, exigencia, fonte, cobertura, regra? }`.
 */
function sugestaoRepeteExigencia(sugestao, exigenciasPorCriterio, candidatos, { fontes = null, soRegra = false } = {}) {
  const { citados, texto } = metaSugestaoSemCitacao(sugestao);
  const alvo = citados.length ? candidatos.filter((n) => citados.includes(n)) : candidatos;
  let melhor = null;
  const semAcento = metaSemAcento(texto).toLowerCase();
  const citacaoSemPedido = META_SUGESTAO_CITACAO.test(semAcento) && META_SUGESTAO_SEM_PEDIDO.test(semAcento);
  for (const n of alvo) {
    for (const ex of exigenciasPorCriterio[n - 1] || []) {
      if (fontes && !fontes.includes(ex.fonte)) continue;
      if (ex.regra === 'citacao-sem-pedido') {
        if (citacaoSemPedido && !melhor) melhor = { n, exigencia: ex.texto, fonte: ex.fonte, cobertura: 1, comum: 0, regra: ex.regra };
        continue;
      }
      if (soRegra) continue;
      const s = metaSemelhanca(ex.texto, texto);
      if (s.mesma && (!melhor || s.cobertura > melhor.cobertura || (s.cobertura === melhor.cobertura && s.comum > melhor.comum))) {
        melhor = { n, exigencia: ex.texto, fonte: ex.fonte, cobertura: s.cobertura, comum: s.comum, regra: null };
      }
    }
  }
  return melhor && { n: melhor.n, exigencia: melhor.exigencia, fonte: melhor.fonte, cobertura: Math.round(melhor.cobertura * 100) / 100, ...(melhor.regra ? { regra: melhor.regra } : {}) };
}

/**
 * A classe por maioria entre os votos contados; no empate no topo, `peca`, de
 * propósito (a peça volta à redação, o lado seguro), e nunca a ordem da lista.
 * Devolve `{ classe, empate, votos }`; sem voto, `classe: null`.
 */
function metaClassePorMaioria(classes) {
  const votos = {};
  for (const c of classes) if (c) votos[c] = (votos[c] || 0) + 1;
  const maximo = Math.max(0, ...Object.values(votos));
  if (!maximo) return { classe: null, empate: false, votos };
  const topo = Object.keys(votos).filter((c) => votos[c] === maximo);
  return topo.length === 1 ? { classe: topo[0], empate: false, votos } : { classe: 'peca', empate: true, votos };
}

function metaUniao(listas) {
  const vistos = new Set();
  const saida = [];
  for (const item of listas.flat()) {
    const chave = metaChave(item);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(item);
  }
  return saida;
}

/**
 * O consenso por critério. `avaliacoes` já normalizadas (sem erros), uma por
 * avaliador; `criterios` é a lista do squad.yaml; `regra` a de entrega do squad
 * (`meta_limiar` normalizado; ausente, o padrão do motor). O critério fica no
 * nível mais alto que mais da metade dos votos alcança; a nota sai da escala
 * 2/1/0 e o veredito da regra, com cada parte que reprovou nomeada.
 */
/**
 * O trecho da exigência que nomeia o artefato onde ela se registraria ("nomeado no
 * relatório de entrega", "registrado na nota de conferência"): quem não leu escreve a
 * exigência pelo artefato que não abriu; quem leu, pelo que conferiu.
 */
const META_TRECHO_DO_ARTEFATO = /\s*,?\s*(?:\b(?:nomead|registrad|listad|indicad|declarad)\w*\s+)?\b(?:no|na|nos|nas)\s+(?:relatorio|nota|termo|manifesto|checklist)\b.*$/;

/**
 * A falta `fora-do-alcance` de um voto e a exigência que outro avaliador deu por
 * `atendida` com trecho e local são a mesma exigência? A falta sem o trecho do artefato
 * (`META_TRECHO_DO_ARTEFATO`) contra a atendida inteira ou contra cada parte dela
 * separada por ";", pela semelhança de sempre (`metaSemelhanca`: 75% dos termos da
 * redação menor, dois em comum, números iguais). Medido (novo2, alimentos C5): "O não
 * verificado sai da final nomeado no relatório de entrega" (a2) e "Nenhum marcador [NÃO
 * VERIFICADO] na versão final; o não verificado saiu da final" (a1).
 */
function metaMesmaExigenciaConferida(falta, atendida) {
  const nucleo = metaChave(falta).replace(META_TRECHO_DO_ARTEFATO, '').trim();
  if (!nucleo) return false;
  return [atendida, ...String(atendida).split(';')].some((parte) => metaSemelhanca(nucleo, parte).mesma);
}

/**
 * Quem não leu não contradiz quem leu. No consenso, a falta `fora-do-alcance` de um voto
 * (o avaliador não conferiu: arquivo fora do alcance, posterior recusado para o
 * relatório) cuja exigência OUTRO avaliador deu por `atendida` com trecho e local conta
 * como atendida naquele voto, com `superada_por_evidencia: [avaliadores]`. Sem falta
 * restante, o voto volta a ATENDE (`elevado_por_evidencia`). Falta `peca` ou
 * `dado-ausente` nunca é superada: é discordância de mérito, e decide a maioria.
 * Medido (novo2, alimentos C5): a1 conferiu que o não verificado saiu da final, pelo
 * manifesto e pela peça; a2 e a3 marcaram "nomeado no relatório de entrega" como
 * posterior da aprovação, recusado como `fora-do-alcance`, e derrubavam o critério.
 * Devolve as avaliações ajustadas (as originais ficam intactas).
 */
function metaSuperarPorEvidencia(avaliacoes, nCriterios) {
  const ajustadas = avaliacoes.map((a) => ({ ...a, criterios: a.criterios.map((c) => ({ ...c, exigencias: c.exigencias.map((e) => ({ ...e })) })) }));
  for (let i = 0; i < nCriterios; i += 1) {
    const conferidas = [];
    avaliacoes.forEach((a, k) => {
      for (const e of a.criterios[i].exigencias) {
        if (e.status === 'atendida' && e.evidencia && e.local && !e.recusada_por_codigo) conferidas.push({ k: k + 1, exigencia: e.exigencia });
      }
    });
    if (!conferidas.length) continue;
    ajustadas.forEach((a, k) => {
      const c = a.criterios[i];
      let superou = false;
      for (const e of c.exigencias) {
        if (e.status !== 'falta' || e.classe !== 'fora-do-alcance') continue;
        // Quem tem a mesma falta fora do alcance também não leu: não conta como quem conferiu.
        const tambemNaoLeu = new Set(avaliacoes.map((o, j) => (o.criterios[i].exigencias.some((x) => x.status === 'falta' && x.classe === 'fora-do-alcance' && metaMesmaExigenciaConferida(x.exigencia, metaChave(e.exigencia).replace(META_TRECHO_DO_ARTEFATO, ''))) ? j + 1 : null)).filter(Boolean));
        const por = [...new Set(conferidas.filter((x) => x.k !== k + 1 && !tambemNaoLeu.has(x.k) && metaMesmaExigenciaConferida(e.exigencia, x.exigencia)).map((x) => x.k))].sort((x, y) => x - y);
        if (!por.length) continue;
        e.status = 'atendida';
        e.status_do_voto = 'falta';
        e.superada_por_evidencia = por;
        superou = true;
      }
      if (!superou || c.veredito === 'ATENDE') return;
      const resta = c.exigencias.some((e) => e.status === 'falta')
        || c.exigencias.some((e) => e.status === 'atendida' && !e.superada_por_evidencia && (!e.evidencia || !e.local))
        || !c.exigencias.some((e) => e.status === 'atendida');
      if (resta) return;
      c.elevado_por_evidencia = `${c.veredito} para ATENDE: a única falta era fora-do-alcance e outro avaliador a conferiu com evidência`;
      c.veredito = 'ATENDE';
      c.classe_da_perda = null;
    });
  }
  return ajustadas;
}

function combinarMeta(avaliacoesDosVotos, { criterios, regra = null, exigidos = 1 } = {}) {
  // Quem não leu não contradiz quem leu: falta fora-do-alcance superada pela evidência de outro voto.
  const avaliacoes = metaSuperarPorEvidencia(avaliacoesDosVotos, criterios.length);
  const n = avaliacoes.length;
  const aplicada = regra || META_REGRA_PADRAO;
  const porCriterio = criterios.map((texto, i) => {
    const votos = avaliacoes.map((a) => a.criterios[i]);
    const pontos = votos.map((v) => META_PONTOS[v.veredito]).sort((a, b) => b - a);
    const veredito = META_NIVEL_POR_PONTOS[pontos[Math.floor(n / 2)]];
    // A classe da perda: maioria dos votos que perderam; empate, `peca` (metaClassePorMaioria).
    const porClasse = metaClassePorMaioria(votos.filter((v) => v.veredito !== 'ATENDE').map((v) => v.classe_da_perda));
    const classe = veredito === 'ATENDE' ? null : (porClasse.classe || 'peca');
    // Redações diferentes do mesmo defeito viram um item só (metaMesmaFalta), com as
    // outras redações em `redacoes`. A falta entra no grupo se for a mesma que algum
    // membro e não for incompatível com nenhum (`metaFaltasIncompativeis`): uma redação
    // larga ("qualificação das partes: CPF/CNPJ, e-mail") não emenda dois defeitos (CPF
    // da autora, CNPJ do réu) num item só. Medido na
    // reavaliação de 24/09/2026 (novo2): o despejo C1 juntava e-mail (`peca`) e CPF
    // (`dado-ausente`) pela semelhança que a remissão "CPC 319, II" inflava.
    const exigenciasCom = (aceita) => {
      const grupos = [];
      votos.forEach((v, k) => {
        for (const e of v.exigencias) {
          if (!aceita(e) || !metaChave(e.exigencia)) continue;
          let grupo = grupos.find((g) => g.membros.some((m) => metaMesmaFalta(m, e)) && !g.membros.some((m) => metaFaltasIncompativeis(m, e)));
          if (!grupo) { grupo = { membros: [], avaliadores: [] }; grupos.push(grupo); }
          grupo.membros.push(e);
          if (!grupo.avaliadores.includes(k + 1)) grupo.avaliadores.push(k + 1);
        }
      });
      return grupos.map(({ membros, avaliadores }) => {
        const [primeira] = membros;
        const item = { exigencia: primeira.exigencia, evidencia: primeira.evidencia, local: primeira.local, classe: primeira.classe, avaliadores: avaliadores.sort((a, b) => a - b) };
        const classes = membros.map((m) => m.classe).filter(Boolean);
        if (new Set(classes).size > 1) item.classe = metaClassePorMaioria(classes).classe;
        const outras = metaUniao(membros.slice(1).map((m) => m.exigencia)).filter((r) => metaChave(r) !== metaChave(primeira.exigencia));
        if (outras.length) item.redacoes = outras;
        const pendencia = membros.find((m) => m.pendencia);
        if (pendencia) item.pendencia = pendencia.pendencia;
        const recusada = membros.find((m) => m.recusada_por_codigo);
        if (recusada) item.recusada_por_codigo = recusada.recusada_por_codigo;
        const reclassificada = membros.find((m) => m.reclassificada_por_codigo);
        if (reclassificada) item.reclassificada_por_codigo = reclassificada.reclassificada_por_codigo;
        return item;
      });
    };
    return {
      n: i + 1,
      criterio: texto,
      veredito,
      pontos: META_PONTOS[veredito],
      votos: votos.map((v) => v.veredito),
      unanime: votos.every((v) => v.veredito === votos[0].veredito),
      classe_da_perda: classe,
      classe_da_perda_votos: veredito === 'ATENDE' ? null : porClasse.votos,
      classe_por_empate: veredito !== 'ATENDE' && porClasse.empate,
      faltas: exigenciasCom((e) => e.status === 'falta'),
      // Faltas fora-do-alcance que outro avaliador conferiu com evidência: contam como atendidas.
      superadas_por_evidencia: votos.flatMap((v, k) => v.exigencias.filter((e) => e.superada_por_evidencia).map((e) => ({ avaliador: k + 1, exigencia: e.exigencia, superada_por_evidencia: e.superada_por_evidencia }))),
      posteriores: exigenciasCom((e) => e.status === 'posterior'),
      // Atendidas por dado ausente, com a diligência listada no manifesto: não pesam na
      // nota e são o que o profissional resolve antes do protocolo.
      dados_ausentes: exigenciasCom((e) => e.status === 'atendida' && e.classe === 'dado-ausente' && !e.superada_por_evidencia),
      // O que o código leu na evidência porque o avaliador não preencheu: quantos `local` e
      // quais `pendencia` (o marcador e como foi achado), para o humano conferir a derivação.
      derivados_por_codigo: {
        local: votos.reduce((t, v) => t + v.exigencias.filter((e) => e.local_derivado_por_codigo).length, 0),
        pendencia: votos.flatMap((v, k) => v.exigencias.filter((e) => e.pendencia_derivada_por_codigo).map((e) => ({ avaliador: k + 1, exigencia: e.exigencia, pendencia: e.pendencia, como: e.pendencia_derivada_por_codigo }))),
      },
      rebaixados_por_codigo: votos.map((v, k) => (v.rebaixado_por_codigo ? `avaliador ${k + 1}: ${v.rebaixado_por_codigo}` : null)).filter(Boolean),
      // Votos cuja classe `dado-ausente` virou `peca` porque a falta era de dado público ou de elemento da peça.
      elevados_por_evidencia: votos.map((v, k) => (v.elevado_por_evidencia ? `avaliador ${k + 1}: ${v.elevado_por_evidencia}` : null)).filter(Boolean),
      reclassificados_por_codigo: votos.map((v, k) => (v.classe_reclassificada_por_codigo ? `avaliador ${k + 1}: ${v.classe_reclassificada_por_codigo}` : null)).filter(Boolean),
    };
  });
  const soma = porCriterio.reduce((t, c) => t + c.pontos, 0);
  const nota = criterios.length ? Math.round((100 * soma) / (2 * criterios.length)) : 0;
  const cs = (lista) => lista.map((k) => `C${k}`).join(', ');
  const emNao = porCriterio.filter((c) => c.veredito === 'NAO').map((c) => c.n);
  const emParcial = porCriterio.filter((c) => c.veredito === 'PARCIAL').map((c) => c.n);
  const falhas = [];
  if (emNao.length > aplicada.nao_max) falhas.push({ parte: 'nao_max', detalhe: `${emNao.length} critério(s) em NAO (${cs(emNao)}); a regra admite ${aplicada.nao_max}` });
  if (aplicada.parcial_max !== null && emParcial.length > aplicada.parcial_max) falhas.push({ parte: 'parcial_max', detalhe: `${emParcial.length} critério(s) em PARCIAL (${cs(emParcial)}); a regra admite ${aplicada.parcial_max}` });
  const semAtende = aplicada.atende_obrigatorios.filter((k) => k <= porCriterio.length && porCriterio[k - 1].veredito !== 'ATENDE');
  if (semAtende.length) falhas.push({ parte: 'atende_obrigatorios', detalhe: `${cs(semAtende)} sem ATENDE; a regra exige ATENDE em ${cs(aplicada.atende_obrigatorios)}` });
  if (aplicada.parcial_permitidos) {
    const fora = emParcial.filter((k) => !aplicada.parcial_permitidos.includes(k));
    if (fora.length) falhas.push({ parte: 'parcial_permitidos', detalhe: `PARCIAL em ${cs(fora)}; a regra só admite PARCIAL em ${cs(aplicada.parcial_permitidos) || 'nenhum critério'}` });
  }
  if (aplicada.nota_min !== null && nota < aplicada.nota_min) falhas.push({ parte: 'nota_min', detalhe: `nota ${nota} abaixo da mínima ${aplicada.nota_min}` });
  const aprovado = falhas.length === 0;
  return {
    avaliadores: n,
    exigidos,
    regra: aplicada,
    limiar: aplicada.nota_min,
    nota,
    verdict: aprovado ? 'APROVADO' : 'REPROVADO',
    falhas_da_regra: falhas,
    motivo: aprovado ? `nota ${nota}; a regra de entrega foi cumprida em todas as partes` : falhas.map((f) => `${f.parte}: ${f.detalhe}`).join('; '),
    atendidos: porCriterio.filter((c) => c.veredito === 'ATENDE').length,
    total: porCriterio.length,
    divergentes: porCriterio.filter((c) => !c.unanime).map((c) => c.n),
    // A nota de cada voto, recalculada dos vereditos já normalizados (nunca a que o avaliador escreveu).
    notas_por_avaliador: avaliacoes.map((a) => (criterios.length ? Math.round((100 * a.criterios.reduce((t, c) => t + META_PONTOS[c.veredito], 0)) / (2 * criterios.length)) : 0)),
    campos_ignorados: metaUniao(avaliacoes.map((a) => a.campos_ignorados || [])),
    criterios: porCriterio,
    sugestoes: metaUniao(avaliacoes.map((a) => a.sugestoes || [])),
    sugestoes_fora_da_rubrica: metaUniao(avaliacoes.map((a) => a.sugestoes_fora_da_rubrica || [])),
  };
}
// <<< meta-consenso:end

export {
  META_PONTOS,
  META_CLASSES,
  META_STATUS,
  META_LIMIAR_PADRAO,
  META_LIMIAR_CHAVES,
  META_REGRA_PADRAO,
  META_MARCADOR_DE_DADO,
  META_EXIGENCIA_JURIDICA,
  META_CAMPOS_DO_CODIGO,
  metaVeredito,
  metaMesmaExigencia,
  metaMesmaFalta,
  metaSuperarPorEvidencia,
  metaFaltasIncompativeis,
  metaNucleos,
  metaNaoEDadoDoCliente,
  META_NAO_E_DADO_DO_CLIENTE,
  META_ARTEFATO_DA_CONFERENCIA,
  metaSemelhanca,
  metaClassePorMaioria,
  clausulasDoQualityCriteria,
  metaExigenciasDaRubrica,
  sugestaoRepeteExigencia,
  stepsPosterioresDoPipeline,
  motivoPosteriorRecusado,
  pendenciasDoManifesto,
  metaLocalDaEvidencia,
  metaPendenciaDaEvidencia,
  extrairAvaliacaoMeta,
  criteriosDoSquadYaml,
  avaliadoresDaMeta,
  rubricaDeclaraLimiarEmTexto,
  normalizarRegraMeta,
  metaLimiarDoSquadYaml,
  normalizarAvaliacaoMeta,
  combinarMeta,
};
