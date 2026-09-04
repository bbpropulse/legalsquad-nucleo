// Monta a base legal de uma skill a partir de normas já parseadas por artigo.
//
// ## O que este módulo faz, e o que deliberadamente NÃO faz
//
// Enriquecer skill jurídica tem duas camadas. Uma é **mecânica**: achar o
// dispositivo que rege o tema e transcrevê-lo com fidelidade e fonte. A outra é
// **julgamento**: a armadilha onde se erra, a contra-tese, o que distingue
// figuras próximas. A primeira escala e não admite invenção — o texto ou está
// na norma ou não está. A segunda não escala e é onde o piloto de
// enriquecimento produziu citação falsa.
//
// Este módulo faz **só a primeira**, e o diz no bloco que gera. Uma skill com o
// dispositivo certo transcrito e a fonte declarada já retira do agente a tarefa
// em que ele mais erra: lembrar o número do artigo.
//
// ## Por que o casamento é conservador a ponto de recusar
//
// O risco desta automação não é deixar skill vazia — é preencher com o artigo
// **errado**. Um dispositivo genérico ("Esta Resolução dispõe sobre...") casa
// qualquer tema por acidente e sairia transcrito com toda a autoridade de
// fonte oficial. A skill pareceria fundamentada apontando para o lugar errado,
// e isso é pior que a casca, que ao menos se declara vazia.
//
// Daí as duas travas: no mínimo dois termos materiais casados, e recusa
// silenciosa (string vazia) quando não há casamento forte.

const VAZIAS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'ou', 'a', 'o', 'as', 'os', 'em', 'no', 'na',
  'nos', 'nas', 'por', 'para', 'com', 'sem', 'ao', 'aos', 'que', 'um', 'uma', 'sob',
  'sobre', 'entre', 'ante', 'apos', 'ate', 'pela', 'pelo', 'seu', 'sua', 'este', 'esta',
]);

const TAMANHO_MINIMO = 4;
/** Um termo casado é coincidência; dois é sinal. */
const TERMOS_MINIMOS = 2;
const MAXIMO_DE_DISPOSITIVOS = 6;

/**
 * Um artigo real sobre o tema menciona os termos PERTO um do outro — é a
 * mesma frase, o mesmo parágrafo. Um artigo-lista (revogação, definições em
 * cascata) menciona termos dispersos, um por assunto, sem relação entre eles.
 * Contar presença no documento inteiro não distingue os dois; presença dentro
 * desta janela, sim.
 */
const JANELA_DE_PROXIMIDADE = 220;

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Termos materiais do tema — o que sobra depois de tirar preposição, palavra
 * curta demais para discriminar e verbo de ação, mais o que as siglas da área
 * rendem por extenso.
 *
 * As duas listas de domínio (`sinonimos`, `acoes`) vêm do CHAMADOR e são
 * opcionais: o motor não conhece os institutos de área nenhuma — essa é a
 * fronteira núcleo × pacote do projeto. Aqui elas são só um mapa e um
 * conjunto; quem sabe que "ADI" quer dizer "ação direta de
 * inconstitucionalidade" é a ferramenta de área, não este módulo.
 *
 * @param {string} tema
 * @param {{sinonimos?: Record<string,string[]>, acoes?: string[]}} [opcoes]
 */
export function termosDoTema(tema, opcoes = {}) {
  const { sinonimos = {}, acoes = [] } = opcoes;
  const descartaveis = new Set(acoes.map(semAcento));

  const palavras = semAcento(tema).split(/[^a-z0-9]+/).filter(Boolean);

  // Sigla rende os termos do nome por extenso — sem isso, "análise de
  // cabimento de ADI" não casa com a Lei 9.868, que nunca escreve "ADI".
  const expandidas = [];
  for (const palavra of palavras) {
    const expansao = sinonimos[palavra];
    if (expansao) expandidas.push(...expansao.flatMap((frase) => semAcento(frase).split(/[^a-z0-9]+/)));
  }

  return [...new Set(
    [...palavras, ...expandidas]
      .filter((t) => t.length >= TAMANHO_MINIMO && !VAZIAS.has(t) && !descartaveis.has(t))
  )];
}

function radical(termo) {
  // Plural e flexão simples: "sobras" ≈ "sobra", "gastos" ≈ "gasto". Corte
  // grosseiro de propósito — stemmer de verdade traria dependência e erraria
  // em jargão jurídico.
  return termo.replace(/(coes|oes|ais|eis|is|ns|s)$/, '');
}

/**
 * @param {string} tema
 * @param {{sigla: string, url: string, numero: string, texto: string}[]} corpus
 * @returns {typeof corpus} os dispositivos com casamento forte, mais relevantes
 *   primeiro; `[]` quando nenhum casa o suficiente.
 */
