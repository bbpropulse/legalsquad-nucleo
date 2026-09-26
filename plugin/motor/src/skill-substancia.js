// Substância de uma skill: quanto conteúdo PRÓPRIO ela carrega.
//
// O Arquiteto decide REUSAR ou CRIAR a partir da shortlist. Até aqui a
// shortlist dizia que a skill existe, é `active` e tem descrição impecável —
// e não dizia que o corpo está vazio. Combinado com a regra "nunca crie
// capacidade que já tenha skill", isso faz ele reusar casca e nunca criar
// nada: **quanto maior o catálogo oco, menos o Arquiteto produz.**
//
// ## Por que o sinal é ABSOLUTO e não razão
//
// Originalidade é razão (linhas próprias ÷ totais). Extrair o boilerplate
// para uma best-practice derruba o denominador e infla a razão sem escrever
// uma palavra — a mesma skill oca saltaria de 1,6% para ~14%. Sete linhas
// próprias são poucas tenha o arquivo 437 linhas ou 50.
//
// Por isso a decisão usa `linhas_proprias`. A razão continua publicada porque
// diz outra coisa útil (quanto do arquivo é molde), mas não decide.

/**
 * Abaixo disto a skill é título sem conteúdo: existe o nome, os gatilhos e a
 * descrição, mas o corpo não carrega conhecimento que justifique carregá-la.
 *
 * O número é conservador de propósito. Errar para "tem substância" só custa um
 * reuso morno; errar para "está oca" faria o Arquiteto recriar skill que já
 * presta — desperdício e duplicação no catálogo.
 */
export const LIMITE_TITULO_OCO = 25;

/**
 * A skill é só um título? `undefined`/`{}` devolve `false` de propósito:
 * índice antigo (gerado antes desta versão) não traz o campo, e **ausência de
 * medida não é medida de ausência** — tratar isso como "oco" faria o
 * Arquiteto recriar o catálogo inteiro do nada.
 */
/**
 * `linhas_proprias` mede exclusividade no corpus INTEIRO — desenhado para
 * achar molde de template. Não serve para julgar base legal transcrita:
 * quando skills irmãs do mesmo tema citam o mesmo dispositivo (legítimo, não
 * molde), a linha aparece em ambas e nenhuma conta como "própria". Por isso
 * `base_legal_verificada` é uma segunda porta, independente da primeira —
 * qualquer uma bastando para não ser título oco.
 */
export function ehTituloOco(substancia) {
  if (substancia?.baseLegalVerificada === true) return false;
  if (substancia?.precedentesIdentificados === true) return false;
  const proprias = substancia?.linhasProprias;
  if (!Number.isFinite(proprias)) return false;
  return proprias < LIMITE_TITULO_OCO;
}

/**
 * Lê `linhas_proprias`/`originalidade` de um `skills/_index.yaml` já em
 * memória. Parsing por regex sobre formato que nós mesmos geramos — mesma
 * escolha do resto do motor.
 *
 * Vem do índice, e não de medir na hora, porque medir 5523 skills custa ~16s:
 * caro demais para uma busca que precisa responder em milissegundos.
 */
export function lerSubstanciaDoIndice(indice) {
  const mapa = new Map();
  const texto = String(indice || '');
  if (!texto) return mapa;

  let atual = null;
  for (const linha of texto.split('\n')) {
    const nome = linha.match(/^ {2}- name:\s*(\S+)\s*$/);
    if (nome) {
      atual = nome[1];
      mapa.set(atual, { linhasProprias: undefined, originalidade: undefined, baseLegalVerificada: false, precedentesIdentificados: false });
      continue;
    }
    if (!atual) continue;

    const proprias = linha.match(/^ {4}linhas_proprias:\s*(\d+)\s*$/);
    if (proprias) {
      mapa.get(atual).linhasProprias = Number(proprias[1]);
      continue;
    }
    const originalidade = linha.match(/^ {4}originalidade:\s*([\d.]+)\s*$/);
    if (originalidade) {
      mapa.get(atual).originalidade = Number(originalidade[1]);
      continue;
    }
    const baseLegal = linha.match(/^ {4}base_legal_verificada:\s*true\s*$/);
    if (baseLegal) { mapa.get(atual).baseLegalVerificada = true; continue; }
    const precedentes = linha.match(/^ {4}precedentes_identificados:\s*true\s*$/);
    if (precedentes) mapa.get(atual).precedentesIdentificados = true;
  }

  // Entradas sem nenhuma medida são ruído de parsing, não skills.
  for (const [id, valores] of mapa) {
    if (valores.linhasProprias === undefined && valores.originalidade === undefined && !valores.baseLegalVerificada && !valores.precedentesIdentificados) mapa.delete(id);
  }
  return mapa;
}
