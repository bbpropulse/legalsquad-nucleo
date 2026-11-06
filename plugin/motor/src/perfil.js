// Ritmo do run e perfil do projeto: quanto de verificação por LLM cada run paga.
//
// O motor tem os botões há tempo (`citation_verifiers`, teto de ciclos de
// revisão, gate de sobrevivência ao resumo, red-team), mas cada
// squad os declara para si, no máximo. Quem decide quanto tempo a peça pode
// levar é o profissional, e ele decide na parada intake (`ritmo`): rápido,
// equilibrado ou completo. O projeto pode ter um perfil (`legalsquad perfil`,
// para um curso ou uma palestra), que é teto e padrão para todos os runs.
//
// Os hooks determinísticos (Redação Gate, Citation Gate do hook, manifesto) não
// entram aqui: custam zero e não dependem de ritmo. E nenhum ritmo desliga a
// verificação de citações: o mínimo é 1 verificador, sempre. Nem rebaixa os
// avaliadores da Verificação da Meta (`meta_verifiers`): são os do squad.
//
// O arquivo do projeto mora em `_legalsquad/_memory/perfil.json` (preservado
// pelo update); o ritmo do run mora no `run-state.json` (`squad-state ritmo
// --set`). Quem aplica é o CÓDIGO: o `squad-state` lê os dois e rebaixa
// `--max`, `--expect` e `--confirmacoes` ao teto, avisando no stderr, para o
// chefe não precisar lembrar de nada.
//
// A lógica vive no bloco abaixo, copiado VERBATIM para `scripts/squad-state.mjs`
// e `templates/scripts/squad-state.mjs` (guardado por `sync-blocos`); as
// funções usam `readFileSync` e `join`, importados fora do bloco em cada arquivo.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// >>> perfil:begin
const PERFIL_ARQUIVO = ['_legalsquad', '_memory', 'perfil.json'];
const PERFIL_PADRAO = 'completo';
/** Do mais rigoroso ao mais rápido; combinar dois ritmos é ficar com o de menor posto. */
const RITMOS = ['completo', 'equilibrado', 'rapido'];
/** Nomes que o profissional usa e o código aceita como sinônimos. */
const RITMO_ALIASES = { rigoroso: 'completo', padrao: 'equilibrado', light: 'rapido', leve: 'rapido' };
/**
 * Os ritmos: quanto de verificação por LLM o run paga. `null` num botão é "o que
 * o squad declarar"; número é teto; `persuasao`/`red_team` em false desligam o
 * gate e a oferta. O Citation Gate nunca cai abaixo de 1 verificador: a sanção
 * por citação inventada é real, e os hooks determinísticos não têm ritmo.
 * `citation_verifiers` é o teto de verificadores POR GATE (citações e persuasão).
 * `meta_verifiers` é o teto de avaliadores da Verificação da Meta, sobre o que o
 * squad declara: rápido 1, equilibrado 2, rigoroso o que o squad declara, até 3.
 * Decisão do dono depois da medição dos ritmos (0.9.83, due diligence): o rápido
 * pagava 3 vozes na meta (41,6 min, 622k tokens) e tirou 96 com a mesma conferência;
 * a nota baixa dos equilibrados veio de dupla contagem e de memória de cálculo fora
 * do relatório, não do número de avaliadores. Com 2 vozes, o voto que diverge do
 * outro num critério pede desempate (uma voz a mais), como o voto tardio (0.9.82).
 * Não há ajuste por run para este botão: ele segue o ritmo.
 */
