// Digest de UMA skill para a fase de decisão do Arquiteto.
//
// A busca (`search-skills`) é proibida por teste de vazar o corpo — e com
// razão: numa shortlist de 8, corpo inteiro estoura qualquer orçamento. Mas a
// consequência era o Arquiteto decidir REUSAR × ENRIQUECER × CRIAR e a
// atribuição skill↔agente vendo ~300 caracteres de metadata por candidata.
// Este comando é o meio-termo deliberado: para UM finalista por vez, devolve
// a ESTRUTURA do corpo (seções e tamanhos), os sinais de substância jurídica
// (citações, marcadores de não-verificado), o contrato de saída e as listas
// COMPLETAS de gatilhos — o suficiente para julgar aderência a um papel de
// agente sem carregar o arquivo inteiro no contexto.
//
// Leitura O(1): um diretório, dois caminhos possíveis. NUNCA varre o catálogo
// (`discoverSkillCatalog` custa ~1,6s em 4,5k skills — é preço de busca, não
// de inspeção pontual).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFrontMatter, getSkillLifecyclePolicy, parseSkillMetadata } from './frontmatter.js';
import { ehTituloOco, lerSubstanciaDoIndice } from './skill-substancia.js';
import { lerUsoDeSkill } from './skill-uso.js';

const CLIP_SECAO = 6000;
const MARCA_CONTRATO_INICIO = /<!--\s*(?:LEGALSQUAD|CRIMINALSQUAD|DTSQUAD):HP-CONTRACT:START\s*-->/;
const MARCA_CONTRATO_FIM = /<!--\s*(?:LEGALSQUAD|CRIMINALSQUAD|DTSQUAD):HP-CONTRACT:END\s*-->/;

