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
 * Os avaliadores da Verificação da Meta não têm botão aqui: são sempre os que o
 * squad declara em `meta_verifiers`. Medido em 24/09/2026: o equilibrado rebaixava
 * `meta_verifiers: 3` para 1, e a mesma evidência saiu punida num run e aceita em
 * outro; o `squad-state meta-consenso` recusa consenso com menos avaliações.
 */
const PERFIS = {
  completo: { citation_verifiers: null, max_review_cycles: null, persuasao: true, red_team: true },
  equilibrado: { citation_verifiers: 1, max_review_cycles: 2, persuasao: true, red_team: false },
  rapido: { citation_verifiers: 1, max_review_cycles: 1, persuasao: false, red_team: false },
};

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
    if (!(chave in ajustes)) continue;
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
  if (!perfil || perfil.nome === PERFIL_PADRAO) return 'ritmo completo: verificadores, persuasão e red-team como cada squad declara';
  const g = perfil.gates;
  const partes = [`${g.citation_verifiers ?? 'N'} verificador(es) por gate`, 'avaliadores da meta como o squad declara', `${g.max_review_cycles ?? 'N'} ciclo(s) de revisão`];
  partes.push(g.persuasao === false ? 'sem gate de persuasão' : 'persuasão em uma passada');
  if (g.red_team === false) partes.push('sem red-team');
  return `ritmo ${perfil.nome}: ${partes.join(', ')}`;
}
// <<< perfil:end

/** Grava o perfil nomeado (com os botões resolvidos, para quem ler sem esta tabela). Só a CLI grava: fica fora do bloco sincronizado, que o `squad-state` só lê. */
function gravarPerfil(raiz, pedido) {
  const nome = nomeDeRitmo(pedido);
  if (!nome) throw new Error(`perfil desconhecido: "${pedido}" (use ${Object.keys(PERFIS).join(', ')})`);
  const caminho = join(raiz, ...PERFIL_ARQUIVO);
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, `${JSON.stringify({ perfil: nome, gates: PERFIS[nome] }, null, 2)}\n`, 'utf-8');
  return { nome, gates: { ...PERFIS[nome] }, caminho };
}

export { PERFIS, RITMOS, RITMO_ALIASES, PERFIL_PADRAO, PERFIL_ARQUIVO, nomeDeRitmo, lerPerfil, combinarGates, ajustesValidos, perfilEfetivo, gravarPerfil, aplicarTeto, descreverPerfil };
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