// `max_review_cycles` conta ciclos de conferência, não correções: com teto N, o REJECT dos ciclos
// 1 a N-1 volta à redação e o do ciclo N escala. O rápido tem teto 2, uma rodada de correção.
// Medido no m2r da 0.9.83 (due diligence, ritmo rápido): com teto 1, o primeiro REJECT já escalava
// por teto, e os seis pontos do revisor ficaram como ressalva, sem nenhuma correção.
const PERFIS = {
  completo: { citation_verifiers: null, max_review_cycles: null, meta_verifiers: 3, persuasao: true, red_team: true },
  equilibrado: { citation_verifiers: 1, max_review_cycles: 2, meta_verifiers: 2, persuasao: true, red_team: false },
  rapido: { citation_verifiers: 1, max_review_cycles: 2, meta_verifiers: 1, persuasao: false, red_team: false },
};
/** Botões que seguem o ritmo e não têm ajuste por run. */
const SEM_AJUSTE_POR_RUN = new Set(['meta_verifiers']);

/**
 * As três opções do ritmo como o chefe as diz ao profissional no intake: o porquê com os números
 * medidos, em linguagem de gente, e o custo de cada uma. Números da medição dos ritmos (03 e
 * 04/10/2026, due diligence e contestação, avaliação cega): Rigoroso 241 e 266 min, a nota mais
 * estável (sem as quedas de 82 e 88 que dois Equilibrados tiveram); Rápido 149 e 184 min, 3 a 5
 * pontos abaixo dos melhores; Equilibrado com a maior variação de nota entre runs (82 a 99). Não
 * entra número que a medição não tenha.
 */
const TEXTO_DOS_RITMOS = {
  rapido: { rotulo: 'Rápido', para: 'para rotina e minuta que você vai revisar', medida: 'nos nossos testes levou cerca de 2h30 a 3h, com nota 3 a 5 pontos abaixo da melhor', como: 'uma conferência de citações; a revisão devolve o texto para correção uma vez e, se reprovar de novo, o ponto vem a você; um avaliador na conferência final de qualidade; sem teste de leitura rápida; o pré-mortem do diagnóstico (o contraditor lendo as teses antes da redação, quando a equipe o tem) roda como nos outros ritmos, e o que fica de fora é o ataque simulado ao texto antes da aprovação' },
  equilibrado: { rotulo: 'Equilibrado', para: 'opção intermediária', medida: 'nos nossos testes a nota variou mais de um trabalho para outro', como: 'uma conferência de citações; uma rodada de correção na revisão; até dois avaliadores na conferência final de qualidade; teste de leitura rápida em uma passada; pré-mortem do diagnóstico como nos outros ritmos, sem o ataque simulado ao texto antes da aprovação' },
  completo: { rotulo: 'Rigoroso', para: 'para a entrega que vai a quem decide', medida: 'mais conferências e ataque simulado; nos nossos testes deu a nota mais estável, em cerca de 4 horas', como: 'citações conferidas por três verificadores, em geral duas rodadas de correção, até três avaliadores na conferência final de qualidade, teste de leitura rápida, pré-mortem do diagnóstico e ataque simulado ao texto, oferecido antes da aprovação' },
};

/**
 * As três opções, com a recomendada primeiro e o porquê dela (`recomendado`, o que
 * `ritmoRecomendado` devolve); sem recomendação, na ordem de sempre (Rápido, Equilibrado,
 * Rigoroso). A mesma frase no runner, no step compilado e no `squad-state ritmo`.
 */
function opcoesDeRitmo(recomendado = null) {
  const base = ['rapido', 'equilibrado', 'completo'];
  const ordem = recomendado && TEXTO_DOS_RITMOS[recomendado.ritmo] ? [recomendado.ritmo, ...base.filter((r) => r !== recomendado.ritmo)] : base;
  return ordem.map((r) => {
    const t = TEXTO_DOS_RITMOS[r];
    // A recomendada diz o porquê desta entrega no lugar do "para quem" genérico, sem repetir.
    const para = recomendado && recomendado.ritmo === r ? `recomendado para esta entrega: ${recomendado.motivo}` : t.para;
    return `**"${t.rotulo}"** (${para}: ${t.medida}; ${t.como})`;
  }).join(' · ');
}