/**
 * Quantos termos distintos aparecem dentro da MESMA janela do texto — não no
 * documento inteiro. Desliza a janela a partir de cada ocorrência de termo:
 * um artigo genuinamente sobre o tema tem os termos concentrados numa frase;
 * um artigo-lista os tem espalhados, um por item enumerado.
 */
function casamentoLocal(alvo, termos) {
  const posicoes = termos
    .map((t) => ({ termo: t, indices: [...alvo.matchAll(new RegExp(t, 'g'))].map((m) => m.index) }))
    .filter((p) => p.indices.length);

  let melhorJanela = 0;
  for (const { indices } of posicoes) {
    for (const centro of indices) {
      const presentes = new Set(
        posicoes
          .filter((p) => p.indices.some((i) => Math.abs(i - centro) <= JANELA_DE_PROXIMIDADE))
          .map((p) => p.termo)
      );
      melhorJanela = Math.max(melhorJanela, presentes.size);
    }
  }
  return melhorJanela;
}

/**
 * O texto compilado traz a redação revogada e a vigente do MESMO artigo em
 * arquivos separados (`l8213-art-143`, `-143-b`, `-143-c`). Sem deduplicar,
 * a base legal saía com o art. 143 três vezes, ocupando as vagas que outros
 * dispositivos do tema poderiam usar.
 */
