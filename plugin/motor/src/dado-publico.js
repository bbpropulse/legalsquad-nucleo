// Dado público × dado do caso: uma regra só, lida pelos gates que cobram marcador de dado.
//
// Medido no m2b da 0.9.81 (due diligence repetida): o revisor exigiu como fix `alta` marcar com
// [CONFIRMAR] o salário mínimo de 2022 a 2024 (a fonte não fora reaberta no run), e a Verificação da
// Meta, por código, reclassificou o mesmo marcador como falta da peça ("tabela oficial é dado
// público"). O redator obedeceu um gate e foi reprovado pelo outro. Daqui em diante a regra é esta,
// e os dois a usam: a meta (`meta-consenso`, que classifica a falta), o laço de revisão
// (`review-verdict`, que confere o fix antes de ele ir ao redator), o contrato de redação e o
// despacho do avaliador (que a dizem por escrito).
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM pelo `scripts/sync-blocos.mjs` para o
// `squad-state` (raiz e templates), antes do bloco `meta-consenso`, que o usa ao carregar, e para o
// hook `verifica-redacao.mjs` (raiz, .codex e templates), onde o contrato de redação o lê.

// >>> dado-publico:begin
/**
 * O que é dado público, lido sem acento e em minúsculas: o run o obtém na fonte oficial e a peça o
 * escreve com a fonte. Não é pendência do profissional nem dado do caso.
 */
const DADO_PUBLICO = [
  { tipo: 'indice-oficial', padrao: /\b(?:ipca(?:-e)?|inpc|igp-?m|igp-?di|ipc-?fipe|selic|taxa referencial|indices?(?! (?:cadastra\w*|remissivo\w*|de massa\b))|correcao|correcoes|atualizacao monetaria|juros)\b/, motivo: 'índice oficial, correção e juros são dado público: a peça obtém a série e aplica' },
  { tipo: 'orgao-publico', padrao: /\b(?:orgaos? de representacao|representacao judicial|procuradori\w*|advocacia[ -]geral|defensoria publica|agu|pgfn|pge|pgm)\b/, motivo: 'o órgão de representação de ente público é dado público: a peça o nomeia' },
  { tipo: 'norma-ou-tabela', padrao: /\b(?:lei|leis|decreto|decretos|resolucao|portaria|instrucao normativa|provimentos?|tabelas?|salarios? minimos?|teto)\b/, motivo: 'lei, norma e tabela oficial (o salário mínimo de qualquer época) são dado público' },
];

/** A regra, por escrito, para o redator, o revisor e o avaliador. */
const REGRA_DO_DADO_PUBLICO = 'Dado público (índice oficial e a série dele, salário mínimo de qualquer época, tabela e norma oficiais, órgão de representação de ente público) não é pendência do profissional: o run o obtém na fonte oficial (`node scripts/fonte-oficial.mjs`) e a peça o escreve com a fonte. Marcador de dado ([CONFIRMAR], [PREENCHER]) em dado público só quando a fonte oficial foi tentada no run e falhou (`acesso_falhou` no `fontes/INDEX.jsonl`), com o marcador listado no manifesto; quem decide a exceção é o INDEX, não a redação da diligência; nenhum gate pede marcador para o dado que a fonte dá';

const semAcentoDoDadoPublico = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** O dado público de que o texto fala (`{ tipo, motivo }`), ou null. */
function dadoPublicoDe(texto) {
  const t = semAcentoDoDadoPublico(texto).replace(/\[[^\]]*\]/g, ' ');
  const achado = DADO_PUBLICO.find((p) => p.padrao.test(t));
  return achado ? { tipo: achado.tipo, motivo: achado.motivo } : null;
}

/** O fix que pede marcador de dado (ou "a confirmar") num dado público: `{ tipo, motivo }`, ou null. */
const PEDE_MARCADOR_DE_DADO = /\[(?:A[ _])?(?:CONFIRMAR|PREENCHER)\b|\b(?:marc\w+|sinaliz\w+|deix\w+)\b[^.;]{0,60}\b(?:a confirmar|a preencher|com (?:o )?marcador)\b/i;
function fixPedeMarcadorEmDadoPublico(fix) {
  const texto = String(fix ?? '');
  if (!PEDE_MARCADOR_DE_DADO.test(texto)) return null;
  return dadoPublicoDe(texto);
}
// <<< dado-publico:end

export { DADO_PUBLICO, REGRA_DO_DADO_PUBLICO, dadoPublicoDe, fixPedeMarcadorEmDadoPublico };
