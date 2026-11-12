// Escopo dos leitores da fase zero, escrito pelo código.
//
// Run real de 16/10/2026 (memoriais cíveis, 237 folhas, 99 imagens): com o sumário do caso em dia,
// o leitor de autos levou 51 minutos (46 Bash, 11 Read, 7,8 M tokens lidos) e o leitor de prova 31
// (5,4 M), contra 1,5 a 3,2 minutos dos outros leitores. Os dois releram o processo: o step mandava
// "conferir no documento.md cada folha que for citar: o sumário orienta a leitura, não a
// substitui", e o despacho improvisado do runner disse "confirme toda folha citada lá".
//
// Com o sumário em dia, ele é o mapa: o leitor confere no documento.md só a folha que o artefato
// dele vai citar, aberta pelo marcador da folha (`sumario-autos folha`), com um teto de chamadas de
// ferramenta pelo ritmo do run; no teto, grava com o que tem e lista o que ficou sem conferir. Sem
// sumário em dia, vale o caminho de antes.
//
// O mesmo texto vai no step compilado (as três faixas do teto, que o runner fixa no despacho) e no
// `step` do squad-state (o teto do ritmo deste run). A lógica vive no bloco abaixo, copiada VERBATIM
// para `scripts/squad-state.mjs` e `templates/scripts/squad-state.mjs` (guardado por `sync-blocos`).

// >>> escopo-leitura:begin
/**
 * Teto de chamadas de ferramenta de cada leitor da fase zero com o sumário em dia, pelo ritmo do
 * run (decisão do dono, 20/10/2026). Os leitores rápidos do run de 16/10 fecharam em 1,5 a 3,2
 * minutos; o leitor de autos, que releu o processo, fez 57 chamadas (46 Bash e 11 Read), e é essa
 * releitura que o teto corta.
 */
const TETO_DE_CHAMADAS_DA_LEITURA = { rapido: 15, equilibrado: 25, completo: 40 };
const ROTULO_DO_TETO_DA_LEITURA = { rapido: 'Rápido', equilibrado: 'Equilibrado', completo: 'Rigoroso' };

/** O teto de chamadas de um leitor da fase zero no ritmo dado (nome canônico); sem ritmo, o do Rigoroso. */
function tetoDeChamadasDaLeitura(ritmo) {
  return TETO_DE_CHAMADAS_DA_LEITURA[ritmo] ?? TETO_DE_CHAMADAS_DA_LEITURA.completo;
}

/**
 * O escopo da leitura de um leitor da fase zero, a frase que o step compilado grava e que o runner
 * passa literal no despacho. `teto` é o número do ritmo do run (no despacho); sem ele, o texto traz
 * as três faixas (no step compilado). `docsDoCliente`: a pasta sem processo, citada por Doc. e página.
 */
function escopoDaLeitura({ code, docsDoCliente = false, teto = null } = {}) {
  const folha = docsDoCliente ? 'página' : 'folha';
  const folhas = docsDoCliente ? 'páginas' : 'folhas';
  const comando = `node scripts/sumario-autos.mjs folha squads/${code} ${docsDoCliente ? '--doc <arquivo do Doc.> ' : ''}--fls N [--ate M]`;
  const faixas = Object.entries(TETO_DE_CHAMADAS_DA_LEITURA).reverse().map(([r, n]) => `${ROTULO_DO_TETO_DA_LEITURA[r]} ${n}`).join(', ');
  const limite = Number.isInteger(teto)
    ? `${teto} chamadas de ferramenta (o teto do ritmo deste run)`
    : `chamadas de ferramenta pelo ritmo do run (${faixas}; o runner passa o número no despacho)`;
  return `Escopo da leitura com o sumário em dia (\`node scripts/sumario-autos.mjs status squads/${code}\` com \`em_dia: true\`): o sumário é o mapa; no \`documento.md\` se confere só a ${folha} que este artefato vai CITAR, aberta pelo marcador \`## fls. N\`${docsDoCliente ? ' (a página N do Doc.)' : ''} com \`${comando}\` (ou Grep do marcador com contexto, ou a leitura só daquele trecho), nunca o documento inteiro. Teto: ${limite}; no teto, gravar com o que tem e listar, na seção \`## Sem conferir\` do artefato, as ${folhas} citadas que ficaram sem conferência no \`documento.md\`. Sem sumário em dia, o caminho de sempre: cada ${folha} que for citar, conferida no \`documento.md\`.`;
}
// <<< escopo-leitura:end

export { TETO_DE_CHAMADAS_DA_LEITURA, ROTULO_DO_TETO_DA_LEITURA, tetoDeChamadasDaLeitura, escopoDaLeitura };
