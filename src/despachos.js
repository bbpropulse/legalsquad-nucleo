// Despachos escritos pelo código, um por papel (fase 2 do plano do motor enxuto, 21/10/2026).
//
// Até a 0.9.108, só o revisor (`despacho_do_revisor`) e o verificador de citações (o pacote do
// 0.9.102) recebiam prompt do código; os outros papéis recebiam o que o chefe improvisava a partir
// de ~57 mil tokens de runner. Foi no improviso que os runs medidos perderam tempo: o leitor de
// autos mandado "confirmar toda folha citada" (51 minutos, 16/10/2026), o revisor mandado conferir
// citação e conta (5 horas, 09/10/2026), o subagente que respondeu na conversa e não gravou o
// artefato (23/09/2026). Aqui cada papel tem o seu texto, montado das mesmas regras que o runner
// dá hoje, com os caminhos já resolvidos por quem chama. O `squad-state proximo` usa estes textos;
// nenhum despacho do caminho principal sai sem eles.
//
// Módulo PURO: sem I/O, sem relógio. Quem chama passa os caminhos (absolutos, com a raiz do
// projeto) e o que leu do disco. O bloco abaixo é copiado VERBATIM para `scripts/squad-state.mjs`
// e `templates/scripts/squad-state.mjs` (guardado por `sync-blocos`).

// >>> despachos:begin
/**
 * A ordem de gravar, literal (runner, "If execution: subagent"). Sem ela, um subagente que traz a
 * regra geral de não criar arquivos de relatório devolve o conteúdo na resposta e não grava nada
 * (medido em 23/09/2026: o leitor do resumo da inicial fez o trabalho inteiro e não gravou).
 */
const DESPACHO_ORDEM_DE_GRAVAR = 'Grave o artefato deste step com a ferramenta Write exatamente neste caminho. Ele é o output obrigatório do step, lido pelos steps seguintes; não é um relatório opcional, e responder só na conversa deixa o step sem saída.';

/** A frase do nativo read-only: ele não tem escrita, e quem grava o retorno é o runner (ou o hook). */
const DESPACHO_SO_LEITURA = 'Você só lê: devolva o resultado inteiro na sua resposta, no formato do seu agente; quem o grava, como veio, é o runner.';

/** Os papéis que o run despacha e o construtor de cada um (o teste confere que nenhum fica sem). */
const PAPEIS_DESPACHADOS = Object.freeze([
  'leitor', 'nativo', 'descritor', 'sumario', 'pesquisa', 'calculista', 'redator', 'revisor',
  'verificador-citacoes', 'verificador-persuasao', 'conferente', 'avaliador', 'contraditor', 'agente',
]);

const despachoLinhas = (itens) => itens.filter(Boolean).join('\n');
const despachoLista = (titulo, itens) => (itens && itens.length ? `${titulo}\n${itens.map((i) => `- ${i}`).join('\n')}` : '');

/** A persona em uma linha, do `squad-party.csv` e do frontmatter do agente. */
function despachoPersona({ nome, titulo, papelResumo } = {}) {
  const quem = [nome, titulo ? `(${titulo})` : null].filter(Boolean).join(' ');
  return quem ? `Você é ${quem}${papelResumo ? `: ${papelResumo}` : ''}.` : '';
}

/**
 * O bloco "leia antes de trabalhar": a definição completa do agente (o `.agent.md`), a
 * best-practice de formato, as skills aprovadas pelo resolvedor, o step e as tarefas, na ordem de
 * composição do runner (agente, formato, skills). Caminhos absolutos: o subagente lê pela raiz do
 * projeto, mesmo com a sessão aberta em outra pasta (m2b a m7 da 0.9.81, o avaliador sem o caminho
 * absoluto varria o disco).
 */
