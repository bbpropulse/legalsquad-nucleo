// Separa MOLDE de MATÉRIA num corpus de skills.
//
// ## O problema que isto resolve
//
// Medido no corpus de produção: uma skill de direito-civil com 223 linhas
// carrega 5 linhas de matéria; uma eleitoral com 505 carrega 56. O resto é
// protocolo — o mesmo texto repetido em centenas de arquivos. Isso custa em
// três frentes: infla o pacote, faz a busca ranquear por molde em vez de por
// matéria, e — o pior — **esconde a lacuna**: um arquivo de 500 linhas parece
// conhecimento até alguém ler.
//
// A separação é a forma do sistema: **skill é matéria, best-practice é
// protocolo**. Extrair não cria conteúdo; torna visível quanto existe.
//
// ## Por que o corte é ABSOLUTO e não proporcional
//
// Um corte proporcional ("aparece em ≥90% das skills") só enxerga molde
// global. Medido: em `direito-civil` ele acha 22 linhas; em `eleitoral`, 387.
// Não é que civil tenha mais matéria — é que o molde de civil é **por
// família**: 528 linhas distintas aparecem em >100 skills cada e ocupam 66,8%
// do corpus, sem nunca chegar a 90%.
//
// Uma linha repetida literalmente em 21 skills diferentes não carrega matéria
// de nenhuma delas. O critério é esse, e independe do tamanho da área.
//
// ## O que NUNCA sai
//
// Frontmatter (é contrato, não prosa — removê-lo quebra o carregamento), o
// primeiro H1 (é a identidade da skill) e qualquer heading cuja seção ainda
// tenha conteúdo próprio (senão o texto sobrevivente fica órfão).

import { normalizarTema } from './skill-originality.js';

/**
 * Em quantas skills distintas uma linha precisa aparecer para ser molde.
 *
 * 21 é conservador: erra para "é matéria". Errar ao contrário apagaria
 * conteúdo real de um grupo pequeno de skills irmãs — e o motor não tem como
 * recuperar o que foi removido do arquivo publicado.
 */
export const CORTE_MOLDE_PADRAO = 21;

const MARCA_REMISSAO = '> **Protocolo operacional:**';

function exigirCorte(corte) {
  if (!Number.isInteger(corte) || corte < 2) {
    throw new Error(
      `corte de molde inválido: ${JSON.stringify(corte)} — precisa ser inteiro >= 2`
    );
  }
  return corte;
}

function normalizarSkill(skill) {
  return normalizarTema(skill.texto, { id: skill.id, titulo: skill.titulo });
}

/**
 * Linhas que se repetem por todo o corpus, medidas sobre o texto com o tema
 * normalizado — sem isso, "Prazo de <TEMA>" e "Prazo de outro tema" contariam
 * como duas linhas próprias quando são a mesma frase de molde.
 *
 * @param {{id: string, titulo: string, texto: string}[]} corpus
 * @param {{corte?: number}} opcoes
 * @returns {Set<string>} linhas normalizadas e aparadas
 */
export function identificarMolde(corpus, opcoes = {}) {
  const corte = exigirCorte(opcoes.corte ?? CORTE_MOLDE_PADRAO);

  const frequencia = new Map();
  for (const skill of corpus) {
    // `Set` por skill: uma linha repetida 10× DENTRO do mesmo arquivo conta
    // uma vez. O critério é "quantas skills usam", não "quantas vezes ocorre".
    const distintas = new Set(
      normalizarSkill(skill)
        .split('\n')
        .map((linha) => linha.trim())
        .filter(Boolean)
    );
    for (const linha of distintas) frequencia.set(linha, (frequencia.get(linha) || 0) + 1);
  }

  const molde = new Set();
  for (const [linha, n] of frequencia) if (n >= corte) molde.add(linha);
  return molde;
}

/**
 * Reúne o protocolo que sai das skills, na ordem de leitura do corpus.
 *
 * **Tem de conter TODA linha de molde.** A primeira versão varria só a skill
 * mais longa, presumindo que ela contivesse o protocolo inteiro — e no lote
 * médico isso preservou 30 de 858 linhas. O que é removido de 752 arquivos e
 * não entra na best-practice simplesmente deixa de existir no sistema, sem
 * nenhum erro: extrair vira apagar.
 *
 * @param {{id: string, titulo: string, texto: string}[]} corpus
 * @param {Set<string>} linhasDeMolde saída de `identificarMolde`
 */