/**
 * O ritmo que o intake recomenda pelo tipo de entrega. Decisão do dono (04/10/2026), com a medição
 * dos ritmos: peça que vai a juízo ou a terceiro que decide (petição, contestação, recurso, parecer
 * e dossiê para comitê ou cliente) recomenda Rigoroso; rotina e minuta interna (triagem, relatório
 * interno, checklist, minuta para revisão própria) recomenda Rápido. Equilibrado fica como opção,
 * nunca recomendada. Lê o `delivery_type` do squad, o `destinatario` e o `reader` do modelo e, na
 * análise sem destinatário, o nome do squad. `teto` é o perfil do projeto: a recomendação nunca
 * passa dele. Devolve `{ ritmo, rotulo, motivo }`.
 */
const ROTINA_INTERNA = /\b(?:triagem|triagens|checklist|relatorios? interno|rotina|minuta interna|revisao propria|prazos?|intimac\w*|publicac\w*|preparacao|controle|agenda)\b/;
const MINUTA_INTERNA = /\b(?:minuta interna|revisao propria|rascunho interno|uso interno)\b/;
const DESTINATARIO_INTERNO = /\b(?:advogad[oa]s?|escritorio|equipe|uso interno|revisao propria)\b/;
// O modelo pode declarar o ritmo que recomenda (`squad.ritmo` no design.yaml, `ritmo_recomendado` no
// squad.yaml): vale acima da regra pelo tipo de entrega, sob o mesmo teto do perfil. Decisão do dono
// (10/10/2026): material interno do cliente que não vai a quem decide um pedido (política de RH,
// investigação interna, due diligence, plano de regularização) recomenda Equilibrado.
const MOTIVO_DO_DECLARADO = {
  rapido: 'a equipe deste modelo recomenda Rápido para esta entrega',
  equilibrado: 'material para o cliente decidir internamente, que não vai a juízo nem a autoridade; a equipe deste modelo recomenda Equilibrado',
  completo: 'a equipe deste modelo recomenda Rigoroso para esta entrega',
};
function ritmoRecomendado({ deliveryType = null, reader = null, destinatario = null, nome = null, teto = null, declarado = null } = {}) {
  const norm = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]+/g, ' ');
  const tipo = norm(deliveryType).replace(/\s+/g, '-');
  const leitor = norm(reader).split(/[\s(]/)[0];
  const para = norm(destinatario);
  const qual = norm(nome);
  const quem = destinatario ? String(destinatario).trim() : { juiz: 'o juiz', autoridade: 'a autoridade', contraparte: 'a outra parte', cliente: 'o cliente' }[leitor] || null;
  let r;
  if (MINUTA_INTERNA.test(qual) || (para && DESTINATARIO_INTERNO.test(para))) r = { ritmo: 'rapido', motivo: `material interno${quem ? ` (${quem})` : ''}, que você revisa antes de usar` };
  else if (tipo === 'content') r = { ritmo: 'rapido', motivo: 'conteúdo de divulgação, que não vai a quem decide um pedido' };
  else if (tipo === 'legal-draft' || (!tipo && ['juiz', 'autoridade', 'contraparte'].includes(leitor))) r = { ritmo: 'completo', motivo: leitor === 'juiz' && !destinatario ? 'peça que vai a juízo' : `peça para ${quem || 'quem decide'}` };
  else if (ROTINA_INTERNA.test(qual)) r = { ritmo: 'rapido', motivo: 'rotina do escritório (triagem, prazos, checklist, relatório interno)' };
  else r = { ritmo: 'completo', motivo: `parecer ou dossiê para ${quem || 'quem decide'}` };
  const d = nomeDeRitmo(declarado);
  if (d) r = { ritmo: d, motivo: MOTIVO_DO_DECLARADO[d] };
  const t = nomeDeRitmo(teto);
  if (t && RITMOS.indexOf(r.ritmo) < RITMOS.indexOf(t)) r = { ritmo: t, motivo: `o perfil do projeto limita o run a ${TEXTO_DOS_RITMOS[t].rotulo} (sem o teto, a recomendação seria ${TEXTO_DOS_RITMOS[r.ritmo].rotulo}: ${r.motivo})` };
  return { ...r, rotulo: TEXTO_DOS_RITMOS[r.ritmo].rotulo };
}