function despachoLeituras({ agente, formato, skills = [], passo, tarefas = [], empresa, memoria } = {}) {
  const itens = [];
  if (agente) itens.push(`Persona, princípios e método (a sua definição completa): ${agente}`);
  if (formato) itens.push(`Formato do step (best-practice): ${formato}`);
  for (const s of skills) itens.push(`Skill aprovada no run: ${s}`);
  if (passo) itens.push(`O step, com o processo, as condições de veto e os critérios de qualidade: ${passo}`);
  tarefas.forEach((t, i) => itens.push(`Tarefa ${i + 1} de ${tarefas.length} (em sequência; a saída de uma é a entrada da seguinte): ${t}`));
  if (empresa) itens.push(`Contexto do escritório: ${empresa}`);
  if (memoria) itens.push(`Memória do squad: ${memoria}`);
  return itens.length ? despachoLista('Leia antes de trabalhar, à letra e nesta ordem:', itens) : '';
}

/** O fecho de todo despacho que grava: o caminho, a ordem literal e o veto. */
function despachoSaida(saidas = [], { veto = true } = {}) {
  const lista = saidas.filter(Boolean);
  if (!lista.length) return '';
  const caminho = lista.length === 1 ? `Saída (caminho resolvido pelo código; use este, nunca o caminho cru do step): ${lista[0]}` : despachoLista('Saídas (caminhos resolvidos pelo código; use estes, nunca os caminhos crus do step):', lista);
  return despachoLinhas([caminho, DESPACHO_ORDEM_DE_GRAVAR, veto ? 'Antes de terminar, confira as condições de veto do step contra o que gravou.' : null]);
}

/**
 * O despacho de um agente do squad (`general-purpose`, com o `.agent.md` no prompt): leitor da fase
 * zero, pesquisa, calculista, redator despachado, conferente e qualquer outro step de agente. As
 * partes específicas do papel vêm em `extras` (o escopo da leitura, a regra do dado público, o
 * contrato de redação), e o modo de correção em `fixes`/`ajustes`.
 */
function despachoDoAgenteDoSquad({
  papel = 'agente', code, run, stepId, stepNome, persona = {}, leituras = {}, entrada = null, outrasEntradas = [],
  saidas = [], extras = [], fixes = [], ajustes = [], minutaAnterior = null, marca = null, nativos = [],
} = {}) {
  const cabeca = despachoLinhas([
    marca,
    despachoPersona(persona),
    `Papel neste run: ${papel}, no step ${stepId}${stepNome ? ` (${stepNome})` : ''} do squad ${code}, run ${run}. O despacho é do código; o step e o seu agente dizem como fazer.`,
  ]);
  const correcao = fixes.length
    ? despachoLinhas([
      `Modo correção: aplique só estas correções, na ordem de gravidade, sobre a versão anterior${minutaAnterior ? ` (${minutaAnterior})` : ''}, sem reescrever o resto; grave a versão seguinte no caminho de saída abaixo:`,
      ...fixes.map((f) => `- ${f}`),
    ])
    : ajustes.length
      ? despachoLinhas([
        `Modo ajustes: aplique só estes ajustes de forma sobre ${minutaAnterior || 'a versão anterior'}, sem tocar em citação, tese ou pedido; grave a versão seguinte no caminho de saída abaixo:`,
        ...ajustes.map((f) => `- ${f}`),
      ])
      : '';
  const nativosLinha = nativos.length ? `Retornos dos subagentes nativos deste step (já despachados pelo runner; use-os como entrada, sem refazer a leitura, e feche o artefato com a linha \`Nativos despachados: ${nativos.map((n) => n.nome).join(', ')}\`, citando cada arquivo): ${nativos.map((n) => `${n.nome} em ${n.saida}`).join('; ')}.` : '';
  return [
    cabeca,
    despachoLeituras(leituras),
    entrada ? `Entrada (caminho resolvido pelo código; leia este, não o do step): ${entrada}` : '',
    despachoLista('Também na entrada:', outrasEntradas),
    nativosLinha,
    ...extras,
    correcao,
    despachoSaida(saidas),
  ].filter(Boolean).join('\n\n');
}