export function montarProtocolo(corpus, linhasDeMolde) {
  const vistas = new Set();
  const protocolo = [];

  // Ordem de leitura: primeira aparição no corpus. Preserva a sequência que o
  // autor deu ao fluxo, em vez de embaralhar por frequência.
  for (const skill of corpus) {
    const originais = skill.texto.split('\n');
    const normalizadas = normalizarSkill(skill).split('\n');
    originais.forEach((linha, i) => {
      const chave = normalizadas[i]?.trim();
      if (!chave || vistas.has(chave) || !linhasDeMolde.has(chave)) return;
      vistas.add(chave);
      // Grava a forma NORMALIZADA: a linha é genérica por definição, e a
      // original traria o tema de uma skill arbitrária para dentro do
      // protocolo comum.
      protocolo.push(normalizadas[i].trimEnd());
    });
  }

  if (vistas.size !== linhasDeMolde.size) {
    // Invariante do próprio módulo: toda linha removida das skills está aqui.
    // Falhar alto é melhor que publicar um pacote com protocolo incompleto —
    // depois de assinado e distribuído, o conserto custa re-assinar tudo.
    throw new Error(
      `protocolo incompleto: ${vistas.size} de ${linhasDeMolde.size} linhas de molde`
    );
  }
  return protocolo.join('\n');
}

function limiteDoFrontmatter(linhas) {
  if (linhas[0]?.trim() !== '---') return -1;
  for (let i = 1; i < linhas.length; i++) if (linhas[i].trim() === '---') return i;
  // Abertura sem fechamento: trata como se não houvesse frontmatter em vez de
  // engolir o arquivo inteiro como cabeçalho.
  return -1;
}

/**
 * Corta um `SKILL.md` em `{materia, molde}`.
 *
 * A comparação é feita sobre o texto NORMALIZADO, mas o que é preservado é a
 * linha ORIGINAL do mesmo índice — a matéria sai byte a byte como estava.
 * `normalizarTema` só substitui trechos dentro da linha, nunca insere ou
 * remove quebras, e há teste prendendo essa invariante.
 *
 * @param {string} texto
 * @param {{id: string, titulo: string, linhasDeMolde: Set<string>, remissao?: string}} contexto
 */
export function separarMolde(texto, contexto) {
  const { id, titulo, linhasDeMolde, remissao } = contexto;
  const originais = String(texto).split('\n');
  const normalizadas = normalizarTema(String(texto), { id, titulo }).split('\n');

  const fim = limiteDoFrontmatter(originais);
  const cabecalho = fim >= 0 ? originais.slice(0, fim + 1) : [];
  const inicioCorpo = fim >= 0 ? fim + 1 : 0;

  const ehMolde = (i) => {
    const chave = normalizadas[i]?.trim();
    return Boolean(chave) && linhasDeMolde.has(chave);
  };
  const ehHeading = (linha) => /^#{1,6}\s/.test(linha);

  // Fatia o corpo em seções: cada heading abre uma; o texto antes do primeiro
  // heading forma uma seção sem título.
  const secoes = [{ heading: null, headingIndex: -1, corpo: [] }];
  for (let i = inicioCorpo; i < originais.length; i++) {
    if (ehHeading(originais[i])) secoes.push({ heading: originais[i], headingIndex: i, corpo: [] });
    else secoes[secoes.length - 1].corpo.push(i);
  }

  const primeiroH1 = secoes.find((s) => s.heading && /^#\s/.test(s.heading));

  const materia = [...cabecalho];
  const molde = [];
  for (const secao of secoes) {
    const preservadas = secao.corpo.filter((i) => originais[i].trim() && !ehMolde(i));
    const removidas = secao.corpo.filter((i) => originais[i].trim() && ehMolde(i));

    // O heading fica se a seção ainda tem o que dizer — ou se é o H1, que
    // identifica a skill mesmo quando todo o corpo dela saiu.
    const mantemHeading = Boolean(secao.heading) && (preservadas.length > 0 || secao === primeiroH1);

    if (secao.heading) {
      if (mantemHeading) {
        materia.push('', secao.heading);
        if (secao === primeiroH1 && remissao) materia.push('', `${MARCA_REMISSAO} ${remissao}`);
      } else if (ehMolde(secao.headingIndex)) {
        molde.push(secao.heading);
      }
    }

    for (const i of secao.corpo) {
      if (!originais[i].trim()) continue;
      if (ehMolde(i)) {
        if (!mantemHeading || removidas.length) molde.push(originais[i]);
      } else if (mantemHeading || !secao.heading) {
        materia.push(originais[i]);
      }
    }
    if (mantemHeading && preservadas.length) materia.push('');
  }

  return {
    materia: `${materia.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
    molde: molde.join('\n'),
    linhasPreservadas: materia.length - cabecalho.length,
    linhasRemovidas: molde.length,
  };
}