/** A recomendação lida do `squad.yaml` do squad (`delivery_type`, `reader`, `destinatario`, `code`, `ritmo_recomendado`). */
function ritmoRecomendadoDoSquad(squadDir, teto = null) {
  let yaml = '';
  try { yaml = readFileSync(join(squadDir, 'squad.yaml'), 'utf-8'); } catch { /* sem squad.yaml: recomenda pelo que houver */ }
  const campo = (k) => { const m = yaml.match(new RegExp(`^${k}:[ \\t]*["']?([^"'\\n#]*?)["']?[ \\t]*(?:#.*)?$`, 'm')); return m && m[1].trim() ? m[1].trim() : null; };
  return ritmoRecomendado({ deliveryType: campo('delivery_type'), reader: campo('reader'), destinatario: campo('destinatario'), nome: `${campo('code') || ''} ${campo('name') || ''}`, teto, declarado: campo('ritmo_recomendado') });
}

/** Quantas vezes a revisão devolve à redação antes de escalar, com teto de `ciclos` ciclos. */
function rodadasDeCorrecao(ciclos) {
  if (!Number.isInteger(ciclos)) return 'rodadas de correção como a equipe declara';
  const n = Math.max(0, ciclos - 1);
  if (n === 0) return 'revisão sem rodada de correção (a primeira reprovação vem a você)';
  const rodadas = { 1: 'uma rodada', 2: 'duas rodadas', 3: 'três rodadas' }[n] || `${n} rodadas`;
  return `${rodadas} de correção na revisão antes de o ponto vir a você`;
}