/**
 * O despacho do subagente nativo que o step declara (`resumo-processo`, `jurisprudencia-stj-stf`,
 * `contraditor` no pré-mortem...): vai pelo nome, antes dos agentes do squad, e o retorno dele é
 * entrada do agente do step. Quem tem escrita grava no `_tmp/` do run; o read-only devolve na
 * resposta e o runner grava como veio.
 */
function despachoDoNativo({ nome, code, run, stepId, stepNome, passo, entrada = null, outrasEntradas = [], saida, escreve = true, extras = [] } = {}) {
  return [
    `Você é o subagente nativo \`${nome}\`, despachado pelo runner no step ${stepId}${stepNome ? ` (${stepNome})` : ''} do squad ${code}, run ${run}. O seu retorno é entrada do agente deste step, que o confere e usa, sem refazer a leitura.`,
    passo ? `O que o step pede (leia a parte que cita \`${nome}\`, à letra): ${passo}` : '',
    entrada ? `Entrada (caminho resolvido pelo código): ${entrada}` : '',
    despachoLista('Também na entrada:', outrasEntradas),
    ...extras,
    escreve ? despachoSaida([saida], { veto: false }) : `${DESPACHO_SO_LEITURA} Destino do retorno: ${saida}.`,
  ].filter(Boolean).join('\n\n');
}

/**
 * O descritor de imagens dos autos (o especialista `resumo-processo`, um por lote): o contrato
 * orientado a prova do runner ("Imagens dos autos, descritas antes dos leitores"). O lote K é fatia
 * fixa da lista; dois descritores nunca pegam a mesma imagem.
 */
function despachoDoDescritor({ code, run, parte, comandoDoLote } = {}) {
  return [
    `Você descreve como prova as imagens do lote ${parte} dos autos do squad ${code} (run ${run}): descritor de imagens, antes dos leitores da fase zero.`,
    `1. Rode \`${comandoDoLote}\`: é a lista do seu lote, com \`abrir\` (ou \`imagem\`), \`documento_md\`, \`legenda\`, \`exif\`, \`descricao\`, \`cabecalho_obrigatorio\`, \`campos_obrigatorios\`, \`ancora\` e \`contexto_da_avulsa\`. Os caminhos são relativos à pasta \`autos\` do JSON.`,
    '2. Para cada item: abra a imagem (`abrir`, quando houver, senão `imagem`), leia a folha no `documento_md` (o texto ao redor e a `legenda`) e grave a descrição no caminho `descricao`, abrindo com a linha `cabecalho_obrigatorio`, literal, e com os campos de `campos_obrigatorios`, nesta ordem: Tipo (foto, print de conversa, planta, tabela manuscrita, formulário, outro); Contexto no documento (abre com a âncora citável que `ancora` pede, "fls. N, Fotografia K", com o rótulo que o documento dá à imagem; na imagem avulsa, o que `contexto_da_avulsa` pede, com a fonte da atribuição, ou "local não atribuído em documento"; do relato vêm só o lugar e o objeto); Elementos de prova (o estado do que aparece, danos e extensão, marcas, objetos e posição, medidas ou escala visíveis; descreve, não conclui causa); Data e hora (visível na imagem, ou do `exif`, dizendo a origem: a do EXIF é "data de captura nos metadados do arquivo"; sem as duas, "não visível"); Texto legível (transcrito entre aspas, nada inferido); Incerto; O que não se vê. Campo sem conteúdo leva "nada visível", nunca some.',
    '3. Sem nome de pessoa fora do que estiver escrito na imagem, sem rosto descrito, sem placa nem documento pessoal transcrito ("[placa não transcrita]"), sem coordenada de GPS.',
    '4. Não integre nem marque o sumário: quem integra é o runner, depois de todos os lotes.',
    'Cada descrição é um arquivo de saída obrigatório: grave com a ferramenta Write exatamente no caminho `descricao` de cada item (relativo à pasta `autos` do JSON); responder só na conversa deixa a imagem sem descrição.',
  ].join('\n\n');
}

