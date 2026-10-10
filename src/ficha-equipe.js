// A ficha da equipe de um squad criado de modelo, e o registro da resposta do profissional a ela.
//
// Até a 0.9.90 o roteador criava o squad do modelo e dizia, numa linha, "usei o modelo X; tem 7
// agentes" e seguia para o intake (relato do dono, 05/10/2026: «antes ele mostrava os agentes, com
// os nomes e o pipeline, para aprovar ou inserir algo a mais; não me perguntou nada»). A aprovação
// só existia na rota do Arquiteto (o desenho, na Phase G). Este módulo dá ao modelo a mesma parada:
// a ficha é lida por CÓDIGO do squad criado (squad.yaml, agents/*.agent.md, pipeline.yaml), em
// linguagem de advogado e sem id interno, e a resposta (aprovar, ajustar) fica gravada em
// `_build/aprovacao-equipe.json`, com a resposta literal e a hora, para o auditor conferir (B4).
//
// O texto da ficha não diz "squad", "pipeline", "step", "gate", "meta" nem "red-team": diz equipe,
// caminho do trabalho, etapas e conferências.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYamlSubconjunto } from './yaml-subconjunto.js';
import { extractFrontMatter, parseList } from './frontmatter.js';
import { lerPerfil, ritmoRecomendadoDoSquad } from './perfil.js';

export const ARQUIVO_DA_APROVACAO_DA_EQUIPE = join('_build', 'aprovacao-equipe.json');

/** As três opções da parada, na ordem em que o chefe as oferece. */
export const OPCOES_DA_EQUIPE = Object.freeze([
  Object.freeze({ decisao: 'aprovar', rotulo: 'Aprovar e começar', o_que_faz: 'segue para o intake' }),
  Object.freeze({ decisao: 'ajustar', rotulo: 'Ajustar a equipe', o_que_faz: 'diga o que acrescentar, trocar ou tirar: um especialista, uma etapa, uma conferência; ajusto e mostro a ficha de novo' }),
  Object.freeze({ decisao: 'descartar', rotulo: 'Não serve: montar do zero com o Arquiteto', o_que_faz: 'desfaço esta equipe e monto outra do zero, com umas perguntas rápidas e o desenho para você aprovar' }),
]);
export const PERGUNTA_DA_EQUIPE = 'Esta é a equipe e o caminho do trabalho. Posso começar?';
export const DECISOES_GRAVAVEIS = Object.freeze(['aprovar', 'ajustar']);

// O nome em linguagem de gente dos especialistas do MOTOR (os de matéria chegam no pacote da área e
// o motor não os nomeia: tests/fronteira.test.js). Os demais saem da primeira oração da descrição
// do agente instalado (até o travessão, o parêntese ou o ponto).
const ESPECIALISTAS = Object.freeze({
  'acervo-busca': 'busca no acervo do escritório',
  'avaliador-squad': 'avaliação de qualidade',
  contraditor: 'ataques que a parte contrária faria',
  'verificador-citacoes': 'conferência de citações',
  'verificador-persuasao': 'teste de leitura rápida',
});

// As paradas com nome que os modelos usam, e o que o profissional decide em cada uma.
const PARADAS = Object.freeze({
  intake: 'você confirma o pedido, os documentos e o ritmo',
  diagnostico: 'você escolhe o que entra e o foco',
  aprovacao: 'você aprova a versão final',
});

