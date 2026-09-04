// Validador MECÂNICO de squad — converte em código os gates que o Build hoje
// só descreve em prompt.
//
// A auditoria do Arquiteto apontou que o enforcement era majoritariamente
// textual: os gates verificavam MENÇÃO, não existência, e a "Filesystem
// Validation" do build.prompt.md dependia da obediência do modelo ao markdown.
// Este módulo é a contraparte determinística: mesmo conjunto de invariantes,
// verificado por código, com exit code — utilizável como gate real.
//
// Sem dependência de lib YAML, pelo mesmo motivo do resto do motor
// (src/acervo-search.js, tests/pipeline-runner.test.js): parsing por regex
// sobre um formato que nós mesmos geramos.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFrontMatter, getSkillLifecyclePolicy, parseSkillMetadata, stripComment } from './frontmatter.js';
import { defaultBestPracticesCatalogPath } from './best-practices-catalog.js';
import { NATIVE_RUNTIME_SKILLS } from './skill-runtime-policy.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function squadsDirPadrao() {
  return join(PACKAGE_ROOT, 'squads');
}

/** `skills/` é irmão de `squads/` na raiz do projeto do usuário. */
function skillsDirPadrao(squadsDir) {
  return join(dirname(squadsDir), 'skills');
}

/** Reusa o mesmo cálculo de caminho de `defaultBestPracticesCatalogPath` — um só lugar sabe onde `_legalsquad/core/best-practices/` mora. */
function bestPracticesDirPadrao(squadsDir) {
  return dirname(defaultBestPracticesCatalogPath(dirname(squadsDir)));
}

/**
 * Valores declarados numa chave de topo qualquer — cobre as duas formas que o
 * motor gera: lista de bloco (`chave:\n  - a\n  - b`) e inline (`chave: [a, b]`).
 * Reusada por `skills:` (frontmatter dos agentes inclusive) e por `data:`.
 */