/**
 * O sumário do caso (uma vez por autos, não por run), pelo especialista `resumo-processo`: o
 * contrato do runner ("Sumário do caso"). `modo: 'imagens'` só acrescenta as imagens novas à seção
 * Imagens relevantes de um sumário em dia.
 */
function despachoDoSumario({ code, run, autos, sumario, comandoDaFolha, semProcesso = false, modo = 'completo' } = {}) {
  const ancora = semProcesso ? 'cada linha com `Doc. NN, p. N` no lugar da folha (sem processo, o sumário é dos documentos do cliente: Identificação do ato e de quem o recebe)' : 'toda linha de fato com a folha (`fls. N`)';
  if (modo === 'imagens') {
    return [
      `Você atualiza o sumário do caso do squad ${code} (run ${run}): só acrescente à seção **Imagens relevantes** de ${sumario} as imagens descritas depois da última marcação (cada imagem que importa à controvérsia, com a folha e o número da figura, o que mostra em uma linha e o caminho da descrição). O resto do sumário fica como está.`,
      `Os autos estão em ${autos}; as descrições, em \`_sumario/imagens/\` dessa pasta, e a folha se abre com \`${comandoDaFolha}\`.`,
      despachoSaida([sumario], { veto: false }),
    ].join('\n\n');
  }
  return [
    `Você escreve o sumário do caso do squad ${code} (run ${run}), uma vez por autos: o mapa que os leitores da fase zero usam, nunca fonte de citação.`,
    `Os autos estão em ${autos}: o índice \`_index.yaml\` e o \`documento.md\` de cada documento (em \`_md/<slug>/\`), já com os blocos das imagens descritas. Abra só a folha que precisar com \`${comandoDaFolha}\`, nunca o documento inteiro de uma vez quando a folha basta.`,
    `Contrato: ${sumario} com as seções **Identificação** (juízo, classe, número), **Partes e polos**, **Cronologia** (uma linha por ato, com \`fls. N\`), **Documentos por folha** (o que cada um é e o que prova), **Decisões** (o que cada uma decidiu, com folha), **Imagens relevantes** (cada imagem que importa à controvérsia, com a folha e o número da figura, o que mostra em uma linha e o caminho da descrição; obrigatória quando há imagem descrita) e **Pendências** (o que não foi lido, faixas sem texto, o que depende de conferência); ${ancora}; sem CPF, CNPJ, RG, e-mail ou telefone; nada além do que está nos autos.`,
    'Não marque o sumário: quem marca é o runner, com o hash do índice que ele leu antes de despachar.',
    despachoSaida([sumario], { veto: false }),
  ].join('\n\n');
}

/**
 * O verificador de citações (`verificador-citacoes`, read-only), com o pacote do 0.9.102 quando há
 * cópia baixada no run. Uma voz por lote; no gate final, as pendentes de consenso vão com a
 * `source_url` registrada, para reabrir a fonte e transcrever o trecho.
 */
