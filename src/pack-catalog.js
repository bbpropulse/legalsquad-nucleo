// Extração do catálogo (SPEC §6.1) — a metade FINA do pacote.
//
// Um registro de descoberta por item, separado das entidades de conteúdo. É o
// que o cliente sincroniza sempre, de todos os pacotes, para poder buscar
// localmente sem baixar conteúdo nenhum. Os campos são exatamente os que o
// `search-skills` já devolve e os que o Arquiteto já exige da shortlist — o
// catálogo não introduz conceito novo, só o desacopla do conteúdo.
//
// READ-ONLY sobre as entidades que recebe: o catálogo é derivado, nunca uma
// oportunidade de mexer no conteúdo (ver `promoverNuncaReescreve` abaixo).

import { parseSkillMetadata } from './frontmatter.js';
import { NOME_DE_CATALOGO, parseBestPracticesCatalogText } from './best-practices-catalog.js';

/**
 * Marcadores de contrato de forks anteriores a este motor OU de ferramentas de
 * terceiros que geram um contrato "alta performance"-like próprio (§6.8). O
 * motor só confia no PRÓPRIO vocabulário de promoção — um `quality_status`
 * estrangeiro (ex.: `contracted-reviewed`, do lote de advocacia eleitoral)
 * nunca é `verified`/`certified` literal, então passaria batido sem o
 * marcador do corpo entrar aqui. Cada entrada nova é um produto/fork externo
 * identificado, nunca uma suposição sobre o que "parece" legado.
 */
const MARCADORES_LEGADOS = [
  /CRIMINALSQUAD:HP-CONTRACT/,
  /\bcsq-v5-/,
  /ELEITORAL:HP-CONTRACT/,
  /DTSQUAD:HP-CONTRACT/,
  /TRABALHISTASQUAD:HP-CONTRACT/,
];

/** Status que significam desempenho comprovado — e que exigem evidência local. */
const STATUS_PROMOVIDOS = new Set(['verified', 'certified']);

const LIMITE_DESCRICAO = 220;

