// Lei e jurisprudência vêm só do servidor de referência (0.9.115; plano de arquitetura da Legis,
// seções 1b, 2 e 3): o índice SQLite local acha, o servidor guarda o texto e o devolve conferido.
// Os pacotes de CONTEÚDO (`acervo.*`: legislação, súmulas, julgados, regionais) deixam de descer no
// `acervo sync` e de entrar na pesquisa, no pacote do verificador e no Citation Gate. Os pacotes de
// ÁREA (skills, squads, best-practices, agentes) continuam como sempre.
//
// A exceção é a CONTINGÊNCIA: pacote em que a medição da cobertura (revisoes/
// COBERTURA-ACERVO-SERVIDOR-20261106.md, 06/11/2026, índice 2026.11.22) achou mais de 2% faltando
// no servidor de algum tipo que a peça cita (súmula, tema, tese, OJ, lei federal). Esse pacote
// continua descendo no sync e ficando no depósito, marcado, para a decisão do dono; o run não o lê
// (a pesquisa e o gate vão ao servidor e, no que ele não resolve, à fonte oficial na web).
//
// Em projeto que já tinha os pacotes de conteúdo, os arquivos ficam no disco (nada do aluno é
// apagado); só deixam de ser ligados, indexados e lidos.
//
// Módulo PURO: sem I/O.

/** Pacotes de conteúdo mantidos no sync por cobertura insuficiente no servidor, com o motivo medido. */
export const PACOTES_DE_CONTINGENCIA = Object.freeze({
  'acervo.legislacao': 'artigos de lei federal: 3.423 de 101.811 (3,36%) sem o artigo no índice do servidor (Decreto 3.048/1999, LC 214/2025 e DL 301/1938 com o texto cortado no servidor; parte do resto é artigo de lei alteradora que o pacote separou)',
  'acervo.direito-empresarial': 'teses do STJ (Jurisprudência em Teses): 2 de 99 (2,02%) sem a edição 252 no servidor',
  'acervo.regional-tjgo': 'súmulas da Turma de Uniformização dos Juizados do TJGO: 8 de 8 sem o órgão no servidor',
  'acervo.regional-trt11': 'súmulas do TRT11: 1 de 27 (3,7%) sem a Súmula 26 no servidor',
});

/** Pacote de conteúdo (lei e jurisprudência): `acervo.*`. Os de área (`area.*`, `transversal`) não são. */
export function ehPacoteDeConteudo(packId) {
  return /^acervo\./.test(String(packId || ''));
}

/** O pacote é de contingência (fica no sync, marcado)? */
export function ehContingencia(packId) {
  return Object.prototype.hasOwnProperty.call(PACOTES_DE_CONTINGENCIA, String(packId || ''));
}

/** O conteúdo deste pacote vem do servidor de referência: o sync não o baixa, a ligação não o liga, a busca não o lê. */
export function conteudoVemDoServidor(packId) {
  return ehPacoteDeConteudo(packId) && !ehContingencia(packId);
}

/** A linha que o `acervo sync` e o `update` mostram, uma vez. */
export const LINHA_CONTEUDO_NO_SERVIDOR = 'lei e jurisprudência vêm do servidor de referência (índice desta máquina + texto conferido no servidor): os pacotes de conteúdo (acervo.*) não descem mais; os que já estavam aqui ficam no disco e não são usados';