function despachoDoVerificadorDeCitacoes({
  code, run, minuta, pesquisa, indiceDeFontes, pacote = null, orcamento = null, pendentes = [], consenso = [],
  lote = null, lotes = null, final = false,
} = {}) {
  const itens = (lista) => lista.map((p) => `${p.bruto || p.title}${p.linha ? ` (linha ${p.linha})` : ''}${p.source_url ? ` · fonte registrada: ${p.source_url}` : ''}${p.diploma_de ? ` · diploma pelo contexto: ${p.diploma_de}` : ''}`);
  return [
    `Verificador de citações do run ${run} (squad ${code}), ${final ? 'gate final' : 'rodada desta versão da minuta'}${lote ? `, lote ${lote} de ${lotes}` : ''}. Você só lê e julga; não edita a minuta.`,
    despachoLista('Leia:', [`a minuta: ${minuta}`, pesquisa ? `a pesquisa jurídica (a fonte de citação autorizada): ${pesquisa}` : null, indiceDeFontes ? `as fontes oficiais baixadas por código neste run: ${indiceDeFontes}` : null].filter(Boolean)),
    pacote
      ? `Pacote do verificador (escrito pelo código): ${pacote}. Julgue \`achado\` e \`achado-revogado\` pelo trecho recortado, sem busca, e confira a PRECISÃO pelo \`artigo_inteiro\`, também sem busca (o conteúdo que a frase atribui ao dispositivo citado está nele ou em outro do mesmo artigo? se em outro, ressalva de fidelidade nomeando o dispositivo certo; a lista ou os requisitos cumulativos que a minuta enumera omitem item?). Busque só nas \`com_busca\` (\`fonte-sem-dispositivo\`, \`sem-fonte\`, \`ambiguo\`, \`precedente\`), até ${orcamento || 'o orçamento do pacote'} buscas.`
      : '',
    despachoLista(lote ? 'Confira só os itens do seu lote:' : 'Confira só estas citações (as pendentes do cartório nesta versão):', itens(pendentes)),
    despachoLista('Pendentes de consenso no gate final: reabra a fonte registrada de cada uma e transcreva o trecho que a sustenta (a confirmação nova precisa de evidência):', itens(consenso)),
    'A cópia local vem antes da web: abra primeiro a cópia do `fontes/INDEX.jsonl`; julgado do acervo se abre por Read (ou Grep pelo número); a web só onde não há cópia. Divergência de tese não se marca sem procurar os embargos de declaração no mesmo registro.',
    'Não escreva consulted_at: o runner grava a hora do registro.',
    'Devolva a tabela de sempre, uma linha por citação: VERIFICADA / DIVERGENTE / NÃO ENCONTRADA, com a `source_url` e o trecho literal que sustenta; da cópia local ou do acervo, também o `sha256_texto` e o `fonte_local`.',
  ].filter(Boolean).join('\n\n');
}

/**
 * O verificador de persuasão (Gate de Sobrevivência ao Resumo, 4.6): minuta, pesquisa e linha de
 * ataque lida do foco por código, nunca de memória. Reconferência: um verificador, com o relatório
 * anterior.
 */
function despachoDoVerificadorDePersuasao({ code, run, minuta, pesquisa, linhaDeAtaque = null, relatorioAnterior = null, voz = null } = {}) {
  return [
    `Verificador de persuasão do run ${run} (squad ${code})${voz ? `, voz ${voz}` : ''}: a peça sobrevive ao resumo de triagem antes de o juiz ler? Você só lê.`,
    despachoLista('Leia:', [`a minuta: ${minuta}`, pesquisa ? `a pesquisa jurídica: ${pesquisa}` : null].filter(Boolean)),
    linhaDeAtaque ? `Linha de ataque do profissional (literal, do foco; item obrigatório do inventário): "${linhaDeAtaque}"` : 'O profissional não deu linha de ataque: confira só pedido e teses.',
    relatorioAnterior ? `Modo reconferência: o relatório anterior está em ${relatorioAnterior}; confira se cada fix de alta dele foi resolvido na minuta corrigida, sem abrir frente nova.` : '',
    'Devolva o resumo de triagem hostil (dez linhas, extrativo), o inventário com SOBREVIVE / PERDIDO, a âncora de cada tese no Tema que a governa e APROVADO ou REPROVADO, com os fixes com gravidade no prefixo (`alta:` para pedido, tese principal, linha de ataque e Tema não ancorado da tese principal; `media:` para o resto).',
  ].filter(Boolean).join('\n\n');
}