function recortar(texto, max = LIMITE_DESCRICAO) {
  const limpo = String(texto || '').replace(/\s+/g, ' ').trim();
  if (limpo.length <= max) return limpo;
  return `${limpo.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/**
 * Por que esta skill não pode sair do build como promovida.
 *
 * Duas razões, e a primeira vale SEMPRE: a evidência comportamental mora em
 * `skills/_evals/results/`, que é user-owned e não viaja no pacote (§6.5). Numa
 * instalação limpa não existe evidência nenhuma — então uma skill que chegasse
 * marcada `verified` hard-falharia no destino, ou pior, seria acreditada.
 * O pacote leva o CONTRATO e os CASOS de eval; a PROVA é local, por construção.
 */
function motivosDeBloqueio(metadata, texto) {
  const motivos = [];
  if (STATUS_PROMOVIDOS.has(metadata.qualityStatus)) {
    motivos.push(
      `declarado "${metadata.qualityStatus}" na origem, sem evidência comportamental no pacote ` +
        '(skills/_evals/results/ é user-owned e não viaja) — promoção exige forward-run local'
    );
  }
  if (MARCADORES_LEGADOS.some((padrao) => padrao.test(texto))) {
    motivos.push(
      'marcador de contrato legado (fork anterior a este motor) — identifica o contrato, ' +
        'nunca promove; o curador reemite a evidência sobre os bytes atuais'
    );
  }
  return motivos;
}

function registroDeSkill(entidade, nomeDaEntidade, id) {
  const metadata = parseSkillMetadata(entidade.text, { fallbackName: id });
  const bloqueios = motivosDeBloqueio(metadata, entidade.text);

  return {
    kind: 'skill',
    id,
    entity: nomeDaEntidade,
    path: entidade.path,
    sha256: entidade.sha256,
    bytes: entidade.bytes,
    description: recortar(metadata.description),
    triggers: metadata.positiveTriggers || [],
    aliases: metadata.aliases || [],
    categories: metadata.categories || [],
    lifecycle: metadata.lifecycle,
    // Capado de propósito. Ver `motivosDeBloqueio`.
    quality_status: bloqueios.length ? 'contracted' : metadata.qualityStatus,
    quality_profile: metadata.qualityProfile,
    risk: metadata.riskLevel,
    delivery_type: metadata.deliveryType,
    // Sempre falso num pacote recém-construído: elegibilidade é recalculada no
    // cliente, depois que existir evidência local.
    high_performance_eligible: false,
    eval_case_ids: metadata.evalCaseIds || [],
    ...(bloqueios.length ? { promotion_blocked_by: bloqueios } : {}),
  };
}

function registroDeSquad(entidade, nomeDaEntidade, id) {
  const descricao = entidade.text?.match(/^description:\s*(.+)$/m)?.[1] || '';
  return {
    kind: 'squad',
    id,
    entity: nomeDaEntidade,
    path: entidade.path,
    sha256: entidade.sha256,
    bytes: entidade.bytes,
    description: recortar(descricao.replace(/^["'>|-]+\s*/, '')),
  };
}

/**
 * `catalogo` é o lookup por id do `_catalog.yaml` da mesma pasta (pode ser
 * `undefined` — best-practice sem catálogo instalado, ou id fora dele). O
 * `whenToUse` é o texto que o Arquiteto já usa pra casar squad↔best-practice;
 * sem ele aqui, o catálogo sincronizável (o que o `sync`/busca local recebe)
 * ficava mais pobre que a leitura direta do `_catalog.yaml` — duas fontes de
 * verdade pra mesma metadata, uma rica e outra capada no título do markdown.
 */
function registroDeBestPractice(entidade, nomeDaEntidade, id, catalogo) {
  const entrada = catalogo?.get(id);
  const titulo = entidade.text?.match(/^#\s+(.+)$/m)?.[1] || id;
  return {
    kind: 'best-practice',
    id,
    entity: nomeDaEntidade,
    path: entidade.path,
    sha256: entidade.sha256,
    bytes: entidade.bytes,
    description: recortar(entrada?.whenToUse || titulo),
    // Só entra quando true — catálogo fino, sem carregar `obrigatoria: false`
    // em toda entrada (mesmo espírito de `promotion_blocked_by` acima).
    ...(entrada?.obrigatoria ? { obrigatoria: true } : {}),
  };
}

/**
 * Agente reutilizável de área — subagente especialista que várias skills/squads
 * da mesma área podem delegar, distinto do agente amarrado a UM squad (esse
 * viaja dentro de `squads/<nome>/agents/` e não passa por aqui). Frontmatter no
 * mesmo formato dos agentes que já vivem no motor (`.claude/agents/*.md`):
 * `description:` de linha única, como em `catalog-scout.md`.
 */
function registroDeAgente(entidade, nomeDaEntidade, id) {
  const descricao = entidade.text?.match(/^description:\s*(.+)$/m)?.[1] || '';
  return {
    kind: 'agent',
    id,
    entity: nomeDaEntidade,
    path: entidade.path,
    sha256: entidade.sha256,
    bytes: entidade.bytes,
    description: recortar(descricao.replace(/^["']|["']$/g, '')),
  };
}

/**
 * Deriva o catálogo a partir das entidades de conteúdo.
 *
 * Só arquivos que são ITENS DESCOBRÍVEIS viram registro: `SKILL.md`,
 * `squad.yaml`, cada best-practice, e cada agente REUTILIZÁVEL de área
 * (`.claude/agents/<id>.md`). Arquivos de apoio (`references/` de uma skill,
 * `agents/*.custom.md` amarrado a UM squad dentro de `squads/<nome>/agents/`,
 * assets) viajam no conteúdo e não poluem o catálogo — é justamente essa razão
 * de tamanho que torna a descoberta local viável.
 *
 * Não muta nada do que recebe: o conteúdo sai daqui byte a byte como entrou.
 */
export function extrairCatalogo(entidades, nomeDaEntidade) {
  const registros = [];

  // Lookup por id. O nome do catálogo NÃO é fixo: `pack-build.js` renomeia
  // `_catalog.yaml` → `_catalog.<area>.yaml` antes daqui, porque N áreas
  // instalam na mesma pasta e o nome fixo fazia a última sobrescrever as
  // anteriores. Casar por nome fixo aqui não acharia nada — e como
  // best-practice órfã cair no título é legítimo, o lookup vazio passaria em
  // silêncio, levando junto o `obrigatoria: true` de TODAS elas. Mesmo regex
  // do leitor da instalação, uma fonte só.
  //
  // Fundir em vez de pegar o primeiro: `find` escolheria um catálogo
  // arbitrário se um dia chegarem dois numa entidade. Ordem estável e primeiro
  // id vence — mesma regra de `parseBestPracticesCatalogDir`.
  const catalogosYaml = entidades
    .filter((e) => {
      const nome = e.path.match(/^_legalsquad\/core\/best-practices\/([^/]+)$/)?.[1];
      return nome ? NOME_DE_CATALOGO.test(nome) : false;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const catalogo = catalogosYaml.length ? new Map() : undefined;
  for (const yaml of catalogosYaml) {
    for (const entrada of parseBestPracticesCatalogText(yaml.text)) {
      if (!catalogo.has(entrada.id)) catalogo.set(entrada.id, entrada);
    }
  }

  for (const entidade of entidades) {
    const skill = entidade.path.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (skill) {
      registros.push(registroDeSkill(entidade, nomeDaEntidade, skill[1]));
      continue;
    }
    const squad = entidade.path.match(/^squads\/([^/]+)\/squad\.yaml$/);
    if (squad) {
      registros.push(registroDeSquad(entidade, nomeDaEntidade, squad[1]));
      continue;
    }
    // Caminho de INSTALAÇÃO (§ pack-build.js SUBARVORES), não o de autoria: o
    // catálogo descreve o que existirá depois de aplicado, não como o curador
    // organizou o diretório de conteúdo.
    const bp = entidade.path.match(/^_legalsquad\/core\/best-practices\/([^/]+)\.md$/);
    if (bp && !bp[1].startsWith('_')) {
      registros.push(registroDeBestPractice(entidade, nomeDaEntidade, bp[1], catalogo));
      continue;
    }
    const agente = entidade.path.match(/^\.claude\/agents\/([^/]+)\.md$/);
    if (agente) {
      registros.push(registroDeAgente(entidade, nomeDaEntidade, agente[1]));
    }
  }

  return registros;
}
