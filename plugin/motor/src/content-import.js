// Conversão de um export externo para a árvore de conteúdo do motor.
//
// O módulo é genérico quanto à ORIGEM: recebe registros com um schema
// documentado (§ abaixo) e não conhece de que biblioteca vieram. O que ele
// conhece é o formato de destino — `skills/<slug>/SKILL.md` com o frontmatter
// que o motor lê.
//
// ── A regra que define este arquivo: NÃO INVENTAR ──────────────────────────
//
// Um export de biblioteca traz slug, título, resumo, tags e corpo — tudo que
// descreve o QUE a skill faz. Ele não traz `risk_level` nem `delivery_type`, e
// esses dois são exatamente os campos de que os gates fail-closed dependem:
// risco define quanta evidência a promoção exige (§PROMOTION_EVIDENCE_MINIMUMS)
// e delivery_type define se a skill mexe no mundo externo.
//
// Deduzi-los por heurística sobre texto livre seria fabricar a metadata que
// existe para impedir que uma skill errada entre numa peça — e fabricar de um
// jeito plausível, que é o pior: ninguém revisaria. Então o conversor recusa, e
// o curador declara uma vez por lote.
//
// Schema de entrada esperado (campos ausentes são tolerados, exceto os marcados):
//   slug*                   → identidade da skill
//   summary | title*        → descrição
//   tags[]                  → categorias e gatilhos
//   instructions_markdown*  → corpo
//   version, area           → metadata informativa

// ── Por que este módulo NÃO exige `risk_level` nem `delivery_type` ─────────
//
// A primeira versão exigia os dois, "para não inventar". Estava errada, e o erro
// foi medido em 4521 skills reais.
//
// O motor JÁ os deriva por regra (`src/skill-contract.js`): `delivery_type` sai
// do `quality_profile` 1:1, e `risk_level` sai da função da skill mais um
// vocabulário de estrago (prazo, prescrição, cálculo, liminar, protocolo,
// assinatura, envio…). E `skill-contract.js:135` faz a **declaração explícita
// vencer a inferência**.
//
// Ou seja: exigir um default de lote não evitava a invenção — OBRIGAVA a ela, e
// a invenção silenciava a classificação do motor. Medido: com `r3` carimbado nas
// 4521, **1489** que o motor classificaria como `r4` ficaram `r3`. A barra de
// promoção caiu de 12 casos e 2 revisores humanos para 8 e 1, em um terço do
// acervo, justamente nas skills de redigir, calcular e agir.
//
// Omitir é mais seguro que qualquer default: quem não sabe não atrapalha quem
// sabe. O override continua disponível para o curador que conhece o instituto —
// só deixou de ser obrigatório.

function limpar(texto) {
  return String(texto || '').replace(/\s+/g, ' ').trim();
}

/** Escapa para valor YAML entre aspas simples, que é o que o parser do motor lê. */
function listaYaml(valores) {
  return `[${valores.map((v) => limpar(v)).filter(Boolean).join(', ')}]`;
}

/**
 * Converte um registro em `{ path, conteudo }`.
 *
 * `defaults.risk_level` e `defaults.delivery_type` são OPCIONAIS e só devem ser
 * passados por quem conhece o instituto. Ausentes, o campo é omitido e o motor
 * classifica — ver o bloco no topo deste arquivo para o porquê, com o número.
 */
export function converterRegistro(registro, defaults = {}) {
  const slug = limpar(registro.slug);
  if (!slug) throw new Error('content-import: registro sem `slug` — não há como nomear a skill');

  const corpo = String(registro.instructions_markdown || '');
  if (!corpo.trim()) {
    throw new Error(`content-import: registro "${slug}" com corpo vazio — nada a converter`);
  }

  const tags = (registro.tags || []).map(limpar).filter(Boolean);
  const resumo = limpar(registro.summary) || limpar(registro.title) || slug;
  const gatilhos = [slug, ...tags].slice(0, 6);

  const frontmatter = [
    '---',
    `name: ${slug}`,
    'description: >-',
    `  ${resumo} Gatilhos: ${gatilhos.join(', ')}.`,
    '  Rascunho técnico — exige revisão humana antes de qualquer uso real.',
    'metadata:',
    '  type: "prompt"',
    '  lifecycle: "active"',
    // Nunca promovida: a evidência comportamental é local e não existe numa
    // importação. Sair como `verified` seria o motor mentindo.
    '  quality_status: "contracted"',
    `  categories: ${listaYaml(tags.length ? tags : [registro.area || 'importada'])}`,
    `  positive_triggers: ${listaYaml(gatilhos)}`,
    // Os três campos abaixo ficam AUSENTES quando não declarados, de propósito.
    // `quality_profile` sai de `classifySkillQualityProfile` (função da skill),
    // `delivery_type` sai do perfil 1:1, e `risk_level` sai da função mais o
    // vocabulário de estrago. Declarar qualquer um aqui SUPRIME a regra do motor,
    // porque a declaração explícita vence a inferência.
    ...(defaults.risk_level ? [`  risk_level: "${limpar(defaults.risk_level)}"`] : []),
    ...(defaults.delivery_type ? [`  delivery_type: "${limpar(defaults.delivery_type)}"`] : []),
    ...(registro.version ? [`  version: "${limpar(registro.version)}"`] : []),
    ...(registro.area ? [`  source_area: "${limpar(registro.area)}"`] : []),
    '---',
    '',
    '<!-- PROVENIÊNCIA DA IMPORTAÇÃO',
    `  Origem: ${limpar(defaults.origem) || 'não declarada'}.`,
    ...(defaults.risk_level || defaults.delivery_type
      ? [
        '  ATENÇÃO: risk_level/delivery_type foram HERDADOS de um default de lote,',
        '  não analisados por skill — e default explícito SUPRIME a classificação',
        '  do motor. Reveja antes de promover, ou remova para o motor classificar.',
      ]
      : [
        '  risk_level, delivery_type e quality_profile foram deixados em aberto',
        '  de propósito: o motor os classifica pela função da skill no contract-skills.',
      ]),
    '-->',
    '',
  ].join('\n');

  return { path: `skills/${slug}/SKILL.md`, conteudo: `${frontmatter}${corpo.trimEnd()}\n` };
}
