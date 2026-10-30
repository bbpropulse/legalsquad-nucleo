// Mede quanto de um corpus de skills é conteúdo PRÓPRIO e quanto é o mesmo
// esqueleto com o tema trocado.
//
// Por que isto é mecanismo de motor e não matéria de área: um lote gerado por
// template passa em `check-skills` e em `audit-skills` — o contrato está lá, o
// frontmatter está completo, os gates estão escritos. O que nenhum desses
// gates enxerga é se as 1000 skills dizem a MESMA coisa. Isso é medível sem
// conhecer nenhuma área do Direito, e é o que este módulo faz.
//
// Duas decisões de método:
//
// 1. **Normalizar o tema.** Sem isso, duas skills idênticas exceto pelo
//    assunto pareceriam distintas em cada linha que cita o próprio nome — e o
//    gerador-de-lote passaria por autor.
// 2. **Frequência de linha, não comparação par a par.** O(n) em vez de O(n²):
//    5000 skills medem em segundos, e o resultado diz mais — não só "são
//    parecidas", mas exatamente QUAIS linhas são o molde.

/** Remove acento e caixa para comparar variantes que o gerador produz. */
function achatar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function escaparRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Abaixo disto o "tema" não identifica a skill — identifica sílaba. */
const TAMANHO_MINIMO_DE_TEMA = 4;

/**
 * Troca toda menção ao tema da própria skill por `<TEMA>` — o slug, o título,
 * e as variantes de caixa/acento que o gerador espalha pelo corpo.
 */
export function normalizarTema(texto, { id, titulo }) {
  const alvos = [
    titulo,
    id,
    String(id || '').replace(/-/g, ' '),
  ].filter(Boolean).map(achatar)
    // Tema curto demais não identifica nada e destrói o texto: um id "a"
    // transformaria toda letra "a" do corpo em <TEMA>, e a medição passaria a
    // reportar originalidade zero por artefato do medidor, não do conteúdo.
    .filter((alvo) => alvo.length >= TAMANHO_MINIMO_DE_TEMA);

  // Do mais longo para o mais curto: senão o slug curto consome um pedaço do
  // título longo e sobra lixo no lugar.
  const unicos = [...new Set(alvos)].sort((a, b) => b.length - a.length);
  if (!unicos.length) return texto;

  // Limite de palavra dos dois lados: "prazo" não pode casar dentro de
  // "prazos", senão o plural vira `<TEMA>s` e a linha deixa de bater com a
  // mesma linha de outra skill — inflando originalidade falsa.
  const padrao = new RegExp(`(?<![\\p{L}\\p{N}])(?:${unicos.map(escaparRegex).join('|')})(?![\\p{L}\\p{N}])`, 'gu');

  // Compara na versão achatada mas devolve fatias do texto ORIGINAL, para não
  // destruir acentuação do resto da linha na medição.
  const achatado = achatar(texto);
  let resultado = '';
  let cursor = 0;
  for (const casamento of achatado.matchAll(padrao)) {
    resultado += texto.slice(cursor, casamento.index) + '<TEMA>';
    cursor = casamento.index + casamento[0].length;
  }
  return resultado + texto.slice(cursor);
}

/** Linhas com conteúdo, sem duplicata interna — repetir dentro da própria skill não é volume. */
function linhasDe(texto) {
  return [...new Set(
    String(texto || '')
      .split('\n')
      .map((linha) => linha.trim())
      .filter(Boolean)
  )];
}

function mediana(numeros) {
  if (!numeros.length) return 0;
  const ordenado = [...numeros].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 ? ordenado[meio] : (ordenado[meio - 1] + ordenado[meio]) / 2;
}

/**
 * @param corpus `[{ id, titulo, texto }]`
 * @returns `{ resumo, skills[], boilerplate[] }`
 *
 * `originalidade` de uma skill = fração das suas linhas que NÃO aparecem em
 * nenhuma outra. É a pergunta que interessa: se eu apagasse esta skill, quanto
 * de conteúdo o corpus perderia de fato?
 */
export function medirOriginalidade(corpus, opcoes = {}) {
  const limiteBoilerplate = opcoes.limiteBoilerplate ?? 20;

  const porSkill = corpus.map((skill) => ({
    id: skill.id,
    titulo: skill.titulo,
    linhas: linhasDe(normalizarTema(skill.texto, { id: skill.id, titulo: skill.titulo })),
  }));

  // Em quantas skills DISTINTAS cada linha aparece.
  const frequencia = new Map();
  for (const skill of porSkill) {
    for (const linha of skill.linhas) {
      frequencia.set(linha, (frequencia.get(linha) || 0) + 1);
    }
  }

  const skills = porSkill.map((skill) => {
    const exclusivas = skill.linhas.filter((linha) => frequencia.get(linha) === 1).length;
    const total = skill.linhas.length;
    return {
      id: skill.id,
      titulo: skill.titulo,
      totalLinhas: total,
      linhasExclusivas: exclusivas,
      originalidade: total ? exclusivas / total : 0,
    };
  });

  const boilerplate = [...frequencia.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limiteBoilerplate)
    .map(([linha, n]) => ({ linha, skills: n }));

  const originalidades = skills.map((s) => s.originalidade);
  const totalLinhasCorpus = skills.reduce((soma, s) => soma + s.totalLinhas, 0);
  const totalExclusivas = skills.reduce((soma, s) => soma + s.linhasExclusivas, 0);

  return {
    resumo: {
      totalSkills: skills.length,
      medianaOriginalidade: mediana(originalidades),
      mediaOriginalidade: originalidades.length
        ? originalidades.reduce((a, b) => a + b, 0) / originalidades.length
        : 0,
      // Linhas distintas no corpus inteiro: o tamanho real do conteúdo, sem a
      // multiplicação do molde.
      linhasDistintasNoCorpus: frequencia.size,
      totalLinhasSomadas: totalLinhasCorpus,
      totalLinhasExclusivas: totalExclusivas,
    },
    skills,
    boilerplate,
  };
}
