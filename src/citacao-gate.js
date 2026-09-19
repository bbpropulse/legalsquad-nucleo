// Gate mecânico de citação: extrai as citações de um texto e classifica cada
// uma contra fonte verificável, antes de qualquer humano ler.
//
// ## Por que precisa ser mecânico
//
// O piloto de enriquecimento passou por revisão adversarial de três lentes
// independentes. Elas pegaram — depois. Antes disso o texto já existia, com
// `Res. 23.609, art. 2º, § 4º` transcrito literalmente (parágrafo inexistente)
// e um acórdão de 1986 sustentando tese central sem confirmação. Revisão por
// LLM é boa e cara; o que ela não pode ser é a PRIMEIRA barreira, porque falha
// de forma correlacionada com quem escreveu.
//
// Este módulo não julga se a tese está certa. Responde uma pergunta estreita e
// verificável: **esta citação resolve contra alguma fonte, e qual?**
//
// ## Fail-closed, com a distinção que o projeto exige
//
// "Não encontrei no acervo" e "não tenho acervo" são coisas diferentes, e
// confundi-las faz o autor remover citação boa. Os estados são separados de
// propósito — nenhum deles é `VERIFICADA`.

const MARCA_NAO_VERIFICADO = /\[NÃO VERIFICADO\]/i;

