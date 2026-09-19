// Ranking de relevância da busca de skills. Módulo PURO: sem I/O, sem disco, sem
// rede — recebe documentos já extraídos e devolve a ordem. Isso é o que permite
// testá-lo com um corpus sintético em memória, sem fixture no disco.
//
// Um documento é o achatamento de `entry.metadata` de `discoverSkillCatalog`:
//   { id, description, group, positiveTriggers[], aliases[], categories[],
//     negativeTriggers[] }

const STOPWORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e',
  'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'que', 'um',
  'uma', 'the', 'to', 'of', 'and', 'for', 'with',
]);

export function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryTokens(query) {
  return [...new Set(normalize(query).split(' ')
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

function includesToken(text, token) {
  return text.split(' ').some((word) => word === token || word.startsWith(token));
}

/** Campos do documento, normalizados uma vez só. */
function campos(doc) {
  return {
    id: normalize(doc.id),
    description: normalize(doc.description),
    group: normalize(doc.group),
    positive: (doc.positiveTriggers || []).map(normalize),
    aliases: (doc.aliases || []).map(normalize),
    categories: (doc.categories || []).map(normalize),
    negative: (doc.negativeTriggers || []).map(normalize).filter(Boolean),
  };
}

/** O token aparece em algum campo do documento? Base da frequência documental. */
function apareceEm(fields, token) {
  return includesToken(fields.id, token)
    || fields.positive.some((value) => includesToken(value, token))
    || fields.aliases.some((value) => includesToken(value, token))
    || fields.categories.some((value) => includesToken(value, token))
    || includesToken(fields.group, token)
    || includesToken(fields.description, token);
}

/**
 * Peso de raridade do token, no formato IDF do BM25, **normalizado para (0, 1]**.
 *
 * A normalização é deliberada e é o que torna esta mudança segura: o teto (1) é o
 * token que aparece em UM único documento, e nesse caso o peso de campo vale
 * exatamente o que já valia. Termo comum só DESCONTA daquele teto — nada infla.
 * Por isso os bônus de frase (nome-exato = 220 etc.) seguem dominando em qualquer
 * tamanho de catálogo: se o peso de token pudesse crescer com N, uma área grande
 * acabaria afogando o casamento exato de nome, que é o oposto do que se quer.
 *
 * A forma `+0.5` do BM25 é usada em lugar do IDF clássico porque nunca fica
 * negativa — um termo presente em todos os documentos vale pouco, não vale menos
 * que zero.
 */
function pesoDeRaridade(df, total) {
  if (df <= 0 || total <= 0) return 1;
  const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
  const idfMax = Math.log(1 + (total - 0.5) / 1.5);
  if (!(idfMax > 0)) return 1;
  return Math.min(1, idf / idfMax);
}

function frequenciasDocumentais(listaDeCampos, tokens) {
  const df = new Map();
  for (const token of tokens) {
    df.set(token, listaDeCampos.reduce((n, fields) => n + (apareceEm(fields, token) ? 1 : 0), 0));
  }
  return df;
}

/**
 * A consulta casa algum gatilho negativo? Fronteira de PALAVRA via padding de
 * espaço. Exportado porque a busca precisa REAPLICAR o negativo da consulta
 * ORIGINAL sobre matches vindos de variantes do léxico — o "não use quando"
 * do curador fala do que o usuário digitou, não do sinônimo substituído.
 */
export function casaGatilhoNegativo(negativosNormalizados, phrase) {
  return (negativosNormalizados || []).some((value) => {
    if (value === phrase) return true;
    const vf = ` ${value} `;
    const pf = ` ${phrase} `;
    return (phrase.length >= 4 && vf.includes(pf)) || (value.length >= 4 && pf.includes(vf));
  });
}

function scoreDoc(fields, phrase, tokens, pesos) {
  const reasons = new Set();
  let score = 0;

  if (fields.id === phrase) {
    score += 220;
    reasons.add('nome-exato');
  } else if (phrase && fields.id.includes(phrase)) {
    score += 110;
    reasons.add('nome-frase');
  }
  if (fields.positive.some((value) => value === phrase)) {
    score += 100;
    reasons.add('gatilho-exato');
  } else if (phrase && fields.positive.some((value) => value.includes(phrase))) {
    score += 65;
    reasons.add('gatilho-frase');
  }
  if (fields.aliases.some((value) => value === phrase || (phrase && value.includes(phrase)))) {
    score += 80;
    reasons.add('alias');
  }

  // GATILHO NEGATIVO — o curador declarou "não use quando…" e a consulta é
  // exatamente esse quando. O casamento é por FRASE, nunca por token: os
  // negativos compartilham o vocabulário do domínio com os positivos (a skill
  // `recurso-especial` nega "recurso ordinário"), e penalizar por token
  // derrubaria a skill certa com as palavras dela mesma. Efeito com o filtro
  // `score > 0` da saída: casamento fraco + negativo sai da lista (a skill
  // disse "não sou para isso", e só o acaso a trouxe); casamento FORTE +
  // negativo permanece, rebaixado e com `gatilho-negativo` em `matched_by` —
  // o Arquiteto precisa VER o conflito, não ser poupado dele. O corte de 4+
  // caracteres evita que um negativo curto capture frases por acidente.
  // Fronteira de PALAVRA via padding de espaço — `normalize` já garante
  // tokens separados por espaço único. Substring crua casava subpalavra:
  // negativo "júri" (4 chars) disparava dentro de "jurisprudência", e o
  // Arquiteto lia um conflito que o curador nunca declarou.
  if (casaGatilhoNegativo(fields.negative, phrase)) {
    score -= 60;
    reasons.add('gatilho-negativo');
  }

  // Peso por CAMPO (onde casou) × peso por RARIDADE (quanto o termo informa).
  // O peso de campo sozinho era o defeito: com uma área grande, um token que
  // aparece em centenas de skills somava tanto quanto um que aparece em três.
  let covered = 0;
  for (const token of tokens) {
    const raridade = pesos.get(token) ?? 1;
    let campo = 0;
    if (includesToken(fields.id, token)) {
      campo += 26;
      reasons.add('nome');
    }
    if (fields.positive.some((value) => includesToken(value, token))) {
      campo += 18;
      reasons.add('gatilho');
    }
    if (fields.aliases.some((value) => includesToken(value, token))) {
      campo += 16;
      reasons.add('alias');
    }
    if (fields.categories.some((value) => includesToken(value, token))) {
      campo += 8;
      reasons.add('categoria');
    }
    if (includesToken(fields.group, token)) {
      campo += 4;
      reasons.add('dominio');
    }
    if (includesToken(fields.description, token)) {
      campo += 3;
      reasons.add('descricao');
    }
    if (campo > 0) {
      score += campo * raridade;
      covered++;
    }
  }
  // Cobrir TODOS os termos da consulta é sobre abrangência, não sobre raridade —
  // por isso o bônus fica cru, como os bônus de frase.
  if (tokens.length && covered === tokens.length) {
    score += 35;
    reasons.add('todos-os-termos');
  }
  return { score, reasons: [...reasons].sort() };
}

/**
 * Ordena `docs` por relevância para `query`.
 * Devolve `[{ id, score, reasons }]`, decrescente por score, desempate por id.
 * Documentos sem nenhum casamento são omitidos.
 */
export function rankSkills(docs, query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const phrase = normalize(query);

  // Normaliza os campos UMA vez: a frequência documental precisa varrer o corpus
  // inteiro antes de pontuar qualquer documento.
  const listaDeCampos = docs.map(campos);
  const pesos = frequenciasDocumentais(listaDeCampos, tokens);
  for (const [token, df] of pesos) pesos.set(token, pesoDeRaridade(df, listaDeCampos.length));

  return listaDeCampos
    .map((fields, i) => ({ id: docs[i].id, ...scoreDoc(fields, phrase, tokens, pesos) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    // Arredonda só na saída, nunca antes de ordenar — arredondar antes criaria
    // empates que a ordem real não tem.
    .map((item) => ({ ...item, score: Math.round(item.score * 100) / 100 }));
}