function listaDeChave(texto, chave) {
  const inline = texto.match(new RegExp(`^\\s*${chave}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const bloco = texto.match(new RegExp(`^${chave}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'));
  if (!bloco) return [];
  return bloco[1]
    .split('\n')
    .map((linha) => linha.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map((s) => s.replace(/^["']|["']$/g, ''));
}

const skillsDeclaradas = (texto) => listaDeChave(texto, 'skills');

/**
 * Valor inteiro de uma chave de topo (`meta_verifiers: 3`). Tolera aspas e
 * comentário à direita — a forma que o próprio `build.prompt.md` ensina
 * (`citation_verifiers: 3   # default já é 3`). `null` = chave ausente, que é
 * informação diferente de `1` e precisa sobreviver até a mensagem.
 *
 * A leitura do escalar (localizar a chave, tirar comentário e aspas) é de
 * `escalarDeChave`; aqui só se decide se o que veio é inteiro. A regra de
 * comentário/aspas vive UMA vez, com as exceções do YAML. Isso corrige dois
 * casos que a regex antiga lia errado (correção para YAML real, não
 * regressão): `3#x` (`#` colado é valor) é a string "3#x", e `"3 # x"` (`#`
 * entre aspas é valor) é a string "3 # x" — nenhum dos dois é inteiro, então
 * ambos valem como chave NÃO declarada.
 */
function inteiroDeChave(texto, chave) {
  const valor = escalarDeChave(texto, chave);
  return valor !== null && /^\d+$/.test(valor) ? Number(valor) : null;
}

/**
 * O valor CRU (sem comentário, sem aspas) de uma chave de topo, ou `null`
 * quando a chave não está declarada. Existe porque `inteiroDeChave` funde dois
 * estados que às vezes precisam ser distinguidos — "chave ausente" e "chave
 * presente com valor que não é inteiro" —, e quem valida vocabulário
 * (`model:`, `effort:`) precisa exatamente dessa distinção: ausência é
 * legítima (herda), valor fora do vocabulário não é. A regra de
 * comentário/aspas continua vivendo UMA vez, aqui.
 */
function escalarDeChave(texto, chave) {
  const m = texto.match(new RegExp(`^${chave}:[ \\t]*(.*)$`, 'm'));
  return m ? semAspas(stripComment(m[1])) : null;
}

const PREFIXO_INSTALACAO_BP = '_legalsquad/core/best-practices/';
const PREFIXO_AUTORIA_BP = 'core/best-practices/';

/** Entradas de `data:` que apontam pra best-practices — instalação ou autoria. */
function bestPracticesDeclaradas(texto) {
  return listaDeChave(texto, 'data').filter(
    (ref) => ref.startsWith(PREFIXO_INSTALACAO_BP) || ref.startsWith(PREFIXO_AUTORIA_BP)
  );
}

/**
 * `---\nname: ...\n---` — contrato exigido só de best-practice consumida via
 * `format:` (runner.pipeline.md, Agent Loading 4a). Reusa `extractFrontMatter`
 * (mesmo strip de BOM que já protege SKILL.md) em vez de reimplementar o
 * parse pela terceira vez neste motor.
 */
function temFrontmatterComName(texto) {
  const corpo = extractFrontMatter(texto);
  return corpo ? /^name:\s*\S/m.test(corpo) : false;
}

/** Caminho relativo a `bestPracticesDir` que a referência implica — nunca só o basename. */
function caminhoRelativoBP(ref) {
  if (ref.startsWith(PREFIXO_INSTALACAO_BP)) return ref.slice(PREFIXO_INSTALACAO_BP.length);
  if (ref.startsWith(PREFIXO_AUTORIA_BP)) return ref.slice(PREFIXO_AUTORIA_BP.length);
  return ref.split('/').pop();
}

/**
 * Confere as referências a best-practices declaradas em `data:` (squad.yaml)
 * e `format:` (steps do pipeline) — a mesma classe de "declaração que ninguém
 * confere" que `checarSkillsDeclaradas` fecha para skills.
 *
 * Cobre um caso a mais que skills não tem: `data:` pode citar o caminho de
 * AUTORIA (`core/best-practices/`) em vez do de INSTALAÇÃO
 * (`_legalsquad/core/best-practices/`) — resíduo de quando o empacotador
 * ainda materializava no lugar errado. É aviso, não erro: o arquivo pode até
 * existir por acidente, mas a referência não sobrevive a uma reinstalação.
 */
function checarBestPracticesDeclaradas(dir, bestPracticesDir, steps, issues) {
  const squadYamlPath = join(dir, 'squad.yaml');
  const referencias = new Map(); // nome do arquivo -> referência original
  if (existsSync(squadYamlPath)) {
    for (const ref of bestPracticesDeclaradas(readFileSync(squadYamlPath, 'utf8'))) {
      if (ref.startsWith(PREFIXO_AUTORIA_BP) && !ref.startsWith(PREFIXO_INSTALACAO_BP)) {
        issues.push(issue(
          'warn',
          'best-practice-caminho-de-autoria',
          `data: "${ref}" usa o caminho de AUTORIA — instalação materializa em `
            + `"${PREFIXO_INSTALACAO_BP}${ref.slice(PREFIXO_AUTORIA_BP.length)}"`
        ));
      }
      referencias.set(caminhoRelativoBP(ref), ref);
    }
  }

  const formatos = new Map(); // nome do arquivo -> id do step
  for (const step of steps) {
    if (step.format) formatos.set(`${step.format}.md`, step.id);
  }

  if (!referencias.size && !formatos.size) return;

  if (!existsSync(bestPracticesDir)) {
    issues.push(issue(
      'warn',
      'best-practices-nao-instaladas',
      `${referencias.size + formatos.size} referência(s) de best-practice e nenhum diretório em `
        + `${bestPracticesDir} — área não instalada; não dá para verificar existência nem contrato`
    ));
    return;
  }

  for (const [arquivo, ref] of referencias) {
    if (!existsSync(join(bestPracticesDir, arquivo))) {
      issues.push(issue(
        'error',
        'best-practice-declarada-inexistente',
        `data: "${ref}" declarada e ausente de ${bestPracticesDir}`
      ));
    }
  }

  for (const [arquivo, stepId] of formatos) {
    const caminho = join(bestPracticesDir, arquivo);
    if (!existsSync(caminho)) {
      issues.push(issue(
        'error',
        'format-declarado-inexistente',
        `${stepId}: format: aponta pra "${arquivo}", ausente de ${bestPracticesDir}`
      ));
      continue;
    }
    if (!temFrontmatterComName(readFileSync(caminho, 'utf8'))) {
      issues.push(issue(
        'error',
        'format-sem-frontmatter',
        `${stepId}: format: "${arquivo}" existe mas não tem frontmatter YAML com name: — `
          + 'contrato exigido de quem é consumida via format: (runner.pipeline.md, Agent Loading 4a)'
      ));
    }
  }
}

/**
 * Confere que toda skill declarada existe e pode entrar em produção.
 *
 * `skills:` é DECLARAÇÃO — o runner a usa para injetar instrução, e até aqui
 * ninguém verificava que o alvo existe. Skill inexistente faz o step rodar com
 * menos instrução do que o squad promete; skill `quarantined` faz o resolvedor
 * bloquear só na hora em que o advogado está rodando a peça.
 *
 * **Sem `skills/` no disco, degrada com UM aviso.** Área não instalada é estado
 * normal deste motor (ele é content-free); cuspir um erro por skill declarada
 * transformaria "área ausente" em "squad quebrado" — a confusão entre ausência
 * e defeito que o motor não comete em nenhum outro lugar.
 */
/** Arquivos de agente do squad. Ausência do diretório é normal (squad sem agentes próprios). */
function arquivosDeAgente(dir) {
  const agentsDir = join(dir, 'agents');
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => join(agentsDir, f));
}

/**
 * Marcador MECÂNICO de "esta skill vira peça". Não é campo inventado aqui:
 * `src/skill-contract.js` deriva `delivery_type: legal-draft` 1:1 de
 * `quality_profile: legal-drafting` (e `risk_level: r4` junto), e o pacote de
 * área o grava no SKILL.md de toda skill de redação. É o único sinal de risco
 * de ENTREGA preenchido em campo — o `squad.yaml` não tem campo de risco.
 */
const DELIVERY_TYPE_DE_PECA = 'legal-draft';

/** Devolve os ids das skills declaradas que são de peça (ver `DELIVERY_TYPE_DE_PECA`). */
function checarSkillsDeclaradas(dir, skillsDir, issues, steps = []) {
  // A ORIGEM de cada declaração é preservada (fonte → skills), não só a união:
  // o runner injeta skill POR AGENTE, e um mapa que esquece quem declarou o quê
  // não consegue conferir nenhuma promessa por agente. A união continua sendo o
  // conjunto que as checagens de existência/lifecycle percorrem.
  const declaradas = new Set();
  const porFonte = new Map();
  const fontes = [join(dir, 'squad.yaml'), ...arquivosDeAgente(dir)];
  for (const arquivo of fontes) {
    if (!existsSync(arquivo)) continue;
    const ids = skillsDeclaradas(readFileSync(arquivo, 'utf8'));
    if (ids.length) porFonte.set(basename(arquivo), ids);
    for (const id of ids) declaradas.add(id);
  }
  if (declaradas.size === 0) return [];

  // Skill declarada SÓ no squad.yaml, sem agente que a declare e sem step que a
  // mencione, é promessa que o runner nunca materializa em instrução dirigida —
  // ela entra na união global e nenhum passo diz "carregue X". Aviso, não erro:
  // o proxy é mecânico (menção textual do id), e menção ausente pode ser escolha
  // legítima de squad que injeta tudo globalmente.
  const declaradasPorAgentes = new Set(
    [...porFonte].filter(([fonte]) => fonte !== 'squad.yaml').flatMap(([, ids]) => ids)
  );
  const corpoDosSteps = steps
    .map((step) => (step.file ? join(dir, 'pipeline', step.file) : null))
    .filter((caminho) => caminho && existsSync(caminho))
    .map((caminho) => readFileSync(caminho, 'utf8'))
    .join('\n');
  // Fronteira que trata HÍFEN como parte do identificador — `\b` não serve:
  // em JS o hífen é não-word, e /\bcalculo\b/ casaria dentro de
  // "calculo-de-prazos", suprimindo o warn pela skill errada.
  const mencionadaNosSteps = (id) => {
    const escapado = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])${escapado}([^A-Za-z0-9_-]|$)`).test(corpoDosSteps);
  };
  const nativas = new Set(NATIVE_RUNTIME_SKILLS);
  for (const id of (porFonte.get('squad.yaml') || []).sort()) {
    // Tool-skills nativas (web_search/web_fetch): o próprio Build manda
    // declará-las no squad.yaml e o runtime as resolve com bypass — não há
    // agente nem step que as cite, e o warn seria ruído sistemático em todo
    // squad conforme ao schema.
    if (nativas.has(id)) continue;
    if (declaradasPorAgentes.has(id)) continue;
    if (mencionadaNosSteps(id)) continue;
    issues.push(issue(
      'warn',
      'skill-declarada-nao-referenciada',
      `skill "${id}" declarada no squad.yaml mas nenhum agente a declara e nenhum step a menciona — `
        + 'instrução entra na união global sem passo que a use'
    ));
  }

  if (!existsSync(skillsDir)) {
    issues.push(issue(
      'warn',
      'skills-nao-instaladas',
      `${declaradas.size} skill(s) declarada(s) e nenhum diretório skills/ em ${skillsDir} — `
        + 'área não instalada; não dá para verificar existência nem lifecycle'
    ));
    return [];
  }

  const dePeca = [];
  // Tool-skills nativas (web_search/web_fetch) não têm diretório em skills/:
  // o runtime as resolve com bypass e o próprio Build manda declará-las. O
  // laço de "não referenciada" abaixo já as pulava; este, de existência,
  // acusava "inexistente" — em todo squad de conteúdo instalado de pacote.
  for (const id of [...declaradas].sort()) {
    if (nativas.has(id)) continue;
    const skillPath = join(skillsDir, id, 'SKILL.md');
    if (!existsSync(skillPath)) {
      issues.push(issue('error', 'skill-declarada-inexistente', `skill "${id}" declarada e ausente de ${skillsDir}`));
      continue;
    }
    // `parseSkillMetadata` devolve `null` quando o SKILL.md não tem frontmatter
    // legível — e `checkSquad` promete NUNCA lançar. `getSkillLifecyclePolicy`
    // já tem a porta desenhada para isto (`frontmatterLegivel: false` → nada é
    // elegível), então o ilegível vira o mesmo erro fail-closed do resolvedor em
    // runtime, em vez de um TypeError que derruba o validador inteiro.
    const metadata = parseSkillMetadata(readFileSync(skillPath, 'utf8'), { fallbackName: id });
    if (metadata?.deliveryType === DELIVERY_TYPE_DE_PECA) dePeca.push(id);
    const politica = getSkillLifecyclePolicy(metadata?.lifecycle, { frontmatterLegivel: metadata !== null });
    if (!politica.productionEligible) {
      issues.push(issue(
        'error',
        'skill-lifecycle-proibido',
        `skill "${id}" está ${politica.lifecycle} (${politica.selection}) — não entra em squad de produção`
      ));
    } else if (politica.selection === 'explicit') {
      // `pilot` é escolha consciente com fallback, não erro. Tratá-la como erro
      // impediria o uso legítimo; tratá-la como `active` esconderia a escolha.
      issues.push(issue(
        'warn',
        'skill-pilot-sem-opt-in',
        `skill "${id}" é pilot — exige escolha explícita e fallback declarado`
      ));
    }
  }
  return dePeca;
}

/**
 * Maior `meta_verifiers` declarado no pipeline — o runner lê do squad.yaml OU do
 * step. Indentação livre de propósito: isto é caminho de SUPRESSÃO do aviso, e
 * exigir a coluna certa aqui inventaria um falso positivo em quem declarou.
 */
function metaVerifiersDoPipeline(pipeline) {
  const valores = [...pipeline.matchAll(/^[ \t]*meta_verifiers:[ \t]*["']?(\d+)/gm)].map((m) => Number(m[1]));
  return valores.length ? Math.max(...valores) : null;
}

/**
 * Os sinais mecânicos de "este squad entrega peça" — o racional completo de
 * por que são ESTES dois (e não um campo novo que ninguém preencheria) está em
 * `checarVotingDaMeta`, que os definiu. Extraídos para função porque
 * `checarOnRejectDeRedacao` precisa da MESMA detecção: dois avisos com dois
 * conceitos de "peça" divergiriam na primeira mudança. `checkSquad` a computa
 * UMA vez e entrega o resultado aos dois checks por parâmetro — reler o
 * squad.yaml em cada um era trabalho dobrado sem informação nova.
 */
const VERIFICADORES_DE_PECA = ['verificador-citacoes', 'verificador-persuasao'];

function sinaisDeEntregaDePeca(y, skillsDePeca, textos = []) {
  const sinais = [];
  if (skillsDePeca.length) {
    sinais.push(`declara skill de peça (delivery_type: ${DELIVERY_TYPE_DE_PECA}) — ${skillsDePeca.join(', ')}`);
  }
  // DECLARADO, qualquer valor — o contrato do build.prompt.md ("declare os
  // dois knobs juntos") e do racional em `checarVotingDaMeta`. Exigir >1 aqui
  // silenciava exatamente o par `citation_verifiers: 1` + meta esquecida.
  const citation = inteiroDeChave(y, 'citation_verifiers');
  if (citation !== null) {
    sinais.push(`declara citation_verifiers: ${citation}, ou seja, entrega que cita fonte verificável`);
  }
  // Terceiro sinal, e o que fecha o buraco: os dois sinais acima são campos
  // DECLARADOS, então um squad de peça que esquece os dois não entrega sinal
  // nenhum — e some da população do Gate 4 inteiro, saindo "íntegro" sem que
  // um único check de peça tenha rodado. Acionar `verificador-citacoes` ou
  // `verificador-persuasao` não é campo a preencher, é comportamento no
  // pipeline: esses dois subagentes só existem para entrega que cita fonte.
  // Quem os chama entrega peça, tenha declarado o knob ou não.
  const acionados = VERIFICADORES_DE_PECA
    .filter((nome) => textos.some((t) => t.texto.includes(nome)));
  if (acionados.length) {
    sinais.push(`aciona ${acionados.join(' e ')} no pipeline — subagente que só existe para entrega que cita fonte`);
  }
  return sinais;
}

/**
 * Verificação da Meta com juiz ÚNICO num squad que entrega peça.
 *
 * O default de `meta_verifiers` é **1**, e isso é decisão de produto, não
 * descuido: voting 3x custa 3x em chamadas de LLM, então o consenso é opt-in
 * (`runner.pipeline.md`, "Verificação da Meta"; `build.prompt.md` manda
 * declarar `meta_verifiers: 3` em peça protocolável). O buraco não é o
 * default — é que **nada avisa** quando um squad de alto risco fica nele por
 * esquecimento: a peça passa por todos os gates de design-time em silêncio e
 * vai a produção com um único juiz decidindo sozinho se ela atende à meta.
 *
 * **Qual "indício de risco", já que o `squad.yaml` não tem campo de risco.**
 * Procurar `risk`/`delivery_type` no squad seria procurar campo que ninguém
 * preenche — quem os declara é a SKILL. Então os dois sinais são os que já
 * existem em campo, e o aviso cala quando nenhum aparece:
 *
 * 1. **Skill de peça declarada** (`delivery_type: legal-draft`, no squad.yaml
 *    ou no frontmatter de um agente) — o SKILL.md já foi lido logo acima, para
 *    o lifecycle; nenhuma leitura nova.
 * 2. **`citation_verifiers` declarado** — o squad dizendo, ele mesmo, que
 *    a entrega cita fonte verificável. É o par que o `build.prompt.md` manda
 *    declarar JUNTO com `meta_verifiers`, então declarar um e esquecer o outro
 *    é exatamente o esquecimento perseguido aqui. E este sinal **sobrevive à
 *    área não instalada**, quando nenhum SKILL.md é legível.
 *
 * Warn, nunca error: 1 verificador pode ser escolha consciente de custo, e
 * quem já a fez não pode ver o CI virar vermelho por isso.
 */
function checarVotingDaMeta(y, pipeline, sinais, issues) {
  // `sinais` vazio cobre também squad.yaml ausente (`checkSquad` passa []
  // nesse caso): sem indício de peça, avisar aqui seria ruído em todo squad.
  if (!sinais.length) return;

  // `null` (ausente) e declarado ≤ 1 levam ao mesmo comportamento em runtime,
  // mas a mensagem precisa distinguir: "você esqueceu" ≠ "você escolheu N" —
  // e o N dito é o DECLARADO de verdade (0 inclusive), nunca um "é 1" fixo.
  const declarados = [inteiroDeChave(y, 'meta_verifiers'), metaVerifiersDoPipeline(pipeline)]
    .filter((n) => n !== null);
  const meta = declarados.length ? Math.max(...declarados) : null;
  if (meta !== null && meta > 1) return; // voting declarado — a escolha foi feita

  issues.push(issue(
    'warn',
    'meta-verifiers-sem-voting-em-peca',
    `${sinais.join('; ')}, e meta_verifiers ${meta === null ? 'não é declarado (default 1)' : `é ${meta}`} — `
      + 'a Verificação da Meta fica com um juiz único, que decide sozinho se a peça atende à meta '
      + 'antes de ela ir ao humano. Declare `meta_verifiers: 3` no squad.yaml para consenso '
      + 'conservador (o mesmo do Citation Gate), ou mantenha 1 se o custo for a escolha'
  ));
}

/**
 * Squad de peça em que NENHUM step declara `on_reject`: o REJECT do Redação
 * Gate não tem rota de volta declarada.
 *
 * O runner é explícito (runner.pipeline.md, Redação Gate, caso "sem loop de
 * revisão aberto"): squad que gera peça deveria ter `on_reject` por exigência
 * da Constitution, "mas nem todo squad hand-crafted tem" — e, sem ele, o gate
 * cai no laço paralelo do próprio gate (`--loop redacao-gate`, teto
 * `max_redacao_cycles`) em vez do loop de revisão principal: o rascunho volta
 * à redação sem passar pelos revisores que o squad declarou, e o conserto
 * acontece fora do ciclo desenhado. Funciona — por isso warn, não error —,
 * mas quase nunca é o que o autor quis.
 *
 * **Critério implementado: o grosso (squad inteiro), não o fino (step↔skill).**
 * O fino seria avisar só quando o step de REDAÇÃO fica sem rota de volta; mas
 * `on_reject` vive no step REVISOR (quem rejeita aponta para onde devolver —
 * na fixture demo, step-07/08 → step-05), e a skill de peça é declarada no
 * squad.yaml ou no frontmatter do agente, nunca no step — o parser não extrai
 * aresta step↔skill nenhuma que amarre "este step é a redação desta skill".
 * Então o aviso dispara quando há indício de peça (a MESMA detecção de
 * `meta-verifiers-sem-voting-em-peca` — ver `sinaisDeEntregaDePeca`) e NENHUM
 * step declara `on_reject`; um único `on_reject` cala o aviso, porque apontar
 * qual seria o "certo" exigiria exatamente a aresta que não existe.
 */
function checarOnRejectDeRedacao(sinais, steps, issues) {
  if (steps.some((s) => s.onReject)) return;
  // `sinais` vem computado de `checkSquad` (vazio quando não há squad.yaml).
  if (!sinais.length) return;

  issues.push(issue(
    'warn',
    'redacao-sem-on-reject',
    `${sinais.join('; ')}, e nenhum step do pipeline declara on_reject — um REJECT do Redação Gate `
      + 'cai no laço paralelo do próprio gate em vez do loop de revisão principal: o rascunho volta '
      + 'à redação sem passar pelos revisores que o squad declarou. Declare `on_reject: <step da '
      + 'redação>` no(s) step(s) revisor(es)'
  ));
}

// ---------------------------------------------------------------------------
// Gates estruturais do Arquiteto, em código (auditoria M16).
//
// O Step C do `build.prompt.md` mandava o modelo RELER todo arquivo gerado para
// conferir seção por seção — Gates 0, 1, 1b, 1c, 2 e a metade mecânica do 4 —
// com "máx 2 tentativas" cada. Num squad de 8 agentes e 11 steps isso é o fim
// da criação levando mais tempo que a criação. Tudo que é "a seção existe?",
// "o arquivo existe?", "a string aparece?" é grep, e grep é daqui.
//
// O contrato de SEÇÕES é do Arquiteto: só vale para squad que passou por ele
// (tem `_build/`). Squad escrito à mão — as fixtures, um squad legado — segue
// o contrato mínimo do runner e não é cobrado por prosa que nunca prometeu.
// Já o nome do agente e as regras de peça (veredito, isolamento, Citation
// Gate, ética) são contrato do RUNNER e do dashboard: valem para todos.
//
// Tudo aqui é `warn`: o run funciona sem a seção; o que se perde é a
// qualidade que o Arquiteto desenhou. O prompt manda corrigir cada aviso da
// família antes de apresentar o squad — é a mesma exigência de antes, só que
// lida de uma saída de comando em vez de reconstruída a cada gate.
// ---------------------------------------------------------------------------
const SECOES_DE_AGENTE = [
  '## Persona', '### Role', '### Identity', '### Communication Style',
  '## Principles',
  '## Voice Guidance', '### Vocabulary — Always Use', '### Vocabulary — Never Use',
  '## Anti-Patterns', '### Never Do', '### Always Do',
  '## Quality Criteria', '## Integration',
];
// Com `tasks:` o Arquiteto MOVE estas duas para os arquivos de task.
const SECOES_DE_AGENTE_SEM_TASKS = ['## Operational Framework', '### Process', '### Decision Criteria', '## Output Examples'];
const CAMPOS_DE_TASK = ['task', 'order', 'input', 'output'];
const SECOES_DE_TASK = ['## Process', '## Output Format', '## Output Example', '## Quality Criteria', '## Veto Conditions'];
const SECOES_DE_STEP = ['## Context Loading', '## Instructions', '### Process', '## Output Format', '## Output Example', '## Veto Conditions', '## Quality Criteria'];

const temSecao = (texto, titulo) => new RegExp(`^${titulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(texto);
const secoesAusentes = (texto, secoes) => secoes.filter((sec) => !temSecao(texto, sec));

/** Lista de topo em YAML plano: bloco `- a` OU inline `[a, b]`. Ausente → `[]`. */
function listaDeTopo(texto, chave) {
  const inline = texto.match(new RegExp(`^${chave}:[ \\t]*\\[([^\\]]*)\\]`, 'm'));
  if (inline) return inline[1].split(',').map((v) => semAspas(v)).filter(Boolean);
  const bloco = texto.match(new RegExp(`^${chave}:[ \\t]*\\n((?:[ \\t]+- .*\\n?)*)`, 'm'));
  if (!bloco) return [];
  return [...bloco[1].matchAll(/^[ \t]+- (.+)$/gm)].map((m) => semAspas(stripComment(m[1]))).filter(Boolean);
}

const passouPeloArquiteto = (dir) => existsSync(join(dir, '_build'));

const inicial = (palavra) => palavra.normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toLowerCase();

/**
 * O `agents:` do `squad.yaml` é o que `tools/compilar-workflow.mjs` lê para
 * emitir o workflow (MIKE-CHEFE §7). O `squad-party.csv` é outra fonte, e é a
 * que todo o resto deste validador usa. Enquanto ninguém confrontava as duas,
 * um squad passava aqui limpo e o compilador o recusava com "agent «X» não está
 * declarado em squad.yaml (agents)" — medido num squad real em 04/09/2026.
 *
 * Aviso, não erro: nem todo squad é compilado, e o run pelo próprio runner não
 * depende deste bloco. Mas quem for compilar precisa saber antes.
 */
function checarAgentesNoSquadYaml(y, steps, issues) {
  if (y === null) return;
  const usados = [...new Set(steps.filter((s) => s.agent).map((s) => s.agent))];
  if (!usados.length) return;
  const bloco = y.match(/^agents:[ \t]*\n((?:[ \t]+.*\n|[ \t]*\n)*)/m);
  if (!bloco) {
    issues.push(issue(
      'warn',
      'agents-fora-do-squad-yaml',
      `${usados.length} agente(s) em uso nos steps e nenhum bloco \`agents:\` no squad.yaml — `
        + '`tools/compilar-workflow.mjs` recusa o squad sem ele (o runner não depende)'
    ));
    return;
  }
  const declarados = new Set([...bloco[1].matchAll(/^[ \t]+- id:[ \t]*(\S+)/gm)].map((m) => semAspas(m[1])));
  const faltando = usados.filter((id) => !declarados.has(id)).sort();
  if (faltando.length) {
    issues.push(issue(
      'warn',
      'agents-fora-do-squad-yaml',
      `agente(s) usados em step e ausentes do \`agents:\` do squad.yaml: ${faltando.join(', ')} — `
        + '`tools/compilar-workflow.mjs` os recusa'
    ));
  }
}