// "(Vide ADIN 2332)", "(Vide ADI 6096)" — remissão que o próprio texto
// consolidado traz dentro do dispositivo, não citação de quem escreveu.
const NOTA_EDITORIAL = /\(\s*Vide\s$/i;

const PADROES = [
  {
    tipo: 'sumula',
    // "Súmula 49 do TSE", "Súmula Vinculante 11", "Súmula 7/STJ"
    regex: /S[úu]mula(?:\s+Vinculante)?\s+n?[º°]?\s*(\d+)(?:\s*(?:do|da|\/)\s*([A-Z]{2,5}))?/gi,
    campos: (m) => ({ numero: m[1], orgao: (m[2] || '').toUpperCase() }),
  },
  {
    tipo: 'lei',
    // "LC 64/90, art. 3º", "Lei 9.504/1997 art. 41", "CF art. 5º", "CPC, art. 300"
    //
    // Duas guardas, ambas nascidas de falso positivo medido no corpus inteiro:
    //
    // `(?![\p{L}])` — a sigla precisa de fronteira à DIREITA. Sem ela, "CE"
    // casava dentro de "CESSAÇÃO" e o título "CESSAÇÃO – ALCANCE DO ARTIGO 11"
    // virava uma citação ao art. 11 do Código Eleitoral.
    //
    // Número obrigatório no ramo `Lei`/`LC` — "lei" é substantivo comum, e
    // "...previsto em lei. Inteligência do art. 96" virava "Lei ., art. 96".
    // Sigla de código dispensa número porque `CF`/`CPC` já identificam o
    // diploma sozinhas.
    regex: /\b(?:(LC|Lei\s+Complementar|Lei)(?![\p{L}])\s*n?[º°]?\s*(\d[\d.]*(?:\/\d{2,4})?)|(CF|CPC|CPP|CLT|CDC|CTN|CP|CC|CE)(?![\p{L}]))[^\n.;]{0,20}?art(?:igo)?\.?\s*(\d+)/giu,
    campos: (m) => ({ diploma: (m[1] || m[3]).toUpperCase(), numeroLei: m[2] || '', artigo: m[4] }),
  },
  {
    tipo: 'acordao',
    // "REspe nº 6373", "AgR-REspEI nº 060020820", "RE 190.364", "MS 17.526-DF"
    //
    // O número para em dígitos/pontos e a UF é capturada à parte, atrás de
    // HÍFEN OU BARRA. Antes o hífen entrava no número: `MS 17.526-DF` virava
    // `MS 17.526-`, o "DF" ficava de fora e `17526` não casava com o path do
    // acervo (`ms-17-526-df`) — 182 skills receberam NAO_ENCONTRADA para
    // citação que existia, que é o erro mais caro do gate: leva a remover
    // fundamentação correta.
    //
    // Numeração eleitoral do TSE tem uma forma a mais: "classe-sequencial/UF"
    // — ex. `REspe 1323-32/GO`, dois grupos numéricos separados por hífen,
    // terminados por barra+UF. O hífen do meio só é "parte do número" quando
    // seguido de DÍGITO (lookahead); seguido de LETRA maiúscula, continua
    // sendo o separador da UF do caso original.
    regex: /\b((?:AgR-)?(?:REspe?(?:EI)?|RE|HC|MS|ADI|ADPF|RHC|AREsp|EDcl)[A-Za-z-]*)\s+n?[º°]?\s*([\d](?:[\d.]|-(?=\d)){3,})(?:[-/]([A-Z]{2}))?/g,
    campos: (m) => ({ classe: m[1].toUpperCase(), numero: m[2].replace(/\D/g, ''), uf: m[3] || '' }),
  },
];

function linhaDe(texto, indice) {
  return texto.slice(0, indice).split('\n').length - 1;
}

/**
 * @param {string} texto
 * @returns {{tipo: string, bruto: string, linha: number}[]} sem as já marcadas
 *   `[NÃO VERIFICADO]` — quem declarou a incerteza cumpriu o contrato, e
 *   re-listá-la afogaria o relatório justamente nas que se dizem certas.
 */
// A seção onde o autor declara o que abriu — e, por contrato, **o que não
// conseguiu abrir**. Citação que aparece ali não é fundamentação: é o nome da
// lacuna.
//
// Falso positivo medido: cinco skills reprovadas por "Súmula 347/STF" numa
// linha que dizia "busquei por texto e por número no acervo; não há documento
// que a enuncie". Reprovar quem nomeia a própria lacuna ensina a silenciá-la
// para passar no gate — exatamente o contrário do que este projeto quer.
//
// A seção continua sendo lida para `fontesAbertas` (regex separada, sobre o
// texto inteiro): é dali que sai a URL que LIBERA a citação do corpo.
const SECAO_DE_FONTES = /^##+\s+(?:Fontes\b|Lacunas\b|O que n[ãa]o\b)/i;
const SECAO_QUALQUER = /^##+\s+/;

export function extrairCitacoes(texto) {
  const conteudo = String(texto || '');
  const linhas = conteudo.split('\n');
  const encontradas = [];

  // Quais linhas caem dentro de uma seção de fontes/lacunas.
  const emSecaoDeFontes = new Set();
  let dentro = false;
  for (const [i, linha] of linhas.entries()) {
    if (SECAO_QUALQUER.test(linha)) dentro = SECAO_DE_FONTES.test(linha);
    if (dentro) emSecaoDeFontes.add(i);
  }

  for (const padrao of PADROES) {
    for (const m of conteudo.matchAll(padrao.regex)) {
      const linha = linhaDe(conteudo, m.index);
      if (emSecaoDeFontes.has(linha)) continue;
      if (MARCA_NAO_VERIFICADO.test(linhas[linha] || '')) continue;
      // Nota editorial DO PLANALTO dentro do dispositivo transcrito — o texto
      // consolidado insere "(Vide ADIN 6096)" no corpo do art. 103 da Lei
      // 8.213. Quem transcreve fielmente carrega a nota junto; tratá-la como
      // citação do autor reprova transcrição correta e ensina a truncar a
      // fonte para passar no gate.
      if (NOTA_EDITORIAL.test(conteudo.slice(Math.max(0, m.index - 8), m.index))) continue;
      encontradas.push({ tipo: padrao.tipo, bruto: m[0].trim(), linha: linha + 1, ...padrao.campos(m) });
    }
  }

  return encontradas.sort((a, b) => a.linha - b.linha || a.bruto.localeCompare(b.bruto));
}

// "REspe" e "AgR-REspe" são a mesma família de recurso; o que não pode é um
// RO virar REspe. Reduzir à raiz mantém o casamento tolerante ao prefixo de
// agravo/embargos sem afrouxar a distinção entre classes diferentes.
function raizDaClasse(classe) {
  const bruta = String(classe || '').toUpperCase();
  const semPrefixo = bruta.replace(/^(AGR|EDCL|EMBDECL|AGRG)-?/i, '').replace(/EI$/i, '');
  // Quando a classe INTEIRA é um dos prefixos ("EDcl" sozinho, sem outra
  // classe-base depois), a remoção zera a string — e a checagem de classe
  // usa essa raiz numa regex; raiz vazia CASA EM QUALQUER LUGAR, então
  // "EDcl 9988" resolvia contra um acervo que só tinha "MS 9988". Sem sobra
  // não há prefixo real para descontar: mantém a classe como veio.
  return semPrefixo || bruta;
}

// Informativos antigos do TSE gravam a classe processual POR EXTENSO no
// tema/path, nunca a sigla — "recurso-especial-eleitoral-no-23-100-sp",
// nunca "respe-23100". Medido: 747 documentos no acervo só com a forma por
// extenso. A sigla e a forma escrita não têm nenhuma letra em comum o
// bastante pra "RESPE" ser substring de "recurso especial eleitoral" — sem
// reconhecer as duas formas, toda citação a esses 747 documentos batia no
// número (que já casava) e falhava só na classe, saindo NAO_ENCONTRADA para
// citação real.
//
// O MAPA em si (qual sigla corresponde a qual nome por extenso) não mora
// aqui: é vocabulário de nomenclatura processual, o mesmo motivo pelo qual
// `base-legal.js: termosDoTema` recebe `sinonimos`/`acoes` de fora em vez de
// embuti-los. Medido em campo: fixar esse mapa no núcleo derruba
// `tests/fronteira.test.js` — o guard de `MATERIA` ali bloqueia, de
// propósito, o nome por extenso de um certo writ constitucional dentro deste
// diretório (ver o comentário no topo daquele arquivo de teste para o porquê;
// e `tools/sinonimos-classe-processual.mjs`, onde o mapa de fato mora, para o
// exemplo concreto). Reconhecer o FORMATO "sigla ou nome por extenso" é
// mecanismo; o par sigla↔nome de cada classe é dado de vocabulário, e vem de
// quem chama.

function semAcentoCitacao(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function casaClasseNoCampo(classe, campo, sinonimosPorExtenso) {
  const raiz = raizDaClasse(classe);
  if (new RegExp(`(?<![\\p{L}\\p{N}])${raiz}`, 'iu').test(campo)) return true;
  const porExtenso = sinonimosPorExtenso[raiz];
  if (!porExtenso) return false;
  // O `tema` grava a classe com espaço ("Recurso Especial. Investigação...");
  // o PATH grava o nome do arquivo com HÍFEN ("recurso-especial-eleitoral").
  // Medido no acervo real: o tema de um documento tinha um PONTO entre
  // "especial" e a palavra seguinte (não era "eleitoral" ali) — só o path
  // carregava a sequência certa, com hífen. Trocar hífen por espaço antes do
  // teste faz o sinônimo enxergar as duas formas.
  const semHifen = semAcentoCitacao(campo).replace(/-/g, ' ');
  return new RegExp(`(?<![\\p{L}\\p{N}])${porExtenso}(?![\\p{L}\\p{N}])`, 'iu').test(semHifen);
}

/**
 * A entrada é o documento DA súmula citada — não um vizinho que por acaso tem
 * o mesmo número em algum lugar.
 *
 * Falso positivo grave, medido contra 67.708 documentos: "Súmula 7 do STJ"
 * casava com um informativo administrativo cujo path continha "7" e "stj", e
 * "Súmula 347 do STF" casava com um acórdão cujo NÚMERO DE PROCESSO era 347 —
 * as duas saíam VERIFICADA apontando para documento que não enuncia súmula
 * nenhuma. Isso é pior que `NAO_ENCONTRADA`: "não encontrei" manda conferir,
 * "verificada" encerra a conferência.
 *
 * O que passa a ser exigido é que o número venha COLADO à palavra súmula —
 * `sumula-7`, `Súmula 7`, `Súmula Vinculante 7` — em vez de solto no texto.
 */
function ehDocumentoDaSumula(entrada, numero) {
  const campo = `${entrada.tema || ''} ${entrada.path || ''}`;
  if (new RegExp(`s[úu]mula[\\s-]*(?:vinculante[\\s-]*)?n?[º°]?[\\s-]*${numero}(?![\\p{L}\\p{N}])`, 'iu').test(campo)) {
    return true;
  }
  // Segunda porta, só sobre o NOME DO ARQUIVO: reconhece o padrão abreviado
  // `sv-<numero>` (Súmula Vinculante) que o próprio coletor usa. Não depende
  // de `tema` — que vem do H1 do arquivo e pode faltar se o H1 estiver
  // ausente, truncado, ou o índice for gerado antes da gravação terminar.
  // O nome do arquivo é o dado mais barato de manter correto, porque nasce
  // do coletor, não de extração de texto livre.
  const nomeArquivo = String(entrada.path || '').split('/').pop() || '';
  return new RegExp(`(?:^|[-_])sv[-_]${numero}(?![\\p{L}\\p{N}])`, 'iu').test(nomeArquivo);
}

function casaNoAcervo(citacao, acervo, sinonimosClasse) {
  // Súmula tem porta própria: o vínculo é com o documento que a enuncia, e o
  // órgão continua exigido para não entregar a Súmula 7 do TST como se fosse
  // a do STJ — enunciados diferentes, mesmo número.
  if (citacao.tipo === 'sumula') {
    const candidatos = acervo.filter((entrada) => {
      if (!ehDocumentoDaSumula(entrada, citacao.numero)) return false;
      if (!citacao.orgao) return true;
      const campo = `${entrada.tema || ''} ${entrada.path || ''}`;
      return new RegExp(`(?<![\\p{L}\\p{N}])${citacao.orgao}(?![\\p{L}\\p{N}])`, 'iu').test(campo);
    });
    if (!candidatos.length) return undefined;

    // Entre os candidatos, o documento CANÔNICO da súmula (tipo `sumula`, ou
    // caminho que se declara como tal) vence qualquer acórdão que apenas a
    // MENCIONE. Medido no acervo real: a Rcl 8150/STF tem no tema "... e
    // Ofensa à Súmula Vinculante 10" e vinha ANTES do arquivo
    // `sumulas/STF-VINCULANTE/stf-sv-10.md` no índice — sem esta prioridade,
    // `find` para no acórdão e a citação nunca alcança a fonte certa. É
    // sistemático, não caso de canto: qualquer súmula citada em ementa de
    // acórdão colide assim.
    const ehCanonico = (entrada) => entrada.tipo === 'sumula' || /(^|\/)sumulas?\//i.test(entrada.path || '');
    return candidatos.find(ehCanonico) || candidatos[0];
  }

  // Número sozinho não identifica decisão. Medido contra 64.459 documentos:
  // "REspe nº 6373" do TSE casou com um "RO 6373" do TST — outro tribunal,
  // outra classe, outra matéria — e saiu VERIFICADA. Carimbar citação
  // inventada como conferida é pior que não ter gate nenhum.
  const alvo = [citacao.numero, raizDaClasse(citacao.classe)];

  return acervo.find((entrada) => {
    const campo = `${entrada.tema || ''} ${entrada.path || ''}`;
    // O acervo grava o número do processo com separadores variáveis: o tema
    // traz "MS 17.526-DF" e o path traz "ms-17-526-df". Comparar só a forma
    // literal faria a citação certa não casar com o próprio documento dela.
    //
    // A normalização junta os GRUPOS DE DÍGITOS separados por ponto ou hífen
    // ("17-526" e "17.526" viram "17526") preservando a fronteira com letras —
    // remover os separadores de tudo grudaria "MS17526DF" e a borda de palavra
    // rejeitaria o próprio número que deveria casar.
    const campoSoDigitos = campo.replace(/(\d)[.-](?=\d)/g, '$1');
    return alvo.every((termo) => {
      // Número: borda dos DOIS lados — "49" casaria dentro de "1949".
      if (/^\d+$/.test(termo)) {
        const borda = new RegExp(`(?<![\\p{L}\\p{N}])${termo}(?![\\p{L}\\p{N}])`, 'iu');
        return borda.test(campo) || borda.test(campoSoDigitos);
      }
      // Classe: sigla (borda só à ESQUERDA — o acervo grava a classe completa
      // como "agr-respei", e exigir borda à direita rejeitaria o próprio
      // acórdão que a citação nomeia) OU a forma por extenso equivalente.
      return casaClasseNoCampo(termo, campo, sinonimosClasse);
    });
  });
}

/**
 * @param {ReturnType<extrairCitacoes>} citacoes
 * @param {{acervo: {path: string, tema: string}[] | null, fontesAbertas?: string[],
 *   sinonimosClasse?: Record<string, string>}} contexto `sinonimosClasse` mapeia a
 *   RAIZ da sigla (ver `raizDaClasse`) ao nome por extenso equivalente, em
 *   minúsculas e sem acento — ex. `{ RESPE: 'recurso especial eleitoral' }`.
 *   Vem de fora porque é vocabulário de nomenclatura processual, não
 *   mecanismo; ver o comentário acima de `casaClasseNoCampo`.
 */
export function classificarCitacoes(citacoes, contexto = {}) {
  const { acervo, fontesAbertas = [], sinonimosClasse = {} } = contexto;

  return citacoes.map((citacao) => {
    // Legislação é consultada online no Planalto, no ato da redação. O gate
    // não tem como resolvê-la contra o acervo — e carimbar VERIFICADA por
    // ausência de contraprova local seria exatamente o fail-open que este
    // módulo existe para impedir. Só a fonte declaradamente aberta libera.
    if (citacao.tipo === 'lei') {
      // Vale a URL oficial OU o caminho do acervo de legislação: aquele
      // acervo foi coletado do Planalto e cada arquivo guarda a fonte_url de
      // origem, então ler de lá é reproduzível — mais verificável, não menos.
      const fonte = fontesAbertas.find((url) => /planalto\.gov\.br/i.test(url) || /acervo\/legislacao\//i.test(url));
      return fonte
        ? { ...citacao, status: 'VERIFICADA', fonte }
        : { ...citacao, status: 'FONTE_NAO_DECLARADA', fonte: null };
    }

    // Precedente aberto no portal oficial do tribunal tem a mesma qualidade
    // de verificação que a lei aberta no Planalto. Exigir que ALÉM disso
    // esteja no acervo local de informativos rejeitaria tese de repercussão
    // geral — justamente a mais citável.
    if (citacao.tipo === 'acordao') {
      const oficial = fontesAbertas.find((url) => /(stf|stj|tse|tst)\.jus\.br/i.test(url));
      if (oficial) return { ...citacao, status: 'VERIFICADA', fonte: oficial };
    }

    if (!Array.isArray(acervo)) {
      return { ...citacao, status: 'ACERVO_AUSENTE', fonte: null };
    }

    const achado = casaNoAcervo(citacao, acervo, sinonimosClasse);
    return achado
      ? { ...citacao, status: 'VERIFICADA', fonte: achado.path }
      : { ...citacao, status: 'NAO_ENCONTRADA', fonte: null };
  });
}