/**
 * O revisor do squad (`revisor-squad`): a marca na primeira linha (o hook SubagentStop a lê), a
 * persona, o step, a rubrica e o `despacho_do_revisor` do código, literal e sem tarefa a mais
 * (medido em 09/10/2026: o despacho improvisado custou 5 horas).
 */
function despachoDoRevisorDoSquad({ marca, code, run, stepId, stepNome, persona = {}, leituras = {}, entrada, outrasEntradas = [], rubrica = null, despachoDoCodigo = '', saida, fixesAnteriores = [] } = {}) {
  return [
    marca,
    despachoPersona(persona),
    `Papel neste run: revisor, no step ${stepId}${stepNome ? ` (${stepNome})` : ''} do squad ${code}, run ${run}, em contexto fresco: quem redigiu não julga.`,
    despachoLeituras(leituras),
    entrada ? `A minuta a revisar (caminho resolvido pelo código): ${entrada}` : '',
    despachoLista('Também na entrada:', outrasEntradas),
    rubrica ? `A rubrica da meta, pública no squad: ${rubrica}` : '',
    fixesAnteriores.length ? despachoLinhas(['Os fixes do ciclo anterior: confira cada um primeiro (aplicado, não aplicado, regressão); não aplicado e regressão são `alta`; defeito novo só reprova se for crítico ou alto:', ...fixesAnteriores.map((f) => `- ${f}`)]) : '',
    despachoDoCodigo,
    saida ? despachoLinhas([`Grave o veredito em ${saida}, com o bloco YAML \`verdict\`/\`fixes\`/\`ajustes\`/\`rubrica\` no topo e a gravidade no prefixo de cada correção (só \`critica\` e \`alta\` sustentam REJECT).`, DESPACHO_ORDEM_DE_GRAVAR]) : '',
  ].filter(Boolean).join('\n\n');
}

/** O contraditor (read-only, não vota): red-team na aprovação ou pré-mortem na fase zero. */
function despachoDoContraditor({ code, run, minuta = null, pesquisa = null, outrasEntradas = [], modo = 'red-team', destino } = {}) {
  return [
    `Contraditor do run ${run} (squad ${code}), modo ${modo === 'pre-mortem' ? 'pré-mortem (fase zero, antes da redação)' : 'red-team (antes da aprovação da minuta)'}. Você não vota e não corrige: gera os ataques.`,
    despachoLista('Leia:', [minuta ? `a minuta: ${minuta}` : null, pesquisa ? `a pesquisa jurídica: ${pesquisa}` : null, ...outrasEntradas].filter(Boolean)),
    'Devolva a tabela com os TRÊS ataques mais fortes que a parte contrária faria, um de cada natureza (FATO, DIREITO, FORMA), e, para cada um, ANTECIPADO (e onde) ou DESCOBERTO. Nada de fato fora dos autos; sem web.',
    `${DESPACHO_SO_LEITURA} Destino do retorno: ${destino}.`,
  ].filter(Boolean).join('\n\n');
}

/** Tamanho do despacho, para a medição da fase 2 (caracteres, linhas e tokens estimados a 4 por caractere). */
function medirDespacho(prompt) {
  const t = String(prompt || '');
  return { caracteres: t.length, linhas: t ? t.split('\n').length : 0, tokens_estimados: Math.ceil(t.length / 4) };
}
// <<< despachos:end

export {
  DESPACHO_ORDEM_DE_GRAVAR, DESPACHO_SO_LEITURA, PAPEIS_DESPACHADOS,
  despachoPersona, despachoLeituras, despachoSaida, despachoDoAgenteDoSquad, despachoDoNativo,
  despachoDoDescritor, despachoDoSumario, despachoDoVerificadorDeCitacoes, despachoDoVerificadorDePersuasao,
  despachoDoRevisorDoSquad, despachoDoContraditor, medirDespacho,
};