/** Gate 0 — nome de agente: duas palavras aliteradas ("Pedro Pesquisa"). Contrato de persona/dashboard, vale para todo squad. */
function checarNomesDosAgentes(dir, issues) {
  for (const arquivo of arquivosDeAgente(dir)) {
    const fm = extractFrontMatter(readFileSync(arquivo, 'utf8'));
    if (!fm) continue;
    const nome = escalarDeChave(fm, 'name');
    if (nome === null) continue; // frontmatter sem name: o runner lê outra coisa, não é deste gate
    const palavras = nome.trim().split(/\s+/).filter(Boolean);
    const onde = basename(arquivo);
    if (palavras.length < 2) {
      issues.push(issue('warn', 'nome-de-agente-fora-do-padrao', `${onde}: name "${nome}" tem uma palavra só — o padrão é "Nome Sobrenome" aliterado (ex.: "Pedro Pesquisa")`));
    } else if (inicial(palavras[0]) !== inicial(palavras[1])) {
      issues.push(issue('warn', 'nome-de-agente-fora-do-padrao', `${onde}: name "${nome}" não alitera — nome e sobrenome começam com a mesma letra (ex.: "Pedro Pesquisa")`));
    }
  }
}

/** Gates 1 e 1b — seções do `.agent.md` e das tasks. Só para squad com `_build/` (contrato do Arquiteto). */
function checarEstruturaDosAgentes(dir, issues) {
  if (!passouPeloArquiteto(dir)) return;
  for (const arquivo of arquivosDeAgente(dir)) {
    if (!arquivo.endsWith('.agent.md')) continue; // `.custom.md` é o formato legado de overlay — outro contrato
    const texto = readFileSync(arquivo, 'utf8');
    const fm = extractFrontMatter(texto);
    const onde = basename(arquivo);
    const tasks = fm ? listaDeTopo(fm, 'tasks') : [];
    const exigidas = tasks.length ? SECOES_DE_AGENTE : [...SECOES_DE_AGENTE, ...SECOES_DE_AGENTE_SEM_TASKS];
    const faltam = secoesAusentes(texto, exigidas);
    if (faltam.length) {
      issues.push(issue('warn', 'secoes-de-agente-ausentes', `${onde}: faltam ${faltam.length} seção(ões) do formato do Arquiteto — ${faltam.join(', ')}`));
    }
    const idDoAgente = onde.replace(/\.agent\.md$/, '');
    for (const task of tasks) {
      const caminho = join(dir, 'agents', idDoAgente, task);
      if (!existsSync(caminho)) {
        // O runner carrega a task pelo caminho: sem arquivo o agente roda sem o processo que promete.
        issues.push(issue('error', 'task-ausente', `${onde}: tasks: "${task}" não existe em agents/${idDoAgente}/`));
        continue;
      }
      const corpo = readFileSync(caminho, 'utf8');
      const fmTask = extractFrontMatter(corpo);
      const camposFaltando = CAMPOS_DE_TASK.filter((c) => !fmTask || escalarDeChave(fmTask, c) === null);
      if (camposFaltando.length) {
        issues.push(issue('warn', 'task-frontmatter-incompleto', `${idDoAgente}/${task}: sem ${camposFaltando.join(', ')} no frontmatter`));
      }
      const secoesFaltando = secoesAusentes(corpo, SECOES_DE_TASK);
      if (secoesFaltando.length) {
        issues.push(issue('warn', 'task-secao-ausente', `${idDoAgente}/${task}: faltam ${secoesFaltando.join(', ')}`));
      }
    }
  }
}

/** Gate 2 — seções do step de agente. Só para squad com `_build/`. */
function checarEstruturaDosSteps(dir, steps, issues) {
  if (!passouPeloArquiteto(dir)) return;
  for (const step of steps) {
    if (step.tipo === 'checkpoint' || !step.file) continue;
    const caminho = join(dir, 'pipeline', step.file);
    if (!existsSync(caminho)) continue; // `step-file-ausente` já cobra
    const faltam = secoesAusentes(readFileSync(caminho, 'utf8'), SECOES_DE_STEP);
    if (faltam.length) {
      issues.push(issue('warn', 'step-secao-ausente', `${step.id} (${step.file}): faltam ${faltam.join(', ')}`));
    }
  }
}

/** Todo texto de agentes e steps do squad, para as checagens "a string aparece em algum lugar". */
function textosDoSquad(dir, steps) {
  const textos = [];
  for (const arquivo of arquivosDeAgente(dir)) textos.push({ onde: `agents/${basename(arquivo)}`, texto: readFileSync(arquivo, 'utf8') });
  for (const step of steps) {
    const caminho = step.file ? join(dir, 'pipeline', step.file) : null;
    if (caminho && existsSync(caminho)) textos.push({ onde: `pipeline/${step.file}`, texto: readFileSync(caminho, 'utf8'), step });
  }
  return textos;
}

/**
 * Onde o Arquiteto pode declarar os especialistas reusados. `discovery.yaml`
 * é o nome do documento da Discovery; `design.yaml` é o que o `build.prompt.md`
 * manda escrever e o que aparece em campo. Ler só um dos dois fazia o Gate 1c
 * INTEIRO passar em silêncio num squad real: `check-squad` respondia
 * "estrutura íntegra" sem nunca ter conferido reuso nenhum — o pior tipo de
 * verde, o que afirma o que não olhou.
 */
const FONTES_DE_ESPECIALISTAS = ['design.yaml', 'discovery.yaml'];

/**
 * Gate 1c — reuso de especialistas: cada nome de `specialist_agents`
 * (em `_build/design.yaml` ou `_build/discovery.yaml`) existe em
 * `.claude/agents/` do projeto E é citado por algum agente/step do squad.
 * Delegar a agente que não está instalado é reuso fantasma (error — o run
 * falha ao acionar); existir sem ser citado é reuso perdido (warn). Sem
 * nenhuma das duas fontes, nada a conferir.
 */
/**
 * Os DOIS escopos em que um subagente pode estar instalado, na ordem em que o
 * harness os resolve: o do projeto e o do usuário.
 *
 * Olhar só o do projeto foi um falso positivo caro. Num projeto real, o
 * advogado tinha 38 agentes em `~/.claude/agents/` e 3 no projeto — e o
 * `especialista-nao-instalado` (ERROR, que barra o squad) acusava de ausente um
 * `resumo-processo` instalado, funcional e acionado sem problema pelo runner.
 * Pior: quem põe agente ali é o `install-global` DESTE motor, de modo que o
 * validador contradizia o próprio instalador. Um gate que reprova o que
 * funciona custa mais do que um gate que não roda: ensina a ignorá-lo.
 */
function diretoriosDeAgentes(squadsDir, home = homedir()) {
  return [
    join(dirname(resolve(squadsDir)), '.claude', 'agents'),
    ...(home ? [join(home, '.claude', 'agents')] : []),
  ];
}

function checarReusoDeEspecialistas(dir, squadsDir, steps, issues, home = homedir()) {
  const especialistas = new Map();
  for (const arquivo of FONTES_DE_ESPECIALISTAS) {
    const caminho = join(dir, '_build', arquivo);
    if (!existsSync(caminho)) continue;
    for (const nome of listaDeTopo(readFileSync(caminho, 'utf8'), 'specialist_agents')) {
      if (!especialistas.has(nome)) especialistas.set(nome, arquivo);
    }
  }
  if (!especialistas.size) return;
  const agentsDirs = diretoriosDeAgentes(squadsDir, home);
  const textos = textosDoSquad(dir, steps);
  for (const [nome, arquivo] of especialistas) {
    if (!agentsDirs.some((d) => existsSync(join(d, `${nome}.md`)))) {
      issues.push(issue('error', 'especialista-nao-instalado', `${arquivo} escolheu "${nome}", ausente de ${agentsDirs.join(' e de ')} — delegar a agente não instalado é reuso fantasma`));
      continue;
    }
    if (!textos.some((t) => t.texto.includes(nome))) {
      issues.push(issue('warn', 'especialista-nao-referenciado', `"${nome}" existe em .claude/agents/ mas nenhum agente ou step do squad o cita pelo nome — reuso perdido`));
    }
  }
}

/**
 * O que o `build.prompt.md` manda e o validador não cobrava.
 *
 * Os quatro vêm de uma bateria de avarias controladas num squad real: o
 * `check-squad` respondia "✓ estrutura íntegra" para todos.
 */