function clip(texto, max = CLIP_SECAO) {
  const t = String(texto || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… [cortado em ${max} caracteres — abra ${'`'}--secao${'`'} menor ou o arquivo]`;
}

function normalizaTitulo(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Corpo = tudo depois do frontmatter. Frontmatter ausente → arquivo inteiro. */
function corpoDe(raw) {
  const m = String(raw).match(/^---\n[\s\S]*?\n---\n?/);
  return m ? raw.slice(m[0].length) : String(raw);
}

/**
 * Seções `##` do corpo, com contagem de linhas de cada uma. Linhas antes da
 * primeira `##` entram como preâmbulo. O bloco HP-CONTRACT é marcado — é
 * maquinário do contrato, não conhecimento autoral, e o leitor precisa saber
 * distinguir os dois ao julgar substância.
 */
function estruturaDe(corpo) {
  const linhas = corpo.split('\n');
  const secoes = [];
  let atual = { secao: '(preâmbulo)', linhas: 0, inicio: 0 };
  let dentroDeContrato = false;
  let linhasDeContrato = 0;

  let fence = null;

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (MARCA_CONTRATO_INICIO.test(linha)) dentroDeContrato = true;
    // Só linhas não-vazias, como `linhas_total` — senão os dois números não
    // são comparáveis e o digest afirma o absurdo "contrato maior que o corpo".
    if (dentroDeContrato && linha.trim()) linhasDeContrato++;
    if (MARCA_CONTRATO_FIM.test(linha)) dentroDeContrato = false;

    // Bloco cercado (``` / ~~~): heading DENTRO do fence é conteúdo do
    // exemplo, não seção autoral — modelo de peça com "## DOS FATOS" no
    // esqueleto é o caso típico das skills deste catálogo. Fecha só com o
    // MESMO marcador que abriu.
    const marcadorDeFence = linha.match(/^\s*(`{3,}|~{3,})/);
    if (marcadorDeFence) {
      // CommonMark: o fecho exige o MESMO caractere e comprimento >= abertura.
      // Normalizar para 3 fazia um ``` aninhado dentro de um ```` fechar o
      // bloco externo — e os headings do exemplo viravam seções autorais.
      if (!fence) fence = marcadorDeFence[1];
      else if (marcadorDeFence[1][0] === fence[0] && marcadorDeFence[1].length >= fence.length) fence = null;
      if (linha.trim()) atual.linhas++;
      continue;
    }
    if (fence) {
      if (linha.trim()) atual.linhas++;
      continue;
    }

    const titulo = linha.match(/^##\s+(.+?)\s*$/);
    if (titulo && !linha.startsWith('###')) {
      if (atual.linhas > 0 || atual.secao !== '(preâmbulo)') secoes.push(atual);
      atual = { secao: titulo[1], linhas: 0, inicio: i };
      continue;
    }
    if (linha.trim()) atual.linhas++;
  }
  if (atual.linhas > 0 || atual.secao !== '(preâmbulo)') secoes.push(atual);
  return { secoes, linhasDeContrato };
}

/** Mapa linha→dentro-de-fence, para heading em bloco cercado não contar como seção. */
function fencesPorLinha(linhas) {
  const dentro = new Array(linhas.length).fill(false);
  let fence = null;
  for (let i = 0; i < linhas.length; i++) {
    const m = linhas[i].match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; dentro[i] = true; continue; }
      dentro[i] = true;
      continue;
    }
    dentro[i] = fence !== null;
  }
  return dentro;
}

/** Conteúdo de uma seção `##` pelo título (casamento sem acento/caixa). */
function conteudoDaSecao(corpo, titulo) {
  const alvo = normalizaTitulo(titulo);
  const linhas = corpo.split('\n');
  const emFence = fencesPorLinha(linhas);
  let inicio = -1;
  for (let i = 0; i < linhas.length; i++) {
    if (emFence[i]) continue;
    const m = linhas[i].match(/^##\s+(.+?)\s*$/);
    if (m && !linhas[i].startsWith('###') && normalizaTitulo(m[1]).includes(alvo)) {
      inicio = i;
      break;
    }
  }
  if (inicio < 0) return null;
  let fim = linhas.length;
  for (let i = inicio + 1; i < linhas.length; i++) {
    if (emFence[i]) continue;
    if (/^##\s/.test(linhas[i]) && !linhas[i].startsWith('###')) { fim = i; break; }
  }
  return linhas.slice(inicio, fim).join('\n');
}

/**
 * Sinais de substância jurídica no corpo. Contagens por REGEX sobre texto que
 * nós conhecemos — mesmo custo-benefício do parsing do índice. São proxies:
 * dizem que a skill CITA direito, não que o cita certo. O julgamento de
 * aderência é do Arquiteto; isto só põe os números na mesa.
 */
function sinaisDe(corpo) {
  const artigos = new Set([...corpo.matchAll(/\bart(?:igo)?s?\.?\s*(\d+(?:\.\d+)*)[ºo°]?(-[A-Z])?/gi)].map((m) => m[1] + (m[2] || '')));
  const sumulas = new Set([...corpo.matchAll(/s[úu]mulas?(?:\s+vinculantes?)?\s*(?:n\.?[ºo°]?\s*)?(\d+)/gi)].map((m) => m[1]));
  const leis = new Set([...corpo.matchAll(/\bleis?\s*(?:n\.?[ºo°]?\s*)?([\d.]{3,}\d)/gi)].map((m) => m[1]));
  const naoVerificado = (corpo.match(/\[N[ÃA]O VERIFICADO/gi) || []).length;
  return {
    artigos_citados: artigos.size,
    sumulas_citadas: sumulas.size,
    leis_citadas: leis.size,
    marcadores_nao_verificado: naoVerificado,
  };
}

export function detailSkill(id, rootDir, options = {}) {
  const idLimpo = String(id || '').trim();
  if (!idLimpo || /[\\/]|\.\./.test(idLimpo)) {
    return { success: false, error: { code: 'detail-id-invalido', message: 'informe um id de skill (nome do diretório, sem barras)' } };
  }
  const skillsDir = join(rootDir, 'skills');
  const localPath = join(skillsDir, idLimpo, 'SKILL.local.md');
  const packPath = join(skillsDir, idLimpo, 'SKILL.md');
  const local = existsSync(localPath);
  const skillPath = local ? localPath : packPath;
  if (!existsSync(skillPath)) {
    return { success: false, error: { code: 'detail-skill-inexistente', message: `skills/${idLimpo}/SKILL.md não existe` } };
  }

  // Mesma normalização de `extractFrontMatter` (frontmatter.js): BOM e CRLF
  // de editor Windows são caso real documentado — sem isto, o frontmatter
  // inteiro vira "corpo" e os gatilhos NEGATIVOS contam como citações do
  // texto (o digest afirmaria substância exatamente onde a skill nega cobrir).
  const raw = readFileSync(skillPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const metadata = parseSkillMetadata(raw, { fallbackName: idLimpo });
  const frontmatter = extractFrontMatter(raw);
  const policy = getSkillLifecyclePolicy(metadata?.lifecycle, { frontmatterLegivel: frontmatter !== null });
  const corpo = corpoDe(raw);
  const { secoes, linhasDeContrato } = estruturaDe(corpo);

  // Substância do índice, quando houver — a mesma fonte da busca, com a mesma
  // semântica de ausência ("não sei", nunca "está oca").
  const indicePath = join(skillsDir, '_index.yaml');
  const substancia = existsSync(indicePath)
    ? lerSubstanciaDoIndice(readFileSync(indicePath, 'utf8')).get(idLimpo)
    : undefined;

  const resultado = {
    success: true,
    id: idLimpo,
    source: local ? 'local' : 'pack',
    lifecycle: policy.lifecycle,
    production_eligible: policy.productionEligible,
    quality_status: metadata?.qualityStatus || 'legacy',
    quality_profile: metadata?.qualityProfile || '',
    risk: metadata?.riskLevel || '',
    delivery_type: metadata?.deliveryType || '',
    freshness_policy: metadata?.freshnessPolicy || '',
    description: String(metadata?.description || '').replace(/\s+/g, ' ').trim(),
    substancia: {
      linhas_proprias: substancia?.linhasProprias ?? null,
      titulo_oco: ehTituloOco(substancia),
      base_legal_verificada: substancia?.baseLegalVerificada === true,
      precedentes_identificados: substancia?.precedentesIdentificados === true,
    },
    // Uso REAL desta instalação: ciclos de revisão fechados com a skill
    // carregada (gravados por squad-state ao aplicar veredito). `null` =
    // nunca medida — diferente de zero. É sinal de cobertura, não de culpa:
    // a skill estava no squad do ciclo, não necessariamente causou o veredito.
    uso: lerUsoDeSkill(rootDir, idLimpo),
    // Listas COMPLETAS — a busca corta em 5/3 por orçamento de shortlist; num
    // digest de finalista único, os gatilhos inteiros são exatamente o que o
    // Arquiteto precisa para cruzar com o papel do agente.
    triggers: {
      positive: metadata?.positiveTriggers || [],
      negative: metadata?.negativeTriggers || [],
      guard: metadata?.guardTriggers || [],
    },
    composicao: {
      aliases: metadata?.aliases || [],
      supersedes: metadata?.supersedes || [],
      coexists: metadata?.coexists || [],
      next_skills: metadata?.nextSkills || [],
      engines: metadata?.engines || [],
      eval_case_ids: metadata?.evalCaseIds || [],
    },
    sinais: {
      linhas_total: corpo.split('\n').filter((l) => l.trim()).length,
      linhas_bloco_contrato: linhasDeContrato,
      ...sinaisDe(corpo),
    },
    estrutura: secoes.map(({ secao, linhas }) => ({ secao, linhas })),
    contrato_de_saida: (() => {
      const c = conteudoDaSecao(corpo, 'contrato de saida');
      return c ? clip(c, 2000) : null;
    })(),
    error: null,
  };

  if (options.secao) {
    const conteudo = conteudoDaSecao(corpo, options.secao);
    resultado.secao = conteudo
      ? { titulo: options.secao, conteudo: clip(conteudo) }
      : { titulo: options.secao, conteudo: null, nota: 'seção não encontrada — confira `estrutura`' };
  }

  return resultado;
}

export function skillDetailCli(id, targetDir, values = {}) {
  const resultado = detailSkill(id, targetDir, { secao: values.secao });
  if (values.json === true) {
    console.log(JSON.stringify(resultado));
    return resultado;
  }
  if (!resultado.success) {
    console.error(`DETALHE_SKILL:BLOQUEADO — ${resultado.error.message}`);
    return resultado;
  }
  const s = resultado.sinais;
  const oco = resultado.substancia.titulo_oco ? ' ⚠ TÍTULO OCO' : '';
  console.log(`DETALHE_SKILL:${resultado.id} (${resultado.source}; ${resultado.lifecycle}; ${resultado.quality_status})${oco}`);
  console.log(`  substância: ${resultado.substancia.linhas_proprias ?? '?'} linhas próprias; corpo ${s.linhas_total} linhas (${s.linhas_bloco_contrato} de contrato)`);
  console.log(`  citações: ${s.artigos_citados} artigo(s), ${s.sumulas_citadas} súmula(s), ${s.leis_citadas} lei(s); ${s.marcadores_nao_verificado} [NÃO VERIFICADO]`);
  console.log(`  gatilhos: +${resultado.triggers.positive.length} / -${resultado.triggers.negative.length} / guard ${resultado.triggers.guard.length}`);
  if (resultado.uso) {
    const u = resultado.uso;
    console.log(`  uso local: ${u.ciclos} ciclo(s) em ${u.squads_distintos} squad(s) — ${u.aprovacoes} APPROVE / ${u.rejeicoes} REJECT; último ${u.ultimo_uso}`);
  } else {
    console.log('  uso local: nunca medida nesta instalação');
  }
  console.log('  estrutura:');
  for (const { secao, linhas } of resultado.estrutura) console.log(`    - ${secao} (${linhas})`);
  if (resultado.secao) {
    console.log(`  seção "${resultado.secao.titulo}":`);
    console.log(resultado.secao.conteudo || `    (${resultado.secao.nota})`);
  }
  return resultado;
}