/** O nome canônico de um ritmo ("Rápido", "light", "rigoroso"), ou null. */
function nomeDeRitmo(valor) {
  const n = String(valor || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (PERFIS[n]) return n;
  return RITMO_ALIASES[n] || null;
}

/** O perfil do projeto: nome, botões e de onde veio (`arquivo` ou `padrao`). */
function lerPerfil(raiz) {
  const caminho = join(raiz, ...PERFIL_ARQUIVO);
  let dados;
  try {
    dados = JSON.parse(readFileSync(caminho, 'utf-8'));
  } catch {
    return { nome: PERFIL_PADRAO, gates: { ...PERFIS[PERFIL_PADRAO] }, origem: 'padrao', caminho, ritmo: null };
  }
  const nome = (dados && nomeDeRitmo(dados.perfil)) || PERFIL_PADRAO;
  // Os botões do arquivo valem por cima do perfil nomeado, só os conhecidos e só
  // com valor do tipo certo: um número onde se espera booleano é ruído, não regra.
  const gates = { ...PERFIS[nome] };
  const extra = dados && dados.gates && typeof dados.gates === 'object' ? dados.gates : {};
  for (const chave of Object.keys(gates)) {
    if (!(chave in extra)) continue;
    const valor = extra[chave];
    if (typeof gates[chave] === 'boolean') {
      if (typeof valor === 'boolean') gates[chave] = valor;
    } else if (valor === null || (Number.isInteger(valor) && valor >= 1)) {
      gates[chave] = valor;
    }
  }
  return { nome, gates, origem: 'arquivo', caminho, ritmo: null };
}

/** O mais restrito de dois conjuntos de botões: número menor, `null` cede, booleano E. */
function combinarGates(a, b) {
  const gates = { ...a };
  for (const chave of Object.keys(gates)) {
    if (!b || !(chave in b)) continue;
    const va = a[chave];
    const vb = b[chave];
    if (typeof va === 'boolean' || typeof vb === 'boolean') gates[chave] = Boolean(va) && Boolean(vb);
    else if (va === null) gates[chave] = vb;
    else if (vb === null) gates[chave] = va;
    else gates[chave] = Math.min(va, vb);
  }
  return gates;
}

/**
 * Botões que o profissional ajusta por run, por cima do ritmo ("equilibrado, mas
 * com 3 ciclos"): inteiro >= 1 nos numéricos, booleano nos demais; o resto é ruído.
 */
function ajustesValidos(ajustes) {
  const saida = {};
  if (!ajustes || typeof ajustes !== 'object') return saida;
  for (const chave of Object.keys(PERFIS.completo)) {
    if (!(chave in ajustes) || SEM_AJUSTE_POR_RUN.has(chave)) continue;
    const valor = ajustes[chave];
    if (typeof PERFIS.rapido[chave] === 'boolean') {
      if (typeof valor === 'boolean') saida[chave] = valor;
    } else if (Number.isInteger(valor) && valor >= 1) {
      saida[chave] = valor;
    }
  }
  return saida;
}

/**
 * O perfil que vale num run: o do projeto combinado com o ritmo escolhido na
 * parada intake e com os ajustes por botão. O projeto é o teto: um projeto
 * travado em rápido (curso) não sobe por escolha de um run. Sem ritmo nem
 * ajuste, é o perfil do projeto.
 */
function perfilEfetivo(raiz, ritmo, ajustes) {
  const projeto = lerPerfil(raiz);
  const nome = nomeDeRitmo(ritmo);
  const validos = ajustesValidos(ajustes);
  if (!nome && !Object.keys(validos).length) return projeto;
  const preset = { ...(nome ? PERFIS[nome] : projeto.gates), ...validos };
  const efetivo = nome && RITMOS.indexOf(nome) >= RITMOS.indexOf(projeto.nome) ? nome : projeto.nome;
  return { ...projeto, nome: efetivo, gates: combinarGates(projeto.gates, preset), ritmo: nome, ajustes: validos };
}

/**
 * Rebaixa um número pedido ao teto do perfil. Devolve `{ valor, teto, rebaixado }`:
 * `rebaixado` é o aviso que o chamador imprime, para o rebaixamento nunca ser mudo.
 */
function aplicarTeto(perfil, botao, pedido) {
  const teto = perfil && perfil.gates ? perfil.gates[botao] : null;
  if (!Number.isInteger(teto) || !Number.isInteger(pedido) || pedido <= teto) return { valor: pedido, teto, rebaixado: false };
  return { valor: teto, teto, rebaixado: true };
}

/** Uma linha para o chefe dizer o que o run paga, em linguagem de gente. */
function descreverPerfil(perfil) {
  if (!perfil || perfil.nome === PERFIL_PADRAO) return 'ritmo rigoroso: conferência de citações, teste de leitura rápida, pré-mortem do diagnóstico, ataque simulado antes da aprovação e avaliadores da conferência final de qualidade (até três) como a equipe declara';
  const g = perfil.gates;
  const extenso = (n) => ({ 2: 'dois', 3: 'três' })[n] || String(n);
  const meta = g.meta_verifiers === 1 ? 'um avaliador na conferência final de qualidade' : Number.isInteger(g.meta_verifiers) ? `até ${extenso(g.meta_verifiers)} avaliadores na conferência final de qualidade, como a equipe declara` : 'avaliadores da conferência final de qualidade como a equipe declara';
  const citacoes = g.citation_verifiers === 1 ? 'uma conferência de citações' : Number.isInteger(g.citation_verifiers) ? `citações conferidas por ${extenso(g.citation_verifiers)} verificadores` : 'citações conferidas pelos verificadores que a equipe declara';
  const partes = [citacoes, meta, rodadasDeCorrecao(g.max_review_cycles)];
  partes.push(g.persuasao === false ? 'sem teste de leitura rápida' : 'teste de leitura rápida em uma passada');
  // O pré-mortem do diagnóstico (o contraditor lendo as teses antes da redação) roda em todo ritmo;
  // o red_team desliga só o ataque simulado ao texto antes da aprovação. Medido em 09/10/2026: "sem
  // ataque simulado" levou o dono a achar errado ver o contraditor no diagnóstico de um run Rápido.
  if (g.red_team === false) partes.push('sem ataque simulado antes da aprovação (o pré-mortem do diagnóstico roda em todo ritmo)');
  const rotulo = TEXTO_DOS_RITMOS[perfil.nome] ? TEXTO_DOS_RITMOS[perfil.nome].rotulo.toLowerCase() : perfil.nome;
  return `ritmo ${rotulo}: ${partes.join(', ')}`;
}
// <<< perfil:end

/** As três opções sem recomendação (o texto genérico do runner); fora do bloco, que o `squad-state` não usa. */
const OPCOES_DE_RITMO = opcoesDeRitmo();

/** Grava o perfil nomeado (com os botões resolvidos, para quem ler sem esta tabela). Só a CLI grava: fica fora do bloco sincronizado, que o `squad-state` só lê. */
function gravarPerfil(raiz, pedido) {
  const nome = nomeDeRitmo(pedido);
  if (!nome) throw new Error(`perfil desconhecido: "${pedido}" (use ${Object.keys(PERFIS).join(', ')})`);
  const caminho = join(raiz, ...PERFIL_ARQUIVO);
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, `${JSON.stringify({ perfil: nome, gates: PERFIS[nome] }, null, 2)}\n`, 'utf-8');
  return { nome, gates: { ...PERFIS[nome] }, caminho };
}

