// Fatia a compilação oficial de súmulas de um tribunal em entradas por número.
//
// **Por que isto existe.** Toda leva de enriquecimento devolveu a mesma lacuna:
// "o acervo não tem diretório de súmulas". O efeito é concreto — as súmulas
// aparecem apenas *citadas dentro* de informativos, então o agente que quer
// fundamentar numa delas ou escreve o enunciado de memória (invenção) ou
// declara lacuna e deixa a tese sem a fonte mais citável que existe.
//
// O enunciado é a única parte que se cita em peça. Por isso ele é o campo
// obrigatório e é transcrito **literal**: as súmulas antigas do STJ estão em
// caixa alta e sem acento na fonte oficial, e "corrigir" a grafia
// transformaria transcrição em paráfrase apresentada como fonte.

// Abertura só no INÍCIO da linha e sozinha. O excerto de precedentes cita
// outras súmulas o tempo todo ("aplica-se a Súmula 7 desta Corte") — abrir
// entrada ali partiria a súmula ao meio e criaria uma duplicata sem enunciado.
// Sozinha na linha, com ou sem recuo: o PDF do STF centraliza o cabeçalho.
// Exigir a linha INTEIRA é o que descarta o índice de duas colunas do STF
// ("SÚMULA 1    13   SÚMULA 32    29"), que abriria centenas de entradas
// vazias e quebraria a numeração.
const ABERTURA = /^\s*S[ÚÚúu]MULA\s+(\d+)\s*$/i;

// Cabeçalhos da compilação, cada um sozinho na sua linha. A ordem aqui não
// importa: o corte é por qualquer um deles.
const CAMPOS = [
  ['enunciado', /^Enunciado$/],
  ['orgao', /^[ÓO]rg[ãa]o Julgador$/],
  // "Data da Decisão" (STJ) e "Data de Aprovação" (STF).
  ['data', /^Data d[ae] (?:Decis[ãa]o|Aprova[çc][ãa]o)$/],
  ['fonte', /^Fonte(?: de Publica[çc][ãa]o)?$/],
  ['referencias', /^Refer[êe]ncias? Legislativas?$/],
  ['precedentes', /^(?:Excerto dos Precedentes Origin[áa]rios|Precedentes)$/],
  ['situacao', /^Situa[çc][ãa]o$/],
  ['veja', /^(?:Veja|Observa[çc][ãa]o)$/],
];

function cabecalho(linha) {
  const achado = CAMPOS.find(([, regex]) => regex.test(linha.trim()));
  return achado ? achado[0] : null;
}

/**
 * @param {string} texto compilação inteira, já em texto puro
 * @returns {{numero: string, assunto: string, enunciado: string, orgao: string,
 *   data: string, fonte: string, referencias: string, precedentes: string}[]}
 * @throws quando uma entrada não tem enunciado — ver o comentário do topo.
 */
export function fatiarSumulas(texto) {
  const linhas = String(texto || '').split('\n');
  const blocos = [];
  let atual = null;

  for (const linha of linhas) {
    const abre = linha.match(ABERTURA);
    if (abre) {
      atual = { numero: abre[1], linhas: [] };
      blocos.push(atual);
      continue;
    }
    if (atual) atual.linhas.push(linha);
  }

  return blocos.map(({ numero, linhas: doBloco }) => {
    const campos = {};
    // Tudo que vem antes do primeiro cabeçalho é o assunto (a taxonomia do
    // tribunal: "DIREITO PROCESSUAL CIVIL - COMPETÊNCIA").
    let campoAtual = 'assunto';
    campos.assunto = [];

    for (const linha of doBloco) {
      const nome = cabecalho(linha);
      if (nome) {
        campoAtual = nome;
        campos[nome] = campos[nome] || [];
        continue;
      }
      (campos[campoAtual] = campos[campoAtual] || []).push(linha);
    }

    const junta = (nome) => (campos[nome] || []).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    // Duas compilações usam a mesma POSIÇÃO para coisas diferentes: o STJ põe
    // ali a taxonomia do tribunal e traz o cabeçalho "Enunciado" depois; o STF
    // não tem esse cabeçalho e põe o enunciado ali mesmo. Sem esta regra o STF
    // entraria no acervo com enunciado vazio — e enunciado é a única parte que
    // se cita em peça.
    const temCabecalhoDeEnunciado = Boolean(campos.enunciado);
    const enunciado = temCabecalhoDeEnunciado ? junta('enunciado') : junta('assunto');
    if (!enunciado) throw new Error(`Súmula ${numero}: bloco sem enunciado — a compilação mudou de formato`);

    return {
      numero,
      assunto: temCabecalhoDeEnunciado ? junta('assunto') : '',
      enunciado,
      orgao: junta('orgao'),
      data: junta('data'),
      fonte: junta('fonte'),
      referencias: junta('referencias'),
      precedentes: junta('precedentes'),
      situacao: junta('situacao'),
    };
  });
}