/**
 * Subcomandos que `npx legalsquad` aceita de verdade.
 *
 * A lista é espelho do `HELP` de `bin/legalsquad.js`, e `tests/squad-check.test.js`
 * cobra a paridade: acrescentar subcomando à CLI sem acrescentá-lo aqui quebra a
 * suíte, que é o único jeito de a cópia não envelhecer em silêncio.
 *
 * Por que existe: num squad real, o step de pesquisa mandava rodar
 * `npx legalsquad run-status` para ler o escopo no ledger. O comando NÃO EXISTE
 * — o runner do motor manda `node scripts/squad-state.mjs run-status`, e o
 * Arquiteto inventou a forma da CLI. A falha é quase muda: imprime o banner de
 * ajuda. O agente daquele run percebeu e caiu para o artefato do checkpoint; um
 * menos cuidadoso teria seguido com escopo vazio, sem nunca saber por quê.
 */
const SUBCOMANDOS_DA_CLI = Object.freeze([
  'acervo', 'agents', 'ativar', 'audit-skills', 'captura', 'check-skills', 'check-squad',
  'chefe', 'contract-skills', 'detail-skill', 'indexar-skills', 'init', 'install',
  'install-global', 'memoria', 'resolve-skills', 'runs', 'search-acervo', 'search-skills',
  'skills', 'uninstall', 'update',
]);

/**
 * Comando `npx legalsquad <sub>` citado num step ou agente que a CLI não tem.
 *
 * Um step é lei para o agente que o executa: ele roda o que está escrito ali. Se
 * o comando não existe, o agente recebe o banner de ajuda no lugar do dado e
 * segue sem ele — e nenhum gate via isso.
 */
function checarComandosDaCli(dir, steps, issues) {
  const vistos = new Map();
  for (const t of textosDoSquad(dir, steps)) {
    for (const m of t.texto.matchAll(/\bnpx\s+legalsquad\s+([a-z][a-z0-9:-]*)/g)) {
      if (!SUBCOMANDOS_DA_CLI.includes(m[1]) && !vistos.has(m[1])) vistos.set(m[1], t.onde);
    }
  }
  for (const [sub, onde] of vistos) {
    issues.push(issue('error', 'comando-da-cli-inexistente', `${onde} manda rodar \`npx legalsquad ${sub}\`, e a CLI não tem esse subcomando — o agente recebe o banner de ajuda no lugar do dado e segue sem ele. Aceitos: ${SUBCOMANDOS_DA_CLI.join(', ')}`));
  }
}

function checarPromessasDoBuild(dir, steps, issues) {
  // (a) `outputFile` fora de `output/` — o prompt escreve "NEVER use
  // pipeline/data/ for outputFile", porque a transformação de caminho do runner
  // só se aplica a `squads/{code}/output/`: gravar noutro lugar CONTORNA o
  // escopo por run_id, e dois runs simultâneos se sobrescrevem em silêncio.
  for (const step of steps) {
    const saida = outputFileDoStep(dir, step);
    if (saida && !/(^|\/)output\//.test(saida)) {
      issues.push(issue('error', 'output-fora-do-escopo-do-run', `${step.id}: outputFile "${saida}" está fora de \`output/\` — só ali o runner aplica o escopo por run_id; gravando fora, dois runs do mesmo squad se sobrescrevem`));
    }
  }

  // (b) O checkpoint de APROVAÇÃO sem `outputFile` não grava nada: a aprovação
  // humana da peça deixa de ter rastro, e não se sabe depois quem autorizou o
  // quê. O prompt já avisa em caixa ("CHECKPOINT NÃO EXECUTA TRABALHO — e sem
  // `outputFile` no FRONTMATTER ele não grava nada"); faltava o código.
  // O nome canônico da parada pode estar no id OU no arquivo do step — é a
  // mesma leitura que `checarParadasHumanas` faz, e ignorá-la fazia este check
  // não achar a aprovação num squad cujos ids são `step-01`…`step-09`.
  const ehAprovacao = (x) => /aprova[cç]?[aã]?o?/i.test(`${x.id} ${x.file || ''}`);
  for (const step of steps.filter((x) => x.tipo === 'checkpoint' && ehAprovacao(x))) {
    if (!outputFileDoStep(dir, step) && !step.artefatos.length) {
      issues.push(issue('warn', 'aprovacao-sem-registro', `${step.id} é o checkpoint de aprovação e não declara outputFile nem artefato — sem gravar, a autorização humana da entrega não deixa rastro de quem aprovou o quê`));
    }
  }

  // (c) Agente no elenco que nenhum step aciona. O inverso — step usando agente
  // fora do party — já é erro; este lado ficava mudo, e elenco fantasma é
  // trabalho de geração jogado fora, além de enganar quem lê o squad.
  const usados = new Set(steps.map((x) => x.agent).filter(Boolean));
  const party = join(dir, 'squad-party.csv');
  if (existsSync(party)) {
    for (const linha of readFileSync(party, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1)) {
      const id = parseCsvLine(linha)[0];
      if (id && !usados.has(id)) {
        issues.push(issue('warn', 'agente-sem-step', `"${id}" está no squad-party.csv e nenhum step o aciona — elenco que não entra em cena`));
      }
    }
  }

  // (d) Tier do step contra o frontmatter do agente. O prompt define o mapa —
  // `powerful` vira {opus, xhigh} e `fast` vira {haiku, low} — e diz, com todas
  // as letras, que declarar um e escrever outro faz "o frontmatter mentir".
  // Era regra escrita sem código: um step `powerful` com o agente em `haiku`
  // passava limpo.
  const modeloDoTier = { powerful: 'opus', fast: 'haiku' };
  for (const step of steps.filter((x) => x.tier && x.agent)) {
    const esperado = modeloDoTier[step.tier];
    if (!esperado) continue;
    const arquivo = join(dir, 'agents', `${step.agent}.agent.md`);
    if (!existsSync(arquivo)) continue;
    const fm = extractFrontMatter(readFileSync(arquivo, 'utf8'));
    const model = fm ? escalarDeChave(fm, 'model') : null;
    if (model && model !== 'inherit' && model !== esperado) {
      issues.push(issue('warn', 'tier-do-step-contradiz-o-agente', `${step.id} declara tier "${step.tier}" (o compilador emite model: ${esperado}) e o agente "${step.agent}" traz model: ${model} — o workflow compilado e o arquivo do agente passam a dizer coisas diferentes sobre o mesmo step`));
    }
  }
}

/**
 * Gate 3 (parte mecânica) — `inputFile` sob `output/` que nenhum step anterior
 * produz em `outputFile`. Lê o frontmatter dos ARQUIVOS de step, onde o
 * Arquiteto grava os dois campos. Só o caso inequívoco: arquivo de `output/`
 * sem produtor em lugar nenhum; ler o output de um step mais antigo é legítimo.
 */
/**
 * Caminho de artefato normalizado a partir de `output/`. O prefixo
 * `squads/{code}/` varia entre o pipeline.yaml e o frontmatter do step, e
 * comparar as duas formas cruas fabricava divergência onde não havia.
 */