export { PERFIS, OPCOES_DE_RITMO, TEXTO_DOS_RITMOS, opcoesDeRitmo, ritmoRecomendado, ritmoRecomendadoDoSquad, rodadasDeCorrecao, RITMOS, RITMO_ALIASES, PERFIL_PADRAO, PERFIL_ARQUIVO, nomeDeRitmo, lerPerfil, combinarGates, ajustesValidos, perfilEfetivo, gravarPerfil, aplicarTeto, descreverPerfil };
export const perfilExiste = (raiz) => existsSync(join(raiz, ...PERFIL_ARQUIVO));

/**
 * `legalsquad perfil` mostra; `legalsquad perfil rapido|equilibrado|completo` grava.
 * Só dentro de um projeto (`_legalsquad/`): o perfil é do projeto, não da máquina.
 */
export function perfilCli(pedido, raiz, { json = false } = {}) {
  if (!existsSync(join(raiz, '_legalsquad'))) {
    console.error('PERFIL:BLOQUEADO: esta pasta não é um projeto LegalSquad (sem `_legalsquad/`). Rode `legalsquad init` antes.');
    return { success: false, error: { code: 'fora-de-projeto', message: raiz } };
  }
  if (pedido !== undefined && pedido !== '') {
    const nome = nomeDeRitmo(pedido);
    if (!nome) {
      console.error(`PERFIL:BLOQUEADO: perfil desconhecido "${pedido}". Use ${Object.keys(PERFIS).join(', ')}.`);
      return { success: false, error: { code: 'perfil-desconhecido', message: String(pedido) } };
    }
    const gravado = gravarPerfil(raiz, nome);
    const perfil = lerPerfil(raiz);
    if (json) console.log(JSON.stringify({ perfil: perfil.nome, gates: perfil.gates, arquivo: gravado.caminho }, null, 2));
    else console.log(`  ✅ ${descreverPerfil(perfil)}\n     gravado em _legalsquad/_memory/perfil.json (o update preserva; é teto e padrão dos próximos runs; o ritmo de cada run é escolhido na parada intake)`);
    return { success: true, perfil: perfil.nome, gates: perfil.gates };
  }
  const perfil = lerPerfil(raiz);
  if (json) console.log(JSON.stringify({ perfil: perfil.nome, gates: perfil.gates, origem: perfil.origem }, null, 2));
  else console.log(`  ${descreverPerfil(perfil)}${perfil.origem === 'padrao' ? ' (padrão: nenhum perfil gravado; o ritmo de cada run é escolhido na parada intake)' : ''}\n  \`legalsquad perfil rapido\`, \`equilibrado\` ou \`completo\` troca.`);
  return { success: true, perfil: perfil.nome, gates: perfil.gates, origem: perfil.origem };
}