const lerTexto = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const inteiro = (v) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : null);
const lista = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const minuscula = (t) => (t && !/^[A-ZÀ-Ý]{2}/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
const semPonto = (t) => String(t || '').trim().replace(/[.;:\s]+$/, '');

class ErroDaEquipe extends Error {}
export { ErroDaEquipe };
const falha = (m) => { throw new ErroDaEquipe(m); };

// O papel vem da prosa do agente, escrita para o motor: o jargão interno vira o nome que o
// profissional conhece (a ordem importa: o nome composto antes do termo solto). O termo que vira
// palavra feminina leva junto o artigo que o precede ("do squad" vira "da equipe").
const ARTIGO_FEMININO = { o: 'a', ao: 'à', do: 'da', no: 'na', pelo: 'pela' };
const feminino = (termo, por, plural = `${por}s`) => [
  new RegExp(`\\b(?:(o|ao|do|no|pelo)(s?) )?${termo}(s?)\\b`, 'gi'),
  (_, artigo, artigoPlural, termoPlural) => {
    const a = artigo ? `${ARTIGO_FEMININO[artigo.toLowerCase()]}${artigoPlural}` : '';
    const maiuscula = artigo && artigo[0] !== artigo[0].toLowerCase();
    return `${a ? `${maiuscula ? a[0].toUpperCase() + a.slice(1) : a} ` : ''}${termoPlural ? plural : por}`;
  },
];
const JARGAO = Object.freeze([
  [/manifesto do Citation Gate/g, 'relatório da conferência de citações'],
  feminino('Citation Gate', 'conferência de citações', 'conferências de citações'),
  feminino('Reda[çc][ãa]o Gate', 'conferência da redação', 'conferências da redação'),
  [/(?:Gate de )?Sobreviv[êe]ncia ao Resumo/g, 'teste de leitura rápida'],
  [/Verifica[çc][ãa]o da Meta/g, 'conferência final de qualidade'],
  [/\bred-team\b/gi, 'ataque simulado'],
  [/cart[óo]rio de cita[çc][õo]es/g, 'registro das citações'],
  [/\b([Oo])s fixes\b/g, (_, o) => `${o === 'O' ? 'A' : 'a'}s correções`],
  [/\bfixes\b/g, 'correções'],
  [/\bfix\b/g, 'correção'],
  feminino('squad', 'equipe'),
  [/\bpipeline\b/g, 'caminho do trabalho'],
  feminino('step', 'etapa'),
  feminino('gate', 'conferência'),
]);
export function semJargao(texto) {
  return JARGAO.reduce((t, [re, por]) => t.replace(re, por), String(texto || ''));
}

/** O papel do agente em uma frase: a linha do `### Role` do .agent.md (o resumo do papel), senão o `title`. */
function papelDoAgente(texto, titulo) {
  const m = String(texto || '').match(/^###\s+Role\s*\n+([^\n]+)/m);
  const bruto = m ? m[1].trim() : String(titulo || '').trim();
  return bruto ? minuscula(semPonto(semJargao(bruto))) : null;
}

/** Os especialistas nativos que o .agent.md declara ("Apoia-se no subagente nativo `x`"). */
function especialistasDoAgente(texto) {
  const m = String(texto || '').match(/Apoia-se n[oa]s? subagentes? nativos? ((?:`[^`]+`(?:,\s*|\s+e\s+)?)+)/);
  return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
}

/** O nome de gente de um especialista: o mapa acima, ou a primeira oração da descrição instalada. */
function nomeDoEspecialista(id, raiz) {
  if (ESPECIALISTAS[id]) return ESPECIALISTAS[id];
  for (const dir of [join(raiz, '.claude', 'agents'), join(process.env.HOME || '', '.claude', 'agents')]) {
    const fm = extractFrontMatter(lerTexto(join(dir, `${id}.md`)) || '');
    const desc = fm?.match(/^description:\s*["']?(.+)$/m)?.[1];
    if (!desc) continue;
    const oracao = semPonto(desc.split(/\s[\u2014-]\s|\s\(|\.\s|;/)[0]).replace(/^especialista em\s+/i, '');
    if (oracao) return minuscula(oracao.length > 80 ? `${oracao.slice(0, 80).replace(/\s+\S*$/, '')}…` : oracao);
  }
  return id.replace(/-/g, ' ');
}

/** O nome de exibição de uma calculadora (o `display_name` da skill, sem o parêntese técnico). */
function nomeDaCalculadora(id, raiz) {
  const ui = lerTexto(join(raiz, 'skills', id, 'agents', 'openai.yaml')) || '';
  const nome = ui.match(/display_name:\s*["']?([^"'\n]+)/)?.[1];
  if (nome) return semPonto(nome.replace(/\s*\(.*$/, ''));
  return `calculadora de ${id.replace(/^calculadora-/, '').replace(/-/g, ' ')}`;
}

/**
 * Hash da definição da equipe (squad.yaml, pipeline.yaml e os .agent.md), gravado com a decisão:
 * mostra depois se a equipe aprovada é a que rodou.
 */
export function impressaoDaEquipe(squadDir) {
  const h = createHash('sha256');
  const arquivos = ['squad.yaml', join('pipeline', 'pipeline.yaml')];
  let agentes;
  try { agentes = parseYamlSubconjunto(lerTexto(join(squadDir, 'squad.yaml')) || '')?.agents || []; } catch { agentes = []; }
  for (const a of lista(agentes)) if (a?.file) arquivos.push(String(a.file));
  for (const rel of arquivos.sort()) h.update(`${rel}\n${lerTexto(join(squadDir, rel)) ?? ''}\n`);
  return h.digest('hex');
}

/**
 * A ficha da equipe, lida do squad em disco. `modelo` (opcional) é `{ id, nome, frase }`, a versão
 * do modelo de origem que o chamador já calculou. Devolve o objeto e as linhas de texto prontas.
 */
export function fichaDaEquipe(raiz, code, { modelo = null } = {}) {
  const squadDir = join(raiz, 'squads', code);
  const yaml = lerTexto(join(squadDir, 'squad.yaml'));
  if (yaml === null) falha(`squads/${code}/squad.yaml não existe`);
  let squad;
  let pipeline;
  try { squad = parseYamlSubconjunto(yaml) || {}; } catch (e) { falha(`squads/${code}/squad.yaml ilegível: ${e.message}`); }
  try { pipeline = parseYamlSubconjunto(lerTexto(join(squadDir, 'pipeline', 'pipeline.yaml')) || '') || {}; } catch (e) { falha(`squads/${code}/pipeline/pipeline.yaml ilegível: ${e.message}`); }
  const steps = lista(pipeline.steps).filter((s) => s && typeof s === 'object');

  const porId = new Map();
  for (const a of lista(squad.agents)) {
    if (!a?.id) continue;
    const texto = lerTexto(join(squadDir, String(a.file || `agents/${a.id}.agent.md`))) || '';
    const fm = extractFrontMatter(texto) || '';
    const titulo = fm.match(/^title:\s*["']?([^"'\n]+)/m)?.[1] || null;
    porId.set(String(a.id), {
      id: String(a.id),
      nome: String(a.name || a.id),
      papel: papelDoAgente(texto, titulo),
      especialistas: especialistasDoAgente(texto),
      calculadoras: parseList(fm, 'skills').filter((s) => /^calculadora-/.test(s)),
    });
  }
  // Na ordem em que trabalham: a da primeira etapa de cada um; quem não tem etapa vai ao fim.
  const ordem = [];
  for (const s of steps) if (s.agent && porId.has(String(s.agent)) && !ordem.includes(String(s.agent))) ordem.push(String(s.agent));
  for (const id of porId.keys()) if (!ordem.includes(id)) ordem.push(id);
  const agentes = ordem.map((id) => porId.get(id));
  const nomeDe = (id) => porId.get(String(id))?.nome || null;

  // O caminho: etapas na ordem; as de um mesmo grupo paralelo seguidas viram uma etapa só.
  const etapas = [];
  for (const s of steps) {
    const nome = String(s.name || '').trim() || 'Etapa';
    if (s.type === 'checkpoint') {
      const chave = semAcento(nome).replace(/[^a-z]/g, '');
      etapas.push({ tipo: 'parada', nome, decide: PARADAS[chave] || 'você decide' });
      continue;
    }
    const item = { nome, quem: nomeDe(s.agent) };
    const anterior = etapas[etapas.length - 1];
    if (s.parallel_group && anterior?.tipo === 'paralelo' && anterior.grupo === s.parallel_group) { anterior.itens.push(item); continue; }
    if (s.parallel_group) { etapas.push({ tipo: 'paralelo', grupo: s.parallel_group, itens: [item] }); continue; }
    const devolve = s.on_reject ? inteiro(s.max_review_cycles) : null;
    etapas.push({ tipo: 'etapa', ...item, ...(s.on_reject ? { devolve_ate: devolve ?? 3 } : {}) });
  }

  // As conferências automáticas, do que o squad declara e do que o runner liga por tipo de entrega.
  const peca = String(squad.delivery_type || '') === 'legal-draft';
  const leitor = semAcento(squad.reader).split(/[\s(]/)[0];
  const revisao = steps.find((s) => s.on_reject);
  const verificadores = inteiro(squad.citation_verifiers) ?? 0;
  const avaliadores = inteiro(squad.meta_verifiers) ?? 0;
  const conferencias = [];
  if (peca) conferencias.push('redação conferida por código (marcas de texto de máquina, folhas citadas)');
  if (peca || verificadores > 0) conferencias.push('citações conferidas na fonte oficial');
  if (revisao) conferencias.push(`revisão independente, por quem não redigiu (até ${inteiro(revisao.max_review_cycles) ?? 3} rodadas de correção)`);
  if (avaliadores > 0) conferencias.push('conferência final de qualidade contra os critérios do trabalho');
  const pelo = [];
  if (peca && ['juiz', 'autoridade', 'cliente'].includes(leitor)) pelo.push('teste de leitura rápida (Equilibrado e Rigoroso)');
  if (avaliadores >= 3) pelo.push('ataque simulado ao texto, oferecido antes da aprovação (Rigoroso)');

  // Especialistas e calculadoras, com quem os usa.
  const especialistas = [];
  const calculadoras = [];
  for (const a of agentes) {
    for (const e of a.especialistas) {
      const x = especialistas.find((y) => y.id === e) || (especialistas.push({ id: e, nome: nomeDoEspecialista(e, raiz), com: [] }), especialistas[especialistas.length - 1]);
      if (!x.com.includes(a.nome)) x.com.push(a.nome);
    }
    for (const c of a.calculadoras) {
      const x = calculadoras.find((y) => y.id === c) || (calculadoras.push({ id: c, nome: nomeDaCalculadora(c, raiz), com: [] }), calculadoras[calculadoras.length - 1]);
      if (!x.com.includes(a.nome)) x.com.push(a.nome);
    }
  }

  let teto;
  try { teto = lerPerfil(raiz).nome; } catch { teto = null; }
  const ritmo = ritmoRecomendadoDoSquad(squadDir, teto);

  const ficha = {
    code,
    nome: String(squad.name || code),
    modelo,
    agentes: agentes.map(({ nome, papel }) => ({ nome, papel })),
    etapas,
    conferencias,
    conferencias_pelo_ritmo: pelo,
    especialistas: especialistas.map(({ nome, com }) => ({ nome, com })),
    calculadoras: calculadoras.map(({ nome, com }) => ({ nome, com })),
    ritmo_recomendado: { ritmo: ritmo.ritmo, rotulo: ritmo.rotulo, motivo: ritmo.motivo },
    pergunta: PERGUNTA_DA_EQUIPE,
    opcoes: OPCOES_DA_EQUIPE.map((o) => ({ ...o })),
  };
  ficha.resumo = resumoDaEquipe(ficha);
  ficha.texto = linhasDaFicha(ficha).join('\n');
  return ficha;
}

const juntar = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/** A equipe em uma linha, para o squad reusado e o run reaberto (não se pergunta de novo). */
export function resumoDaEquipe(ficha) {
  const nomes = ficha.agentes.map((a) => a.nome);
  const paradas = ficha.etapas.filter((e) => e.tipo === 'parada').map((e) => e.nome.toLowerCase());
  return `Equipe de ${ficha.nome}: ${nomes.length} ${nomes.length === 1 ? 'pessoa' : 'pessoas'} (${juntar(nomes)})${paradas.length ? `, com paradas para você decidir em ${juntar(paradas)}` : ''}.`;
}

/** A ficha em texto, como o chefe a mostra antes da pergunta. */
export function linhasDaFicha(ficha) {
  const L = [];
  const origem = ficha.modelo
    ? ` (modelo ${ficha.modelo.nome ? `«${ficha.modelo.nome}»` : ficha.modelo.id}${ficha.modelo.frase ? `, ${ficha.modelo.frase}` : ''})`
    : '';
  L.push(`Equipe de ${ficha.nome}${origem}`);
  L.push('', 'Quem trabalha, na ordem:');
  ficha.agentes.forEach((a, i) => L.push(`  ${i + 1}. ${a.nome}${a.papel ? `: ${a.papel}` : ''}`));
  L.push('', 'Caminho do trabalho:');
  ficha.etapas.forEach((e, i) => {
    const n = `  ${i + 1}. `;
    if (e.tipo === 'parada') L.push(`${n}${e.nome}: parada em que ${e.decide}`);
    else if (e.tipo === 'paralelo') L.push(`${n}Ao mesmo tempo: ${e.itens.map((x) => `${x.nome}${x.quem ? ` (${x.quem})` : ''}`).join('; ')}`);
    else L.push(`${n}${e.nome}${e.quem ? ` (${e.quem})` : ''}${e.devolve_ate ? `, que devolve o texto para correção até ${e.devolve_ate} vezes` : ''}`);
  });
  if (ficha.conferencias.length || ficha.conferencias_pelo_ritmo.length) {
    L.push('', `Conferências automáticas: ${ficha.conferencias.join('; ')}${ficha.conferencias_pelo_ritmo.length ? `${ficha.conferencias.length ? '; e, conforme o ritmo, ' : ''}${ficha.conferencias_pelo_ritmo.join('; ')}` : ''}.`);
  }
  if (ficha.especialistas.length) L.push(`Especialistas de apoio: ${ficha.especialistas.map((e) => `${e.nome} (com ${juntar(e.com)})`).join('; ')}.`);
  if (ficha.calculadoras.length) L.push(`Calculadoras: ${ficha.calculadoras.map((c) => `${c.nome} (com ${juntar(c.com)})`).join('; ')}.`);
  L.push(`Ritmo que vou recomendar no intake: ${ficha.ritmo_recomendado.rotulo} (${ficha.ritmo_recomendado.motivo}).`);
  L.push('', ficha.pergunta);
  ficha.opcoes.forEach((o, i) => L.push(`  ${i + 1}. ${o.rotulo} (${o.o_que_faz})`));
  return L;
}

/** O registro da equipe do squad, ou null. */
export function lerAprovacaoDaEquipe(squadDir) {
  try { return JSON.parse(readFileSync(join(squadDir, ARQUIVO_DA_APROVACAO_DA_EQUIPE), 'utf8')); } catch { return null; }
}

/**
 * O ajuste pedido na parada da equipe que ainda não foi aprovado: o squad mudou pela parada, antes
 * de qualquer run, e o profissional ainda pode recusá-lo inteiro (o descarte vale).
 */
export function ajusteDaEquipeEmAberto(squadDir) {
  const reg = lerAprovacaoDaEquipe(squadDir);
  const ds = Array.isArray(reg?.decisoes) ? reg.decisoes : [];
  return ds.length > 0 && ds[ds.length - 1].decisao === 'ajustar';
}

/**
 * Grava a resposta do profissional à ficha (`aprovar` ou `ajustar`), literal e com a hora, em
 * `squads/<code>/_build/aprovacao-equipe.json`. As decisões se acumulam (ajustar, ajustar,
 * aprovar); `aprovada_em` é a hora da última aprovação e `equipe_sha256` a definição aprovada.
 */
export function registrarDecisaoDaEquipe(raiz, code, { decisao, resposta, agora = () => new Date().toISOString() } = {}) {
  const squadDir = join(raiz, 'squads', code);
  if (!existsSync(join(squadDir, 'squad.yaml'))) falha(`squads/${code}/ não existe`);
  const d = String(decisao || '').trim().toLowerCase();
  if (!DECISOES_GRAVAVEIS.includes(d)) falha(`--decisao pede ${DECISOES_GRAVAVEIS.join(' ou ')} (a recusa é o --descartar), não «${decisao ?? ''}»`);
  const texto = String(resposta ?? '').trim();
  if (!texto) falha('--resposta pede a resposta do profissional à ficha, literal');
  const anterior = lerAprovacaoDaEquipe(squadDir) || {};
  let origem;
  try { origem = JSON.parse(readFileSync(join(squadDir, '_build', 'modelo-origem.json'), 'utf8')); } catch { origem = null; }
  const em = agora();
  const decisoes = [...(Array.isArray(anterior.decisoes) ? anterior.decisoes : []), { decisao: d, resposta: texto, em }];
  const registro = {
    squad: code,
    modelo: origem?.modelo ?? anterior.modelo ?? null,
    decisoes,
    aprovada_em: d === 'aprovar' ? em : null,
    ...(d === 'aprovar' ? { equipe_sha256: impressaoDaEquipe(squadDir) } : {}),
  };
  const caminho = join(squadDir, ARQUIVO_DA_APROVACAO_DA_EQUIPE);
  writeFileSync(`${caminho}.tmp`, `${JSON.stringify(registro, null, 2)}\n`, 'utf8');
  renameSync(`${caminho}.tmp`, caminho);
  return { ...registro, arquivo: `squads/${code}/${ARQUIVO_DA_APROVACAO_DA_EQUIPE.split('\\').join('/')}` };
}