function semRepetirArtigo(artigos) {
  const vistos = new Set();
  const unicos = [];
  // Percorre de trás para frente: a ÚLTIMA ocorrência é a redação vigente.
  for (let i = artigos.length - 1; i >= 0; i--) {
    const artigo = artigos[i];
    const chave = `${artigo.sigla}|${artigo.numero}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.unshift(artigo);
  }
  return unicos.slice(0, MAXIMO_DE_DISPOSITIVOS);
}

export function selecionarDispositivos(tema, corpus, opcoes = {}) {
  const termos = termosDoTema(tema, opcoes).map(radical).filter(Boolean);
  if (termos.length < TERMOS_MINIMOS) return [];

  const pontuados = corpus
    .map((artigo) => ({ artigo, casados: casamentoLocal(semAcento(artigo.texto), termos) }))
    .filter((p) => p.casados >= TERMOS_MINIMOS);

  if (!pontuados.length) return [];

  // Só sobrevive quem casa tanto quanto o melhor: um artigo que casa 2 de 5
  // termos ao lado de outro que casa 5 é ruído, não alternativa.
  const melhor = Math.max(...pontuados.map((p) => p.casados));
  const empatados = pontuados.filter((p) => p.casados === melhor);

  // Empate grande no topo é a expressão do tema sendo comum demais no corpus
  // ("licitação" numa lei inteira sobre licitação). Antes isso recusava tudo,
  // e o custo medido foram 322 skills sem base legal alguma.
  //
  // Há um critério antes de desistir: DENSIDADE. Um artigo curto e focado no
  // tema informa mais que um artigo-catálogo longo que o menciona de
  // passagem. Quando a densidade separa, ela decide; quando também empata
  // (artigos igualmente curtos e igualmente sobre o tema), aí não há escolha
  // possível e a recusa continua — apresentar seis como "a" base legal seria
  // sorteio disfarçado.
  if (empatados.length > MAXIMO_DE_DISPOSITIVOS) {
    const comDensidade = empatados.map((p) => ({ ...p, densidade: p.casados / Math.max(p.artigo.texto.length, 1) }));
    const maiorDensidade = Math.max(...comDensidade.map((p) => p.densidade));
    // Tolerância de 20% para não fatiar por diferença de pontuação irrelevante.
    const destacados = comDensidade.filter((p) => p.densidade >= maiorDensidade * 0.8);
    if (destacados.length > MAXIMO_DE_DISPOSITIVOS) return [];
    return semRepetirArtigo(destacados.sort((a, b) => b.densidade - a.densidade).map((p) => p.artigo));
  }

  return semRepetirArtigo(empatados.map((p) => p.artigo));
}

function trecho(texto, limite = 900) {
  const limpo = String(texto).replace(/\n{2,}/g, '\n').trim();
  if (limpo.length <= limite) return limpo;
  // Corta em fim de parágrafo para não truncar o dispositivo no meio de um
  // inciso — meia regra transcrita engana mais que regra ausente.
  const corte = limpo.lastIndexOf('\n', limite);
  return `${limpo.slice(0, corte > limite / 2 ? corte : limite).trim()}\n\n[…] — abra a fonte para o texto integral.`;
}

/**
 * O texto compilado do Planalto anota remissões editoriais — "(Vide ADI
 * 5970)", "(Vide ADPF 548)" — junto de dispositivos com ação direta
 * relacionada. É nota OFICIAL, não invenção; mas transcrevê-la sem marcação
 * faz a skill se apresentar como tendo conferido uma ADI que só copiou de
 * passagem. A transcrição continua literal — só a remissão ganha o aviso.
 *
 * "(Redação dada pela Lei…)" NÃO entra aqui: é o histórico do próprio
 * dispositivo, coberto pela mesma fonte já declarada para o artigo inteiro.
 */
function marcarRemissoesNaoAbertas(texto) {
  return texto.replace(
    /\(Vide\s+(ADI|ADIN|ADPF|ADC|RE|HC|MS)[^)]*\)/gi,
    (remissao) => `${remissao} [NÃO VERIFICADO]`
  );
}

/**
 * Uma norma citada DENTRO do texto de outra ("Lei nº 9.504/1997, art. 26")
 * segue convenção de sigla previsível no pipeline: `L` + dígitos para lei
 * ordinária, `LC` + dígitos para complementar. Resolve a sigla para procurar
 * no corpus se aquela norma também está carregada — e, se estiver, a URL
 * dela é genuinamente conhecida, mesmo que nenhum artigo específico tenha
 * sido selecionado por casamento temático.
 */
function siglasCitadasNoTexto(texto) {
  const siglas = new Set();
  for (const m of texto.matchAll(/Lei\s+Complementar\s+n?[º°]?\s*(\d+)|LC\s*n?[º°]?\s*(\d+)/gi)) {
    siglas.add(`LC${m[1] || m[2]}`);
  }
  for (const m of texto.matchAll(/Lei\s+n?[º°]?\s*([\d.]+)\/\d{2,4}/gi)) {
    siglas.add(`L${m[1].replace(/\./g, '')}`);
  }
  return siglas;
}

// A mesma string que abre o bloco em `montarBaseLegal` — exportada para que
// `contemBaseLegalVerificada` (e qualquer outro leitor) detecte pelo texto
// real gerado, nunca por uma cópia que pode divergir silenciosamente.
export const MARCADOR_BASE_LEGAL = '## Base legal — dispositivos a conferir';

/**
 * `linhas_proprias` mede exclusividade no corpus inteiro — desenhado para
 * achar molde de template repetido sem relação com o tema. Base legal
 * transcrita é outra coisa: quando duas skills IRMÃS do mesmo tema citam o
 * mesmo dispositivo (ex.: duas skills de mandado de segurança coletivo
 * citando a CF art. 5º LXIX), a linha aparece nas duas e nenhuma conta como
 * "própria" — mas ambas têm conteúdo real, verificado contra fonte aberta.
 *
 * Este sinal é independente: exige o marcador do bloco, pelo menos uma
 * transcrição em blockquote e a lista de fontes abertas. Um heading solto
 * sem o resto não conta — evita que qualquer um escreva "## Base legal" para
 * escapar do sinal de vazio.
 */
export function contemBaseLegalVerificada(texto) {
  const conteudo = String(texto || '');
  if (!conteudo.includes(MARCADOR_BASE_LEGAL)) return false;
  const apos = conteudo.slice(conteudo.indexOf(MARCADOR_BASE_LEGAL));
  return /^>\s+\S/m.test(apos) && /\*\*Fontes abertas:\*\*/.test(apos) && /`https?:\/\//.test(apos);
}

/**
 * Bloco markdown com a base legal, ou `''` quando não há casamento forte.
 */
export function montarBaseLegal(tema, corpus, opcoes = {}) {
  const achados = selecionarDispositivos(tema, corpus, opcoes);
  if (!achados.length) return '';

  const porSigla = new Map(corpus.map((a) => [a.sigla, a.url]));
  const fontesCitadas = new Set();
  for (const artigo of achados) {
    for (const sigla of siglasCitadasNoTexto(artigo.texto)) {
      if (porSigla.has(sigla)) fontesCitadas.add(porSigla.get(sigla));
    }
  }
  const fontes = [...new Set([...achados.map((a) => a.url), ...fontesCitadas])];
  const linhas = [
    MARCADOR_BASE_LEGAL,
    '',
    'Transcrição **literal** da fonte oficial, selecionada por correspondência de',
    'tema. É **ponto de partida, não rol exaustivo**: confirme que o dispositivo',
    'rege o caso concreto antes de fundamentar nele, e abra a norma para os',
    'parágrafos e incisos que não couberam aqui.',
    '',
  ];

  for (const artigo of achados) {
    const texto = marcarRemissoesNaoAbertas(trecho(artigo.texto));
    linhas.push(`### ${artigo.sigla} — Art. ${artigo.numero}`, '', '> ' + texto.split('\n').join('\n> '), '');
  }

  linhas.push('**Fontes abertas:**', '');
  for (const url of fontes) linhas.push(`- \`${url}\``);
  linhas.push('');
  return linhas.join('\n');
}