const desdeOutput = (caminho) => String(caminho).slice(Math.max(0, String(caminho).search(/(^|\/)output\//)))
  .replace(/^\//, '');

/** `inputFile` declarado no frontmatter do arquivo de step, se houver. */
function inputFileDoStep(dir, step) {
  const caminho = step.file ? join(dir, 'pipeline', step.file) : null;
  if (!caminho || !existsSync(caminho)) return null;
  const fm = extractFrontMatter(readFileSync(caminho, 'utf8'));
  return fm ? escalarDeChave(fm, 'inputFile') : null;
}

/** `outputFile` declarado no frontmatter do arquivo de step, se houver. */
function outputFileDoStep(dir, step) {
  const caminho = step.file ? join(dir, 'pipeline', step.file) : null;
  if (!caminho || !existsSync(caminho)) return null;
  const fm = extractFrontMatter(readFileSync(caminho, 'utf8'));
  return fm ? escalarDeChave(fm, 'outputFile') : null;
}

function checarEncadeamentoDeArquivos(dir, steps, issues) {
  // O Arquiteto grava `outputFile` no step; squad escrito à mão declara
  // `output.artifacts` no pipeline.yaml. Os dois produzem arquivo, e o caminho
  // se compara a partir de `output/` — o prefixo `squads/{code}/` varia.
  const produzidos = new Set();
  for (const step of steps) {
    const caminho = step.file ? join(dir, 'pipeline', step.file) : null;
    const fm = caminho && existsSync(caminho) ? extractFrontMatter(readFileSync(caminho, 'utf8')) : null;
    const input = fm ? escalarDeChave(fm, 'inputFile') : null;
    if (input && /(^|\/)output\//.test(input) && !produzidos.has(desdeOutput(input))) {
      issues.push(issue('warn', 'input-sem-produtor', `${step.id}: inputFile "${input}" não é outputFile nem output.artifacts de nenhum step anterior`));
    }
    const output = fm ? escalarDeChave(fm, 'outputFile') : null;
    if (output) produzidos.add(desdeOutput(output));
    for (const artefato of step.artefatos) produzidos.add(desdeOutput(artefato));
  }

  // O espelho de `input-sem-produtor`: arquivo que um step GRAVA e que ninguém
  // lê nem é prometido como entrega. Achado acrescentando um agente a um squad
  // real — o step novo nascia produzindo um artefato que nenhum step a jusante
  // carregava, e o validador aprovava com "✓ estrutura íntegra". É a falha
  // clássica da edição (criar a peça e esquecer de plugá-la), e era justamente
  // a que nenhum gate via.
  // Quem é TERMINAL: nenhum outro step depende dele. O output de um step
  // terminal (a aprovação, a peça pronta) legitimamente não tem leitor — é
  // onde o pipeline acaba. Estar no `output.artifacts` do topo não serve de
  // critério: nesses squads o bloco lista TUDO o que o run grava, inclusive
  // arquivos intermediários, e usá-lo como salvo-conduto calaria o check
  // inteiro.
  const temDependente = new Set(steps.flatMap((o) => o.dependsOn));
  for (const step of steps) {
    const saida = outputFileDoStep(dir, step);
    if (!saida) continue;
    if (!temDependente.has(step.id)) continue;   // terminal: o pipeline acaba aqui
    const chave = desdeOutput(saida);
    const alguemLe = steps.some((o) => {
      if (o.id === step.id) return false;
      const entrada = inputFileDoStep(dir, o);
      if (entrada && desdeOutput(entrada) === chave) return true;
      const caminho = o.file ? join(dir, 'pipeline', o.file) : null;
      if (!caminho || !existsSync(caminho)) return false;
      return readFileSync(caminho, 'utf8').includes(chave);
    });
    if (!alguemLe) {
      issues.push(issue(
        'warn',
        'output-sem-consumidor',
        `${step.id} grava "${chave}" e nenhum outro step o lê — mas algum step depende de ${step.id}, então ele não é o fim do pipeline: o trabalho deste step não chega a ninguém`
      ));
    }
  }
}

/**
 * Gate 4 (parte mecânica) — squad que entrega PEÇA: o step revisor (o que tem
 * `on_reject`) emite veredito parseável, roda isolado, não é o próprio redator,
 * tem teto; alguém aciona o `verificador-citacoes`; a pesquisa marca
 * `[NÃO VERIFICADO]`; ética/sigilo aparece. O que fica para leitura humana é o
 * juízo: princípios específicos, exemplos realistas, best-practice certa.
 */
function checarContratoDePeca(dir, steps, issues) {
  const textos = textosDoSquad(dir, steps);
  const revisores = steps.filter((s) => s.onReject);
  const execucaoDoParty = new Map();
  const partyPath = join(dir, 'squad-party.csv');
  if (existsSync(partyPath)) {
    for (const linha of readFileSync(partyPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(1)) {
      const campos = parseCsvLine(linha);
      if (campos[0]) execucaoDoParty.set(campos[0], (campos[5] || '').trim());
    }
  }
  for (const rev of revisores) {
    const texto = textos.find((t) => t.step?.id === rev.id)?.texto || '';
    if (!/^\s*verdict:/m.test(texto) && !texto.includes('verdict: APPROVE')) {
      issues.push(issue('warn', 'revisao-sem-veredito', `${rev.id}: o step revisor não instrui o bloco \`verdict: APPROVE | REJECT\` + \`fixes:\` — o runner não consegue ler o REJECT`));
    }
    const alvo = steps.find((s) => s.id === rev.onReject);
    if (alvo && alvo.agent && alvo.agent === rev.agent) {
      issues.push(issue('warn', 'revisao-pelo-proprio-autor', `${rev.id} revisa ${alvo.id} com o MESMO agente (${rev.agent}) — o redator não se revisa; use outro agente, em subagente`));
    }
    // Duas fontes declaram como o revisor roda: o `execution` do STEP e a coluna
    // do party. Lendo só o party, um step com `execution: inline` derrubava o
    // isolamento anti-viés em silêncio — a revisão passava a rodar no mesmo
    // contexto do redator e o gate continuava verde.
    const doParty = execucaoDoParty.get(rev.agent) || null;
    const doStep = rev.execucao || null;
    if (doStep && doParty && doStep !== doParty) {
      issues.push(issue('warn', 'revisao-execucao-divergente', `${rev.id}: o step declara execution "${doStep}" e o squad-party.csv diz "${doParty}" para "${rev.agent}" — as duas fontes têm de contar a mesma história, ou não se sabe onde o revisor roda`));
    }
    // Fail-closed: basta UMA das fontes dizer que não é subagente. Com as duas
    // discordando não se sabe onde o revisor roda, e presumir a boa é apostar
    // justamente no isolamento anti-viés, que é o que o gate protege.
    const naoIsolado = [['no step', doStep], ['no squad-party.csv', doParty]]
      .find(([, v]) => v && v !== 'subagent');
    if (rev.agent && naoIsolado) {
      issues.push(issue('warn', 'revisao-nao-isolada', `${rev.id}: o revisor "${rev.agent}" roda "${naoIsolado[1]}" (${naoIsolado[0]}) — revisão é em contexto fresco (execution: subagent)`));
    }
  }
  // O acionamento tem de estar em QUEM REVISA — o step revisor ou o arquivo do
  // agente dele. Procurar a palavra no squad inteiro deixava passar o pior caso
  // possível: provado em campo, UMA menção dentro de um comentário no step de
  // intake — que não revisa nada — satisfazia o gate, com o revisor já sem
  // acionar o verificador, e o `check-squad` respondia "✓ estrutura íntegra".
  // O gate perguntava se a palavra existe em algum arquivo, não se o trabalho é
  // feito por quem tem de fazê-lo.
  const acionaVerificador = (rev) => {
    const doStep = textos.find((t) => t.step?.id === rev.id)?.texto || '';
    const doAgente = rev.agent
      ? (textos.find((t) => t.onde === `agents/${rev.agent}.agent.md`)?.texto || '')
      : '';
    return `${doStep}\n${doAgente}`.includes('verificador-citacoes');
  };
  for (const rev of revisores.filter((r) => !acionaVerificador(r))) {
    issues.push(issue('warn', 'revisao-sem-verificador-citacoes', `${rev.id}: nem o step nem o agente "${rev.agent ?? '(sem agente)'}" acionam o subagente \`verificador-citacoes\` — o APPROVE precisa ficar condicionado ao veredito dele, e citá-lo noutro step do squad não é acioná-lo aqui`));
  }
  // A marca tem de estar onde a citação NASCE: no step que redige a peça, no
  // agente dele, ou nos steps que o alimentam. Procurá-la no squad inteiro
  // deixava passar o pior caso, provado num build cego: removidos TODOS os
  // marcadores do step de redação, o squad seguiu "✓ estrutura íntegra" porque
  // a palavra sobrevivia noutros arquivos. Num squad cujo design não pediu step
  // de pesquisa — e o `build.prompt.md` manda não criar o que o design não pede
  // —, isso significa peça jurídica gerada sem disciplina de citação nenhuma,
  // aprovada pelo validador.
  // Quem escreve a citação na peça é o REDATOR. Ter a marca num step que o
  // alimenta é bom e não basta: a instrução tem de estar onde a citação é
  // escrita, que é o step de redação ou o arquivo do agente dele. É a mesma
  // regra do `build.prompt.md` ("nenhuma tese sem citação vinda da pesquisa;
  // nada citado de memória" está no Step de REDAÇÃO) e a mesma correção que o
  // gate do `verificador-citacoes` recebeu.
  const naCadeia = new Set();
  for (const rev of revisores) {
    const redacao = steps.find((s) => s.id === rev.onReject);
    if (!redacao) continue;
    for (const id of [redacao.id, ...redacao.dependsOn]) naCadeia.add(id);
  }
  const naCadeiaDeCitacao = textos.filter((t) => (t.step
    ? naCadeia.has(t.step.id)
    // arquivo de agente entra se o agente executa um step da cadeia — é onde o
    // redator recebe a regra, e é lugar legítimo para ela.
    : steps.some((s) => naCadeia.has(s.id) && s.agent && t.onde === `agents/${s.agent}.agent.md`)));
  const ondeProcurar = naCadeiaDeCitacao.length ? naCadeiaDeCitacao : textos;
  if (!ondeProcurar.some((t) => /N[ÃA]O VERIFICADO/.test(t.texto))) {
    issues.push(issue('warn', 'pesquisa-sem-citation-gate', naCadeiaDeCitacao.length
      ? 'nem o step que redige a peça, nem o agente dele, nem os steps que o alimentam mandam marcar `[NÃO VERIFICADO]`/`[DIVERGENTE]` — a marca tem de estar onde a citação nasce; tê-la noutro canto do squad não protege a peça'
      : 'nenhum agente ou step manda marcar `[NÃO VERIFICADO]`/`[DIVERGENTE]` — sem a marca, citação de memória entra na peça sem ser vista'));
  }
  const squadYaml = join(dir, 'squad.yaml');
  const comYaml = existsSync(squadYaml) ? [...textos, { texto: readFileSync(squadYaml, 'utf8') }] : textos;
  if (!comYaml.some((t) => t.texto.includes('etica-oab-sigilo'))) {
    issues.push(issue('warn', 'sem-etica-sigilo', 'nenhum agente, step ou squad.yaml referencia a best-practice `etica-oab-sigilo` — squad de peça carrega dado de cliente'));
  }
}

function issue(severity, code, detail) {
  return { severity, code, detail };
}

/** squad-party.csv cita campos com vírgula — split ingênuo desalinha colunas. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const semAspas = (s) => s.trim().replace(/^["']|["']$/g, '');

/** Ids do squad-party.csv. Ausente → `[]`: quem cobra a ausência do party é a checagem própria dele. */
function idsDeAgente(dir) {
  const partyPath = join(dir, 'squad-party.csv');
  if (!existsSync(partyPath)) return [];
  return readFileSync(partyPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(1)
    .map((linha) => parseCsvLine(linha)[0])
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// chefe: — os campos, venham do estilo bloco ou do flow
// ---------------------------------------------------------------------------

/**
 * Campos aceitos em `chefe:`. `id` segue aceito e guardado pelo erro de
 * colisão apesar de nenhum consumidor lê-lo hoje (débito D1 de
 * CHEFE-DE-SQUAD.md — removê-lo é decisão de produto, não deste validador).
 * `autonomia_max` é o teto do contrato de autonomia M0–M4 (MIKE-CHEFE §3):
 * squad conservador trava o chefe abaixo do default.
 */
const CAMPOS_DE_CHEFE = new Set(['nome', 'icon', 'id', 'autonomia_max']);

/**
 * Case-sensitive de propósito: aceitar `m1` criaria um segundo jeito de
 * escrever o mesmo nível e todo leitor do campo teria de normalizar para
 * sempre — mais barato recusar na porta, com warn que ensina a forma certa.
 */
const AUTONOMIA_MAX_VALIDA = /^M[0-4]$/;

/**
 * Estilo bloco: cada linha indentada `chave: valor` do bloco capturado. O
 * comentário inline sai do valor via `stripComment` (frontmatter.js) — sem
 * isso, o exemplo verbatim do runner.pipeline.md (`autonomia_max: "M1"  # …`)
 * ganhava warn falso, e um `# nota` depois de `id:`/`nome:` suprimia a colisão
 * de id e o `chefe-sem-nome`. As exceções do YAML são as da casa: `#` sem
 * espaço antes é valor, `#` dentro de aspas é valor.
 */
function camposDeChefeDoBloco(bloco) {
  return [...bloco.matchAll(/^[ \t]+([A-Za-z_][\w-]*):[ \t]*(.*)$/gm)]
    .map((m) => ({ chave: m[1], valor: stripComment(m[2]) }));
}

/**
 * Estilo flow (`{nome: "Helena", icon: "🎩"}`): parser mínimo, sem lib YAML
 * (regra da casa — a mesma natureza do parseScalar/parseList do resto do
 * motor). Devolve os campos ou `null` quando não dá para ler com SEGURANÇA —
 * item sem `chave:`, aspas sem fechar, `}` que não fecha, aninhamento (os
 * campos do chefe são escalares; `{`/`[` interno é forma que este parser não
 * sabe ler). Sem meio-termo deliberadamente: meia-leitura validaria campo
 * errado, e o chamador converte o `null` em warn — nunca de novo em silêncio.
 */
function camposDeChefeDeFlow(inline) {
  if (!inline.startsWith('{')) return null;

  // Fecha o `{` respeitando aspas; depois do `}` só sobra espaço ou comentário.
  let aspas = null;
  let fim = -1;
  for (let i = 1; i < inline.length; i++) {
    const c = inline[i];
    if (aspas) {
      if (c === aspas) aspas = null;
    } else if (c === '"' || c === "'") {
      aspas = c;
    } else if (c === '{' || c === '[') {
      return null;
    } else if (c === '}') {
      fim = i;
      break;
    }
  }
  if (fim < 0) return null;
  const resto = inline.slice(fim + 1).trim();
  if (resto && !resto.startsWith('#')) return null;

  const interior = inline.slice(1, fim);
  if (!interior.trim()) return []; // `chefe: {}` — mapa vazio, nada a validar

  // Separa por vírgulas FORA de aspas — `nome: "Braga, Helena"` é um campo só.
  const partes = [];
  let atual = '';
  aspas = null;
  for (const c of interior) {
    if (aspas) {
      if (c === aspas) aspas = null;
      atual += c;
    } else if (c === '"' || c === "'") {
      aspas = c;
      atual += c;
    } else if (c === ',') {
      partes.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  partes.push(atual);

  const campos = [];
  for (const parte of partes) {
    const m = parte.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!m) return null; // item sem cara de `chave: valor` — flow ilegível
    campos.push({ chave: m[1], valor: m[2] });
  }
  return campos;
}

/**
 * As regras de `chefe:`, indiferentes ao estilo de YAML que as trouxe — era
 * exatamente a diferença de tratamento entre estilos que fazia o flow passar
 * em silêncio. Chave repetida segue o leitor de antes: a primeira ocorrência
 * vale (era o `.match` first-match), e cada desconhecida avisa por ocorrência.
 */
function validarCamposDeChefe(campos, dir, issues) {
  const primeiro = new Map();
  for (const { chave, valor } of campos) {
    // Campo desconhecido em `chefe:` é typo silencioso — o leitor simplesmente
    // o ignora, e o autor jura que configurou. Warn, não error: o run funciona
    // (herda o padrão), só não do jeito que o autor pensou.
    if (!CAMPOS_DE_CHEFE.has(chave)) {
      issues.push(issue(
        'warn',
        'chefe-campo-desconhecido',
        `chefe.${chave} não é um campo reconhecido (aceitos: nome, icon, id, autonomia_max) — será ignorado`
      ));
      continue;
    }
    if (!primeiro.has(chave)) primeiro.set(chave, valor);
  }

  // Omitir `nome` é legítimo — herda o padrão. Declarar `nome: ""` NÃO é
  // omitir: é dizer "o chefe se chama nada", e a declaração explícita
  // suprime o padrão. O run ganharia uma voz sem nome, que é pior do que
  // não ter declarado. Só reprova quando a chave está PRESENTE e vazia.
  const nome = primeiro.get('nome');
  if (nome !== undefined && !nome.replace(/["']/g, '').trim()) {
    issues.push(issue(
      'error',
      'chefe-sem-nome',
      'chefe declarado com `nome` vazio — omita a chave para herdar o padrão, ou dê um nome de verdade'
    ));
  }

  const icon = primeiro.get('icon');
  if (icon !== undefined && !icon.replace(/["']/g, '').trim()) {
    issues.push(issue(
      'warn',
      'chefe-icon-vazio',
      'chefe declarado com `icon` vazio — omita a chave para herdar o padrão (🎩)'
    ));
  }

  // Teto de autonomia inválido é warn, nunca error (MIKE-CHEFE §3): o run não
  // quebra — o runner ignora o que não reconhece e o chefe fica no default —,
  // mas quem escreveu `m1` achando que travou o teto precisa saber que NÃO travou.
  const autonomia = primeiro.get('autonomia_max');
  if (autonomia !== undefined && !AUTONOMIA_MAX_VALIDA.test(semAspas(autonomia))) {
    issues.push(issue(
      'warn',
      'chefe-autonomia-invalida',
      `chefe.autonomia_max "${semAspas(autonomia)}" não é um nível válido — aceitos: M0, M1, M2, M3 ou M4 `
        + '(string, case-sensitive); sem o campo, o default é M2 (gerir o ciclo dentro dos tetos)'
    ));
  }

  const chefeId = semAspas(primeiro.get('id') ?? '');
  if (chefeId && idsDeAgente(dir).includes(chefeId)) {
    issues.push(issue(
      'error',
      'chefe-colide-com-agente',
      `chefe usa o id "${chefeId}", que já é de um agente do party — o handoff deixaria de dizer quem falou e quem produziu`
    ));
  }
}

// ---------------------------------------------------------------------------
// Frontmatter de EXECUÇÃO dos agentes: model / effort / maxTurns (MIKE-CHEFE §5)
// ---------------------------------------------------------------------------

/**
 * Vocabulários que o harness aceita no frontmatter de subagente. Não são
 * invenção deste validador: `model:` e `effort:` são campos de plataforma
 * (MIKE-CHEFE §2, "Frontmatter de subagente", GA), e é o harness — não o
 * runner em prosa — quem os OBRIGA. Aqui só se confere que o Arquiteto
 * escreveu um valor que existe.
 *
 * `inherit` é modelo válido de propósito: o agente que não tem razão para
 * fixar modelo herda o da sessão, e dizer isso explicitamente é diferente de
 * esquecer o campo.
 *
 * Os dois níveis que o compilador emite (`tools/compilar-workflow.mjs`:
 * `powerful` → `{opus, xhigh}`, `fast` → `{haiku, low}`) são subconjunto
 * destes vocabulários — se divergissem, o workflow compilado e o frontmatter
 * do agente diriam coisas diferentes sobre o mesmo squad.
 */
const MODELOS_DE_AGENTE = ['opus', 'sonnet', 'haiku', 'fable', 'inherit'];
const EFFORTS_DE_AGENTE = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Confere `model:`, `effort:` e `maxTurns:` no frontmatter de cada agente do
 * squad. Três regras, uma régua só:
 *
 * - **Ausência NUNCA reprova.** Herdar é legítimo e é o default da doc: o
 *   agente sem `model:` roda no modelo da sessão. Exigir os campos obrigaria
 *   todo squad a repetir a mesma linha — o oposto de ter um padrão (mesma
 *   régua de `chefe.nome`).
 * - **Valor fora do vocabulário é warn, nunca error** (mesma régua de
 *   `chefe-autonomia-invalida`): o run não quebra — o harness ignora o que
 *   não reconhece e o agente cai no default —, mas quem escreveu `Opus`
 *   achando que subiu o modelo precisa saber que NÃO subiu.
 * - **Case-sensitive de propósito.** Aceitar `Opus`/`HIGH` criaria um segundo
 *   jeito de escrever o mesmo valor e todo leitor teria de normalizar para
 *   sempre — mais barato recusar na porta, com warn que ensina a forma certa.
 *
 * Só o frontmatter é lido (`extractFrontMatter`): `model:` na PROSA do agente
 * é texto do autor, não configuração, e chave aninhada é indentada — o `^` do
 * regex já a deixa de fora.
 */
function checarExecucaoDosAgentes(dir, issues) {
  for (const arquivo of arquivosDeAgente(dir)) {
    const fm = extractFrontMatter(readFileSync(arquivo, 'utf8'));
    if (!fm) continue; // agente sem frontmatter: quem cobra isso é o Build
    const onde = basename(arquivo);

    // Declarar a chave VAZIA (`model:`) não é omiti-la: é dizer "o modelo
    // deste agente é nada". Cai no warn junto com o valor inválido — a mesma
    // distinção que `chefe-icon-vazio` faz entre omitir e zerar.
    const model = escalarDeChave(fm, 'model');
    if (model !== null && !MODELOS_DE_AGENTE.includes(model)) {
      issues.push(issue(
        'warn',
        'agente-model-invalido',
        `${onde}: model "${model}" não é um modelo válido — aceitos: ${MODELOS_DE_AGENTE.join(', ')} `
          + '(minúsculas, case-sensitive); sem o campo, o agente herda o modelo da sessão'
      ));
    }

    const effort = escalarDeChave(fm, 'effort');
    if (effort !== null && !EFFORTS_DE_AGENTE.includes(effort)) {
      issues.push(issue(
        'warn',
        'agente-effort-invalido',
        `${onde}: effort "${effort}" não é um nível válido — aceitos: ${EFFORTS_DE_AGENTE.join(', ')} `
          + '(minúsculas, case-sensitive); sem o campo, o agente herda o esforço da sessão'
      ));
    }

    // `maxTurns` é a cerca INTERNA de cada agente — complementa, não substitui,
    // `max_review_cycles`/`max_citation_cycles`, que contam ciclos ENTRE
    // agentes e já são determinísticos no squad-state.mjs. Duas cercas, níveis
    // diferentes: por isso um `maxTurns` ilegível não pode passar em silêncio
    // achando que "o teto do loop cobre".
    const maxTurns = escalarDeChave(fm, 'maxTurns');
    if (maxTurns !== null && !/^\d+$/.test(maxTurns)) {
      issues.push(issue(
        'warn',
        'agente-maxturns-invalido',
        `${onde}: maxTurns "${maxTurns}" não é um inteiro positivo — use um inteiro >= 1; sem o campo, o agente `
          + 'não tem cerca interna (os tetos max_review_cycles/max_citation_cycles contam ciclos ENTRE agentes, não turnos dentro de um)'
      ));
    } else if (maxTurns !== null && Number(maxTurns) < 1) {
      // `maxTurns: 0` casa o regex de inteiro e seria aceito em silêncio — um
      // teto de zero turno é um agente que não executa nenhum.
      issues.push(issue(
        'warn',
        'agente-maxturns-invalido',
        `${onde}: maxTurns "${maxTurns}" não é um inteiro positivo — um teto de zero turno é um agente que nunca age; `
          + 'use um inteiro >= 1, ou omita o campo para não ter cerca interna'
      ));
    }
  }
}

/**
 * Recorta o corpo de `steps:` até a próxima chave de topo. Sem isso, o bloco do
 * ÚLTIMO step ia até o fim do arquivo e engolia `checkpoints:` e o `output:`
 * do pipeline — o que faria a leitura de artefatos por step atribuir ao último
 * step a lista de entregas do squad inteiro.
 */
function secaoSteps(pipeline) {
  const inicio = pipeline.search(/^steps:[ \t]*$/m);
  if (inicio < 0) return pipeline; // pipeline sem a chave: mantém o comportamento antigo
  const resto = pipeline.slice(inicio);
  const corpo = resto.slice(resto.indexOf('\n') + 1);
  const fim = corpo.search(/^\S/m);
  return fim < 0 ? corpo : corpo.slice(0, fim);
}

/** Aceita as três formas de lista YAML que o formato admite. */
function parseListaDeStep(bloco, chave) {
  const inline = bloco.match(new RegExp(`^ {4}${chave}:[ \\t]+(.+)$`, 'm'));
  if (inline) {
    const valor = inline[1].trim();
    if (valor.startsWith('[')) {
      return valor.replace(/^\[|\]$/g, '').split(',').map(semAspas).filter(Boolean);
    }
    return [semAspas(valor)].filter(Boolean);
  }
  const emBloco = bloco.match(new RegExp(`^ {4}${chave}:[ \\t]*\\n((?: {6}- .*\\n)+)`, 'm'));
  if (!emBloco) return [];
  return [...emBloco[1].matchAll(/^ {6}- (.+)$/gm)].map((m) => semAspas(m[1])).filter(Boolean);
}

/** `output.artifacts` de um step (indentação 4/6/8). */
// `stripComment` antes de `semAspas`: `- output/carta.md  # só no caminho "declinar"`
// é o MESMO artefato que `- output/carta.md` no topo do pipeline. Sem o strip,
// o validador acusava `artefato-sem-produtor` num squad correto — e o comentário
// é exatamente o lugar onde o autor explica o caminho condicional.
/**
 * O id ESTÁ no arquivo, mas não foi lido como step.
 *
 * `parseSteps` ancora nas colunas do template (`  - id:`, campos em 4). Ali a
 * indentação é estrutural — afrouxá-la faria o parser casar conteúdo aninhado —
 * então ela fica. O que não podia ficar era a MENSAGEM: um step escrito noutra
 * coluna some da lista, e os checks de grafo o acusavam de "não é um step"
 * quando ele está no arquivo, escrito, à vista. O validador segue reprovando
 * (certo: o que ele não lê, o runner também não roda), mas agora nomeia a causa
 * que observou em vez de imputar ao autor uma omissão que não houve. É a mesma
 * regra de `success-criteria-insuficiente` e do acervo: "não sei ler" jamais se
 * apresenta como "não existe".
 */
function porqueNaoEhStep(pipeline, id, sufixo = 'não é um step') {
  const escapado = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noArquivo = new RegExp(`^[ \\t]*- id:[ \\t]+["']?${escapado}["']?[ \\t]*$`, 'm').test(pipeline);
  return noArquivo
    ? `"${id}" aparece como \`- id:\` no pipeline.yaml mas não foi lido como step — confira a indentação (o item entra com 2 espaços e os campos dele com 4)`
    : `"${id}" ${sufixo}`;
}

function parseArtefatosDoStep(bloco) {
  // `(?:\n|$)`: o bloco de um step vem do slice de `parseSteps`, que para ANTES
  // do `\n  - id:` seguinte — sem linha em branco entre steps, a última linha
  // do bloco não tem `\n`, e exigir `\n` perdia exatamente o último artefato.
  const m = bloco.match(/^ {4}output:[ \t]*\n {6}artifacts:[ \t]*\n((?: {8}- .*(?:\n|$))+)/m);
  if (!m) return [];
  return [...m[1].matchAll(/^ {8}- (.+)$/gm)].map((linha) => semAspas(stripComment(linha[1]))).filter(Boolean);
}

/** `output.artifacts` do pipeline (indentação 0/2/4) — o que o squad promete entregar. */
function parseArtefatosDoPipeline(pipeline) {
  const m = pipeline.match(/^output:[ \t]*\n {2}artifacts:[ \t]*\n((?: {4}- .*(?:\n|$))+)/m);
  if (!m) return [];
  return [...m[1].matchAll(/^ {4}- (.+)$/gm)].map((linha) => semAspas(stripComment(linha[1]))).filter(Boolean);
}

function parseSteps(pipeline) {
  const secao = secaoSteps(pipeline);
  const ids = [...secao.matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]);

  return ids.map((id) => {
    const start = secao.indexOf(`  - id: ${id}\n`);
    const next = secao.indexOf('\n  - id:', start + 1);
    const bloco = secao.slice(start, next < 0 ? undefined : next);

    return {
      id,
      tipo: bloco.match(/^ {4}type: (\S+)\s*$/m)?.[1] || '',
      file: bloco.match(/^ {4}file: (\S+)\s*$/m)?.[1] || null,
      agent: bloco.match(/^ {4}agent: (\S+)\s*$/m)?.[1] || null,
      format: bloco.match(/^ {4}format: (\S+)\s*$/m)?.[1] || null,
      execucao: bloco.match(/^ {4}execution: (\S+)\s*$/m)?.[1] || null,
      tier: bloco.match(/^ {4}model(?:_tier)?: (\S+)\s*$/m)?.[1] || null,
      // Indentação livre e aspas aceitas — o mesmo racional de
      // `metaVerifiersDoPipeline`: on_reject lido é caminho de SUPRESSÃO do
      // warn `redacao-sem-on-reject`, e exigir coluna 4 exata (ou um único
      // espaço após os dois-pontos) fabricava falso positivo em quem declarou.
      // As aspas saem AQUI, para o cross-check de `on-reject-invalido`
      // comparar o id de verdade em vez de `"step-05"` com aspas.
      onReject: semAspas(bloco.match(/^[ \t]+on_reject:[ \t]+(\S+)\s*$/m)?.[1] ?? '') || null,
      dependsOn: parseListaDeStep(bloco, 'depends_on'),
      parallelGroup: bloco.match(/^ {4}parallel_group: (\S+)\s*$/m)?.[1] || null,
      artefatos: parseArtefatosDoStep(bloco),
    };
  });
}

/**
 * Devolve um ciclo no grafo de dependências, ou `null`. DFS com cores: cinza =
 * na pilha atual (aresta de retorno = ciclo), preto = subárvore já fechada.
 */
function acharCiclo(steps) {
  const porId = new Map(steps.map((s) => [s.id, s]));
  const cor = new Map();
  const pilha = [];

  function visitar(id) {
    if (cor.get(id) === 'preto') return null;
    if (cor.get(id) === 'cinza') return [...pilha.slice(pilha.indexOf(id)), id];
    cor.set(id, 'cinza');
    pilha.push(id);
    for (const dep of porId.get(id)?.dependsOn || []) {
      if (!porId.has(dep)) continue; // referência inválida já é reportada à parte
      const ciclo = visitar(dep);
      if (ciclo) return ciclo;
    }
    pilha.pop();
    cor.set(id, 'preto');
    return null;
  }

  for (const step of steps) {
    const ciclo = visitar(step.id);
    if (ciclo) return ciclo;
  }
  return null;
}

/**
 * Paradas humanas (PLANO-ORQUESTRADOR.md, Fase 1): um squad de entrega jurídica
 * para o profissional três vezes — `intake`, `diagnostico`, `aprovacao` — mais
 * o checkpoint imediatamente antes de um ato irreversível (protocolar, enviar).
 * É aviso, não erro: squads já desenhados continuam válidos; o desenho novo é
 * cobrado no build.prompt e explicado no runner (`type: checkpoint`).
 */
const NOME_CANONICO_DE_PARADA = /intake|diagn[oó]stico|aprova[cç][aã]o/i;
const ATO_IRREVERSIVEL = /protocol|envi[oa]|enviar|e-?mail|publica|transmit|peticionament|assinatur/i;

export function checarParadasHumanas(steps) {
  const lista = Array.isArray(steps) ? steps : [];
  const issues = [];
  const checkpoints = [];
  lista.forEach((step, i) => {
    if (!step || step.tipo !== 'checkpoint') return;
    const proximo = lista[i + 1];
    const alvo = proximo ? `${proximo.id} ${proximo.agent || ''} ${proximo.file || ''}` : '';
    // O nome canônico pode estar no id (`step-03-diagnostico`) ou no arquivo do
    // step (`steps/step-09-aprovacao-final.md`) — os dois são o nome da parada.
    checkpoints.push({
      id: step.id,
      nome: `${step.id} ${step.file || ''}`,
      preIrreversivel: !!(proximo && ATO_IRREVERSIVEL.test(alvo)),
    });
  });
  if (!checkpoints.length) return issues;
  const paradas = checkpoints.filter((c) => !c.preIrreversivel);
  if (paradas.length > 3) {
    issues.push(issue(
      'warn',
      'paradas-humanas-excedidas',
      `${paradas.length} paradas humanas além do pré-irreversível (${paradas.map((c) => c.id).join(', ')}) — o desenho é três: intake, diagnostico, aprovacao (runner, type: checkpoint)`
    ));
  }
  if (!checkpoints.some((c) => NOME_CANONICO_DE_PARADA.test(c.nome))) {
    issues.push(issue(
      'warn',
      'paradas-sem-nome-canonico',
      `nenhum checkpoint com nome canônico (intake, diagnostico, aprovacao): ${checkpoints.map((c) => c.id).join(', ')}`
    ));
  }
  return issues;
}

// `- step-01  # Carteira/critério: OAB, processos, período` é o formato em que os
// squads de pacote explicam cada parada. Sem `stripComment`, a linha não casava,
// a lista vinha vazia e todo squad instalado de pacote recebia `sem-checkpoint`
// — "nenhum checkpoint humano declarado" — tendo três.
function parseCheckpoints(pipeline) {
  const bloco = pipeline.match(/^checkpoints:\s*\n((?: {2}- .*(?:\n|$))*)/m);
  if (!bloco) return [];
  return [...bloco[1].matchAll(/^ {2}- (.+)$/gm)].map((m) => semAspas(stripComment(m[1]))).filter(Boolean);
}

/**
 * Valida um squad. Nunca lança: problemas viram `issues` com severidade.
 * `ok` é falso quando há ao menos um `error` — é o que o CLI usa como exit code.
 */
/**
 * Resolve o alvo: nome de squad (`demo-squad`) OU caminho para a pasta dele.
 *
 * Concatenar cegamente depois de `squads/` fabricava caminhos absurdos
 * (`…/squads/Users/fulano/…`) e reportava "não existe" — fail-closed, mas
 * mentindo sobre a causa: o squad existia, o que não existia era o caminho que
 * o próprio validador inventou. Um caminho só ganha quando aponta para um
 * diretório de verdade; fora isso, o nome sob `squads/` continua sendo a regra,
 * e nome inexistente segue reportando o caminho canônico (que é onde o usuário
 * precisa olhar).
 */
function resolverDiretorio(squad, squadsDir) {
  const alvo = String(squad || '');
  if ((isAbsolute(alvo) || alvo.includes('/') || alvo.includes(sep)) && existsSync(alvo)) {
    return resolve(alvo);
  }
  return join(squadsDir, alvo);
}

/**
 * Pontas por tipo de entrega (PLANO-ORQUESTRADOR.md, Fase 7; ENTREGA.md §4).
 * O `reader:` do squad.yaml diz quem lê a peça e decide qual gate de
 * qualidade roda depois do Redação Gate: `juiz` (peça) e `cliente` (parecer)
 * pagam a sobrevivência ao resumo (4.6); `contraparte` (contrato) paga a
 * consistência interna (4.7, verifica-contrato). Sem reader, é juiz.
 */
export const READERS = ['juiz', 'contraparte', 'cliente'];

export function readerDoSquad(y) {
  const m = String(y || '').match(/^reader:[ \t]*["']?([a-zA-Z]+)/m);
  return m ? m[1].toLowerCase() : null;
}

export function gatesPorTipo({ entregaPeca, reader } = {}) {
  if (!entregaPeca) return ['meta', 'veto'];
  const r = READERS.includes(reader) ? reader : 'juiz';
  return r === 'contraparte'
    ? ['citacao', 'redacao', 'contrato', 'meta', 'veto']
    : ['citacao', 'redacao', 'persuasao', 'meta', 'veto'];
}

export function checkSquad(squad, options = {}) {
  const squadsDir = options.squadsDir || squadsDirPadrao();
  const skillsDir = options.skillsDir || skillsDirPadrao(squadsDir);
  let reader = 'juiz';
  let gates = gatesPorTipo({ entregaPeca: false, reader });
  const bestPracticesDir = options.bestPracticesDir || bestPracticesDirPadrao(squadsDir);
  const dir = resolverDiretorio(squad, squadsDir);
  const issues = [];
  const resultado = () => ({
    squad,
    dir,
    ok: !issues.some((i) => i.severity === 'error'),
    reader,
    gates,
    issues,
  });

  if (!existsSync(dir)) {
    issues.push(issue('error', 'squad-nao-encontrado', `${dir} não existe`));
    return resultado();
  }

  // --- squad.yaml: identidade e rubrica ---
  const squadYamlPath = join(dir, 'squad.yaml');
  // Lido UMA vez e reusado até o fim da função: os checks de peça lá embaixo
  // recebiam `dir` e reliam o squad.yaml (4ª e 5ª leituras na mesma chamada).
  // `null` = arquivo ausente.
  let y = null;
  if (!existsSync(squadYamlPath)) {
    issues.push(issue('error', 'squad-yaml-ausente', 'squad.yaml não existe'));
  } else {
    y = readFileSync(squadYamlPath, 'utf8');

    // O seed que o `init` instala declara `status: "placeholder"` e traz SÓ o
    // squad.yaml — sem goal, party, pipeline nem _evals, de propósito. Sem
    // reconhecê-lo, a primeira coisa que um usuário novo faz (`check-squad
    // demo-squad`) devolvia quatro erros sobre um arquivo escrito pelo próprio
    // motor, que se descreve como placeholder na linha 12. Um validador que
    // acusa o que o instalador acabou de pôr ali ensina, na primeira lição, que
    // o vermelho dele não quer dizer nada.
    if (/^status:\s*["']?placeholder["']?\s*$/m.test(y)) {
      issues.push(issue(
        'warn',
        'squad-placeholder',
        'este é o squad-semente que o `init` instala (status: placeholder): só o squad.yaml, sem pipeline nem party — não é para rodar nem para validar. `npx legalsquad update` o substitui pelo exemplo completo'
      ));
      return resultado();
    }

    const code = y.match(/^code:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
    if (!code) {
      issues.push(issue('error', 'code-ausente', 'squad.yaml sem campo code'));
    } else if (code !== basename(dir)) {
      // O dashboard casa squad por `code`; divergência quebra o handoff. Compara
      // com o NOME DA PASTA resolvida, não com o argumento cru: quando o alvo
      // vem como caminho, o argumento é `a/b/demo-squad` e o `code` legítimo
      // (`demo-squad`) apareceria como divergente.
      issues.push(issue('error', 'code-divergente', `code "${code}" != pasta "${basename(dir)}"`));
    }

    const goal = y.match(/^goal:\s*["']?([^"'\n]*)["']?\s*$/m)?.[1]?.trim();
    if (!goal) {
      issues.push(issue('error', 'goal-ausente', 'goal vazio ou ausente — o runner não tem meta a verificar'));
    }

    // --- chefe: a VOZ do run ---
    // Todo squad tem chefe; `chefe:` só existe para TROCAR o padrão — Mike
    // (🎩), definido em prosa na seção "O chefe do squad — a voz do run" do
    // runner.pipeline.md — espelhado em código por `CHEFE_PADRAO`
    // (src/chefe-briefing.js). Por isso `nome` ausente não é erro: exigi-lo
    // obrigaria todo squad a repetir a mesma linha, que é o oposto de ter um
    // padrão. Quem está no squad-party.csv executa step e ocupa desk no
    // dashboard; o chefe nunca executa — só fala —, então vive aqui.
    //
    // O YAML chega em DOIS estilos, e os dois passam pelas MESMAS regras. O
    // flow (`chefe: {nome: …}`) era pulado inteiro pelo regex de bloco e
    // virava fail-open exatamente no formato do autor apressado: o typo que
    // em bloco ganhava warn passava em silêncio (débito D2, CHEFE-DE-SQUAD.md).
    //
    // O bloco indentado tolera linha em branco INTERNA e termina na primeira
    // linha não-branca em coluna 0 (ou no EOF). Parar na primeira linha em
    // branco deixava todo campo depois dela FORA da validação — um
    // `autonomia_max` inválido escapava sem warn nenhum.
    const chefeDecl = y.match(/^chefe:[ \t]*([^\n]*)(?:\n((?:[ \t]*\n|[ \t]+\S.*\n?)*))?/m);
    if (chefeDecl) {
      const inline = chefeDecl[1].trim();
      if (!inline || inline.startsWith('#')) {
        // Estilo bloco (nada além de comentário após a chave). Bloco vazio é
        // `chefe:` sem campo nenhum — lista vazia, nada a validar.
        validarCamposDeChefe(camposDeChefeDoBloco(chefeDecl[2] || ''), dir, issues);
      } else {
        const campos = camposDeChefeDeFlow(inline);
        if (campos) {
          validarCamposDeChefe(campos, dir, issues);
        } else {
          // Meia-leitura validaria campo errado; silêncio repetiria o D2. Resta
          // dizer que não deu para ler — warn, não error, pela régua dos typos:
          // o run funciona (herda o padrão), só não do jeito que o autor pensou.
          issues.push(issue(
            'warn',
            'chefe-flow-ilegivel',
            `chefe: tem valor na própria linha ("${inline.slice(0, 60)}") num formato que o validador não lê com segurança — `
              + 'nenhum campo foi validado. Use um flow bem formado, `{nome: "...", icon: "..."}`, ou o estilo bloco indentado'
          ));
        }
      }
    }

    // `listaDeTopo` e não um regex próprio: ele lê a lista em bloco com
    // QUALQUER indentação e também a inline (`[a, b, c]`). O regex anterior
    // exigia exatamente dois espaços, e quem escrevesse a mesma lista com
    // quatro — YAML igualmente válido — recebia "0 critério(s); esperado 3–6".
    // O erro estava certo em reprovar e MENTIA na causa: dizia que a rubrica
    // não fora escrita quando ela estava lá, ilegível para este parser. Um
    // validador pode recusar; não pode culpar o autor pelo que ele não fez.
    const criterios = listaDeTopo(y, 'success_criteria').length;
    if (criterios < 3 || criterios > 6) {
      issues.push(issue(
        'error',
        'success-criteria-insuficiente',
        criterios === 0
          ? 'nenhum `success_criteria` legível no squad.yaml; esperado 3–6 — confira se a chave existe e se cada item é uma linha `- …` indentada sob ela (é a rubrica do eval e da Verificação da Meta)'
          : `${criterios} critério(s); esperado 3–6 — é a rubrica do eval e da Verificação da Meta`
      ));
    }
  }

  // --- _evals: o harness nasce com o squad ---
  const scores = join(dir, '_evals', 'scores.md');
  if (!existsSync(scores)) {
    issues.push(issue('error', 'evals-scores-ausente', '_evals/scores.md não existe — sem log não há regressão a detectar'));
  } else if (!/\|\s*Data\s*\|/.test(readFileSync(scores, 'utf8'))) {
    issues.push(issue('error', 'evals-scores-sem-cabecalho', '_evals/scores.md sem o cabeçalho que o eval:resumo parseia'));
  }

  const casosDir = join(dir, '_evals', 'casos');
  const casos = existsSync(casosDir) ? readdirSync(casosDir).filter((f) => f.endsWith('.md')) : [];
  if (casos.length === 0) {
    issues.push(issue('error', 'caso-ouro-ausente', '_evals/casos/ sem nenhum caso — a avaliação não é repetível'));
  }

  // --- squad-party.csv: agentes declarados existem em disco ---
  const partyPath = join(dir, 'squad-party.csv');
  const agentesDoParty = new Set();
  if (!existsSync(partyPath)) {
    issues.push(issue('error', 'party-ausente', 'squad-party.csv não existe'));
  } else {
    const linhas = readFileSync(partyPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (const linha of linhas.slice(1)) {
      const [id, , , , caminho] = parseCsvLine(linha);
      if (!id) continue;
      agentesDoParty.add(id);
      const arquivo = join(dir, (caminho || '').replace(/^\.\//, ''));
      if (caminho && !existsSync(arquivo)) {
        issues.push(issue('error', 'agent-file-ausente', `agente "${id}": ${caminho} não existe`));
      }
    }
  }

  // --- frontmatter de execução dos agentes: model/effort/maxTurns ---
  // Antes do `return` antecipado do pipeline: um squad sem pipeline.yaml ainda
  // tem agentes em disco, e o campo mal escrito neles não deixa de existir só
  // porque outra checagem reprovou primeiro.
  checarExecucaoDosAgentes(dir, issues);
  // Gate 0 e Gates 1/1b do Arquiteto, em código (ver o bloco "Gates estruturais").
  checarNomesDosAgentes(dir, issues);
  checarEstruturaDosAgentes(dir, issues);

  // --- pipeline.yaml: integridade do grafo ---
  const pipelinePath = join(dir, 'pipeline', 'pipeline.yaml');
  if (!existsSync(pipelinePath)) {
    issues.push(issue('error', 'pipeline-ausente', 'pipeline/pipeline.yaml não existe'));
    return resultado();
  }

  const pipeline = readFileSync(pipelinePath, 'utf8');
  const steps = parseSteps(pipeline);
  issues.push(...checarParadasHumanas(steps));

  if (steps.length === 0) {
    issues.push(issue('error', 'pipeline-sem-steps', /^[ \t]*- id:[ \t]/m.test(pipeline)
      ? 'o pipeline.yaml tem linhas `- id:` mas nenhuma foi lida como step — confira a indentação (o item entra com 2 espaços sob `steps:` e os campos dele com 4)'
      : 'nenhum step declarado'));
    return resultado();
  }

  const idsVistos = new Set();
  for (const step of steps) {
    if (idsVistos.has(step.id)) {
      issues.push(issue('error', 'step-id-duplicado', step.id));
    }
    idsVistos.add(step.id);

    if (!step.file) {
      issues.push(issue('error', 'step-sem-file', `${step.id} não declara file:`));
    } else if (!existsSync(join(dir, 'pipeline', step.file))) {
      issues.push(issue('error', 'step-file-ausente', `${step.id}: ${step.file} não existe em disco`));
    }

    if (step.agent && agentesDoParty.size && !agentesDoParty.has(step.agent)) {
      issues.push(issue('error', 'agent-fora-do-party', `${step.id} usa "${step.agent}", ausente do squad-party.csv`));
    }

    if (step.onReject && !steps.some((s) => s.id === step.onReject)) {
      issues.push(issue('error', 'on-reject-invalido', `${step.id}: on_reject ${porqueNaoEhStep(pipeline, step.onReject)}`));
    }
  }

  // --- grafo: depends_on aponta para step real, e o grafo é acíclico ---
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!steps.some((s) => s.id === dep)) {
        issues.push(issue('error', 'depends-on-invalido', `${step.id}: depends_on ${porqueNaoEhStep(pipeline, dep)}`));
      }
    }
  }

  const ciclo = acharCiclo(steps);
  if (ciclo) {
    issues.push(issue(
      'error',
      'depends-on-ciclico',
      `ciclo em depends_on: ${ciclo.join(' → ')} — nenhum desses steps chega a executar`
    ));
  }

  // --- parallel_group: os ramos precisam voltar a se encontrar ---
  const grupos = new Map();
  for (const step of steps) {
    if (!step.parallelGroup) continue;
    if (!grupos.has(step.parallelGroup)) grupos.set(step.parallelGroup, []);
    grupos.get(step.parallelGroup).push(step.id);
  }
  for (const [grupo, membros] of grupos) {
    if (membros.length < 2) {
      issues.push(issue(
        'warn',
        'parallel-group-unitario',
        `parallel_group "${grupo}" tem um único membro (${membros[0]}) — nada a paralelizar`
      ));
      continue;
    }
    const convergencia = steps.some(
      (s) => !membros.includes(s.id) && membros.every((m) => s.dependsOn.includes(m))
    );
    if (!convergencia) {
      issues.push(issue(
        'error',
        'parallel-group-sem-convergencia',
        `parallel_group "${grupo}" (${membros.join(', ')}) não converge: nenhum step depende de todos os membros`
      ));
    }

    // Independência entre irmãos. O `build.prompt.md` define `parallel_group`
    // como "só para `execution: subagent` INDEPENDENTES (sem `depends_on`
    // entre si, sem o mesmo `outputFile`)" — regra escrita e nunca conferida.
    // Um step lendo o output de um irmão do mesmo grupo é corrida: em paralelo,
    // o arquivo pode não existir ainda, e o run falha de forma não determinística
    // (ou pior, lê a versão do run anterior). Achado quebrando um squad real de
    // propósito: as duas avarias passavam com "✓ estrutura íntegra".
    const doGrupo = steps.filter((s) => membros.includes(s.id));
    const saidas = new Map();
    for (const step of doGrupo) {
      for (const irmao of step.dependsOn.filter((d) => membros.includes(d) && d !== step.id)) {
        issues.push(issue(
          'error',
          'parallel-group-com-dependencia-interna',
          `${step.id} declara depends_on "${irmao}", irmão do mesmo parallel_group "${grupo}" — membros do grupo rodam ao mesmo tempo, então esperar por um irmão é corrida, não ordem`
        ));
      }
      const saida = outputFileDoStep(dir, step);
      const chave = saida ? desdeOutput(saida) : null;
      if (!chave) continue;
      if (saidas.has(chave)) {
        issues.push(issue(
          'error',
          'parallel-group-com-saida-colidente',
          `${saidas.get(chave)} e ${step.id} gravam o mesmo outputFile "${chave}" e rodam em paralelo no grupo "${grupo}" — um sobrescreve o outro, e qual vence depende de quem terminar por último`
        ));
        continue;
      }
      saidas.set(chave, step.id);
      const consumidoPorIrmao = doGrupo.find((s) => {
        if (s.id === step.id) return false;
        const entrada = inputFileDoStep(dir, s);
        return entrada && desdeOutput(entrada) === chave;
      });
      if (consumidoPorIrmao) {
        issues.push(issue(
          'error',
          'parallel-group-com-dependencia-interna',
          `${consumidoPorIrmao.id} lê "${chave}", que ${step.id} produz — e os dois são do parallel_group "${grupo}": em paralelo, o arquivo pode não existir quando for lido`
        ));
      }
    }
  }

  // --- output.artifacts: quem promete precisa ter quem produza ---
  const produtorDoArtefato = new Map();
  for (const step of steps) {
    for (const artefato of step.artefatos) {
      const chave = desdeOutput(artefato);
      const anterior = produtorDoArtefato.get(chave);
      if (anterior) {
        issues.push(issue(
          'error',
          'artefato-duplicado',
          `"${artefato}" é declarado por ${anterior} e por ${step.id} — um sobrescreve o outro`
        ));
        continue;
      }
      produtorDoArtefato.set(chave, step.id);
    }
    // `outputFile` do frontmatter também PRODUZ — é assim que o runner grava, e
    // é o campo que o formato de step do `build.prompt.md` manda declarar.
    // `input-sem-produtor`, dez linhas acima no mesmo arquivo, já contava os
    // dois; este check contava só `output.artifacts`. Dois checks do mesmo
    // validador respondendo diferente sobre "quem produz este arquivo" é a
    // mesma dívida que fazia o `check-squad` aprovar squad que o compilador
    // recusava — e aqui o desacordo sai como ERRO, barrando squad correto.
    const saida = outputFileDoStep(dir, step);
    if (saida && !produtorDoArtefato.has(desdeOutput(saida))) {
      produtorDoArtefato.set(desdeOutput(saida), step.id);
    }
  }
  for (const artefato of parseArtefatosDoPipeline(pipeline)) {
    if (!produtorDoArtefato.has(desdeOutput(artefato))) {
      issues.push(issue(
        'error',
        'artefato-sem-produtor',
        `output.artifacts promete "${artefato}", mas nenhum step o declara em output.artifacts nem o grava em outputFile`
      ));
    }
  }

  const checkpoints = parseCheckpoints(pipeline);
  for (const cp of checkpoints) {
    if (!steps.some((s) => s.id === cp)) {
      issues.push(issue('error', 'checkpoint-invalido', `checkpoint ${porqueNaoEhStep(pipeline, cp, 'não existe entre os steps')}`));
    }
  }
  if (checkpoints.length === 0) {
    // Aviso, não erro: um squad puramente analítico pode não ter aprovação
    // humana. Mas um squad que entrega peça sem checkpoint é defeito grave —
    // por isso o alerta existe.
    issues.push(issue('warn', 'sem-checkpoint', 'nenhum checkpoint humano declarado — confirme que é intencional'));
  }

  // --- Gates 2, 1c e 3 do Arquiteto, em código ---
  checarEstruturaDosSteps(dir, steps, issues);
  checarAgentesNoSquadYaml(y, steps, issues);
  checarReusoDeEspecialistas(dir, squadsDir, steps, issues, options.homeDir ?? homedir());
  checarEncadeamentoDeArquivos(dir, steps, issues);
  checarPromessasDoBuild(dir, steps, issues);
  checarComandosDaCli(dir, steps, issues);

  // --- skills declaradas: promessa que ninguém conferia ---
  const skillsDePeca = checarSkillsDeclaradas(dir, skillsDir, issues, steps);

  // --- best-practices declaradas (data:/format:): mesma promessa, mesma dívida ---
  checarBestPracticesDeclaradas(dir, bestPracticesDir, steps, issues);

  // A detecção de peça é UMA — computada uma vez sobre o `y` já em mãos e
  // entregue aos dois checks abaixo (ver `sinaisDeEntregaDePeca`).
  const sinais = y === null ? [] : sinaisDeEntregaDePeca(y, skillsDePeca, textosDoSquad(dir, steps));
  // Pontas por tipo (Fase 7): quem lê a peça decide o gate de qualidade.
  const readerDeclarado = y === null ? null : readerDoSquad(y);
  if (readerDeclarado && !READERS.includes(readerDeclarado)) {
    issues.push(issue('warn', 'reader-desconhecido', `reader: "${readerDeclarado}" — use juiz, contraparte ou cliente (sem reader, é juiz)`));
  }
  reader = READERS.includes(readerDeclarado) ? readerDeclarado : 'juiz';
  gates = gatesPorTipo({ entregaPeca: sinais.length > 0, reader });

  // --- Verificação da Meta: quem entrega peça não devia ter juiz único ---
  checarVotingDaMeta(y, pipeline, sinais, issues);

  // --- Redação Gate: o REJECT precisa de rota de volta declarada ---
  checarOnRejectDeRedacao(sinais, steps, issues);

  // --- Gate 4 do Arquiteto (parte mecânica): só para quem entrega peça ---
  if (sinais.length > 0) checarContratoDePeca(dir, steps, issues);

  return resultado();
}
