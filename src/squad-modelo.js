// Squads-modelo: um squad pronto, curado, que se cria em segundos.
//
// Um modelo é `design.yaml` (decisões) + `prosa.yaml` (o texto de cada marcador)
// + `modelo.yaml` (identidade e provas). Ele NÃO carrega os arquivos do squad:
// na criação, `compilar-squad` gera tudo com a versão corrente do motor e a
// prosa entra nos marcadores. Squad congelado envelhece a cada release do
// runner (os seis squads criminais precisaram de migração); modelo compilável
// nasce sempre no formato de hoje. `{code}` é substituído pelo code escolhido.
//
// Onde moram: `squads/_modelos/<id>/` do projeto (um pacote de área os leva na
// subárvore `squads/`, que o depósito copia para o projeto). `_modelos` começa
// com `_` para nenhum listador de squads o tratar como squad.
//
// O caminho de curadoria é o inverso: um squad construído e medido vira modelo
// com `extrairModelo` (prosa recuperada por alinhamento com o compilado; o que
// não se recupera é listado, nunca inventado).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { emitirYaml, parseYamlSubconjunto } from './yaml-subconjunto.js';
import { ErroDeCompilacaoDeSquad, compilarSquad, emitirProsa, extrairProsa, lerProsa, personalizar } from './squad-compile.js';
import { checkSquad } from './squad-check.js';

export class ErroDeModelo extends Error {}
const falha = (m) => { throw new ErroDeModelo(m); };

export const PASTA_DE_MODELOS = join('squads', '_modelos');
const RE_ID = /^[a-z0-9][a-z0-9-]*$/;

function lerYaml(caminho, rotulo) {
  return parseYamlSubconjunto(readFileSync(caminho, 'utf8'), rotulo, { falha });
}

/** Modelos disponíveis no projeto. */
export function listarModelos(cwd) {
  const raiz = join(cwd, PASTA_DE_MODELOS);
  if (!existsSync(raiz)) return [];
  const modelos = [];
  for (const e of readdirSync(raiz, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(raiz, e.name);
    const meta = existsSync(join(dir, 'modelo.yaml')) ? lerYaml(join(dir, 'modelo.yaml'), `${e.name}/modelo.yaml`) : {};
    const completo = existsSync(join(dir, 'design.yaml')) && existsSync(join(dir, 'prosa.yaml'));
    modelos.push({ id: e.name, dir, completo, meta: meta || {} });
  }
  return modelos.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Cria `squads/<code>/` a partir do modelo: grava o design e a prosa (com o
 * code) em `_build/`, compila com a prosa e valida. Recusa code inválido ou
 * pasta existente: um modelo nunca sobrescreve trabalho.
 */
export function instanciarModelo(id, { cwd, code, hoje } = {}) {
  const modelo = listarModelos(cwd).find((m) => m.id === id);
  if (!modelo) falha(`modelo «${id}» não existe em ${PASTA_DE_MODELOS}/ (disponíveis: ${listarModelos(cwd).map((m) => m.id).join(', ') || 'nenhum'})`);
  if (!modelo.completo) falha(`modelo «${id}» está incompleto: precisa de design.yaml e prosa.yaml`);
  const codeFinal = String(code || id).trim();
  if (!RE_ID.test(codeFinal)) falha(`code «${codeFinal}» inválido: minúsculas, dígitos e hífen`);
  if (codeFinal.startsWith('_')) falha('code não pode começar com _');
  const squadsDir = join(cwd, 'squads');
  const dir = join(squadsDir, codeFinal);
  if (existsSync(dir)) falha(`squads/${codeFinal}/ já existe: escolha outro code (o modelo nunca sobrescreve um squad)`);
  const build = join(dir, '_build');
  mkdirSync(build, { recursive: true });
  try {
    writeFileSync(join(build, 'design.yaml'), personalizar(readFileSync(join(modelo.dir, 'design.yaml'), 'utf8'), codeFinal), 'utf8');
    writeFileSync(join(build, 'prosa.yaml'), personalizar(readFileSync(join(modelo.dir, 'prosa.yaml'), 'utf8'), codeFinal), 'utf8');
    if (existsSync(join(modelo.dir, 'discovery.yaml'))) {
      writeFileSync(join(build, 'discovery.yaml'), personalizar(readFileSync(join(modelo.dir, 'discovery.yaml'), 'utf8'), codeFinal), 'utf8');
    }
    writeFileSync(join(build, 'modelo-origem.json'), `${JSON.stringify({ modelo: id, versao: modelo.meta?.versao ?? null, criado_em: hoje || new Date().toISOString().slice(0, 10) }, null, 2)}\n`, 'utf8');
    const prosa = lerProsa(join(build, 'prosa.yaml')).porArquivo;
    const r = compilarSquad(codeFinal, { squadsDir, hoje, prosa });
    const check = checkSquad(codeFinal, { squadsDir });
    return { id, code: codeFinal, dir, manifesto: r.manifesto, check };
  } catch (erro) {
    rmSync(dir, { recursive: true, force: true });
    if (erro instanceof ErroDeCompilacaoDeSquad) falha(`o modelo «${id}» não compila com este motor: ${erro.message}`);
    throw erro;
  }
}

/**
 * O caminho do curador: um squad construído (e, de preferência, medido) vira
 * modelo em `squads/_modelos/<id>/`. A prosa é recuperada por alinhamento com
 * o compilado; o que não se recupera fica listado em `modelo.yaml` (provas),
 * para o curador escrever, nunca para o motor inventar.
 */
export function extrairModelo(codeOrigem, { cwd, id, nome, descricao, area, peca, polo, hoje, forcar = false, provas = {} } = {}) {
  const idFinal = String(id || codeOrigem).trim();
  if (!RE_ID.test(idFinal)) falha(`id de modelo «${idFinal}» inválido: minúsculas, dígitos e hífen`);
  const squadsDir = join(cwd, 'squads');
  const origem = join(squadsDir, codeOrigem);
  if (!existsSync(join(origem, '_build', 'design.yaml'))) falha(`squads/${codeOrigem}/_build/design.yaml não existe: só um squad desenhado pelo Arquiteto (ou criado de modelo) vira modelo`);
  const destino = join(cwd, PASTA_DE_MODELOS, idFinal);
  if (existsSync(destino) && !forcar) falha(`${PASTA_DE_MODELOS}/${idFinal}/ já existe; use --forcar para regravar`);
  const ex = extrairProsa(codeOrigem, { squadsDir, hoje });
  const check = checkSquad(codeOrigem, { squadsDir });
  mkdirSync(destino, { recursive: true });
  const despers = (t) => t.replace(new RegExp(`(^|[^A-Za-z0-9_-])${codeOrigem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^A-Za-z0-9_-]|$)`, 'g'), '$1{code}');
  writeFileSync(join(destino, 'design.yaml'), despers(readFileSync(join(origem, '_build', 'design.yaml'), 'utf8')), 'utf8');
  writeFileSync(join(destino, 'prosa.yaml'), emitirProsa({ origem: `${codeOrigem} (extraído)`, arquivos: ex.arquivos }), 'utf8');
  if (existsSync(join(origem, '_build', 'discovery.yaml'))) writeFileSync(join(destino, 'discovery.yaml'), despers(readFileSync(join(origem, '_build', 'discovery.yaml'), 'utf8')), 'utf8');
  const meta = {
    id: idFinal,
    nome: nome || idFinal,
    descricao: descricao || '',
    area: area || null,
    peca: peca || null,
    polo: polo || null,
    versao: hoje || new Date().toISOString().slice(0, 10),
    origem: { squad: codeOrigem, extraido_em: hoje || new Date().toISOString().slice(0, 10) },
    provas: {
      check_squad: { erros: check.issues.filter((i) => i.severity === 'error').length, avisos: check.issues.filter((i) => i.severity === 'warn').length },
      prosa: { marcadores: ex.total, recuperados: ex.recuperados, faltantes: ex.faltantes.map((f) => `${f.arquivo}: ${f.id} (${f.motivo})`), parciais: ex.parciais.map((f) => `${f.arquivo}: ${f.id}`) },
      run: provas.run || null,
      revisao_do_curador: provas.revisao_do_curador || null,
    },
  };
  writeFileSync(join(destino, 'modelo.yaml'), `# Squad-modelo: identidade e provas. Um modelo é "ouro" quando check_squad sai limpo, um run medido\n# passa a régua da meta e o curador revisou a prosa; até lá é modelo, não ouro.\n# Escolha semântica (o chefe decide pelo pedido do usuário): acrescente \`gatilhos\` (frases; \`a + b\` exige as duas,\n# \`prefix*\` casa o começo), \`nao_use_para\` (frases que afastam), \`pedidos_exemplo\` (pedidos que DEVEM escolher\n# este modelo) e \`pedidos_fora\` (pedidos que NÃO podem); \`npx legalsquad squad-modelo --testar\` confere os dois últimos.\n${emitirYaml(meta)}\n`, 'utf8');
  return { id: idFinal, dir: destino, extracao: ex, check };
}

// ───────────────────────── escolha semântica ─────────────────────────
//
// O usuário pede a peça em linguagem natural e o chefe escolhe o modelo: nada
// de terminal para ele. O que decide é o `modelo.yaml`: `gatilhos` (frases que
// o pedido contém: "réplica", "manifestar sobre a contestação"), `nao_use_para`
// (frases que afastam: "contestar", "trabalhista") e as palavras de nome, peça
// e descrição. Ranking determinístico e explicado (`casou_por`, `bloqueado_por`),
// para o chefe repassar o motivo em uma linha; empate ou nada acima do piso
// volta como `ambiguo`/`nenhum`, e aí ele pergunta ou propõe o Arquiteto.

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const PALAVRAS_VAZIAS = new Set(['a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'e', 'ou', 'que', 'para', 'por', 'com', 'sem', 'ao', 'aos', 'se', 'ser', 'sobre', 'como', 'preciso', 'quero', 'fazer', 'faz', 'me', 'minha', 'meu', 'nossa', 'nosso', 'cliente', 'peca', 'processo', 'caso']);
const tokens = (t) => normalizar(t).split(' ').filter((x) => x.length > 2 && !PALAVRAS_VAZIAS.has(x));
/**
 * Frase contida no pedido. `a + b` exige as duas partes, em qualquer ordem
 * ("manifestar + contestação"); `respond*` casa qualquer palavra com esse começo
 * (respondo, responder, respondemos).
 */
const contemFrase = (pedido, frase) => {
  const partes = String(frase).split(' + ').map((f) => f.trim()).filter(Boolean);
  return partes.length > 0 && partes.every((f) => {
    const prefixo = f.endsWith('*');
    const n = normalizar(prefixo ? f.slice(0, -1) : f);
    return n.length > 0 && (prefixo ? ` ${pedido} `.includes(` ${n}`) : ` ${pedido} `.includes(` ${n} `));
  });
};

export const PISO_DE_ESCOLHA = 10;
export const FOLGA_DE_ESCOLHA = 5;

/** Pontua cada modelo contra o pedido. Devolve a lista ordenada, com os motivos. */
export function rankearModelos(pedido, modelos) {
  const p = normalizar(pedido);
  const toks = new Set(tokens(pedido));
  return modelos.map((m) => {
    const meta = m.meta || {};
    const casou = [];
    const bloqueado = [];
    let score = 0;
    for (const g of lista(meta.gatilhos)) if (contemFrase(p, g)) { score += 10 + Math.min(5, normalizar(String(g).replace(/ \+ /g, ' ')).split(' ').length - 1) * 2; casou.push(String(g)); }
    for (const n of lista(meta.nao_use_para)) if (contemFrase(p, n)) bloqueado.push(String(n));
    const vocab = new Set(tokens(`${meta.nome || ''} ${meta.peca || ''} ${meta.descricao || ''}`));
    const comuns = [...toks].filter((t) => vocab.has(t));
    if (comuns.length) { score += Math.min(9, comuns.length * 3); casou.push(`palavras: ${comuns.join(', ')}`); }
    return { id: m.id, nome: meta.nome || m.id, score, casou_por: casou, bloqueado_por: bloqueado, completo: m.completo, ouro: meta.provas?.ouro === true || meta.provas?.ouro === 'true' };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const lista = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Decide: `escolha` (um modelo claramente acima do piso e dos outros), `ambiguo`
 * (dois ou mais perto demais) ou `nenhum`. Nunca escolhe modelo bloqueado.
 */
export function escolherModelo(pedido, modelos) {
  const ranking = rankearModelos(pedido, modelos);
  const elegiveis = ranking.filter((r) => r.completo && !r.bloqueado_por.length && r.score >= PISO_DE_ESCOLHA);
  if (!elegiveis.length) {
    const bloq = ranking.filter((r) => r.bloqueado_por.length && r.score >= PISO_DE_ESCOLHA);
    return { decisao: 'nenhum', ranking, motivo: bloq.length ? `${bloq[0].nome} casou pelo pedido mas foi afastado (${bloq[0].bloqueado_por.join('; ')})` : 'nenhum modelo cobre o pedido' };
  }
  if (elegiveis.length > 1 && elegiveis[0].score - elegiveis[1].score < FOLGA_DE_ESCOLHA) {
    return { decisao: 'ambiguo', ranking, candidatos: elegiveis.slice(0, 3), motivo: `mais de um modelo cobre o pedido: ${elegiveis.slice(0, 3).map((e) => e.nome).join(' · ')}` };
  }
  const e = elegiveis[0];
  return { decisao: 'escolha', ranking, escolha: e, motivo: `${e.nome} (casou por ${e.casou_por.join('; ')})${e.ouro ? '' : '; modelo sem run medido acima da régua, ainda não é ouro'}` };
}

/**
 * Régua da curadoria: cada modelo declara `pedidos_exemplo` (pedidos que DEVEM
 * escolhê-lo) e, se quiser, `pedidos_fora` (pedidos que NÃO podem escolhê-lo,
 * como o pedido do modelo vizinho). Roda a escolha real, com todos os modelos
 * instalados, e devolve as falhas com o ranking, para o curador ajustar
 * `gatilhos`/`nao_use_para` sem adivinhar. Um modelo sem exemplos é avisado,
 * não aprovado em silêncio.
 */
export function testarModelos(modelos) {
  const casos = [];
  const semExemplos = [];
  for (const m of modelos) {
    const ex = lista(m.meta?.pedidos_exemplo);
    if (!ex.length) semExemplos.push(m.id);
    for (const p of ex) casos.push({ modelo: m.id, pedido: String(p), esperado: 'escolha' });
    for (const p of lista(m.meta?.pedidos_fora)) casos.push({ modelo: m.id, pedido: String(p), esperado: 'fora' });
  }
  const falhas = [];
  for (const c of casos) {
    const r = escolherModelo(c.pedido, modelos);
    const obtido = r.decisao === 'escolha' ? r.escolha.id : r.decisao;
    const ok = c.esperado === 'escolha' ? obtido === c.modelo : obtido !== c.modelo;
    if (!ok) falhas.push({ ...c, obtido, motivo: r.motivo, ranking: r.ranking.slice(0, 3).map((x) => `${x.id}:${x.score}${x.bloqueado_por.length ? ' (afastado)' : ''}`) });
  }
  return { total: casos.length, ok: casos.length - falhas.length, falhas, sem_exemplos: semExemplos };
}

/** Code livre para um modelo: o id, ou id-2, id-3… quando já existe. */
export function codeLivre(cwd, base) {
  const squadsDir = join(cwd, 'squads');
  if (!existsSync(join(squadsDir, base))) return base;
  for (let n = 2; n < 100; n++) if (!existsSync(join(squadsDir, `${base}-${n}`))) return `${base}-${n}`;
  falha(`não há code livre para ${base}`);
}

/** Copia um modelo para outra raiz (o curador leva o modelo do projeto para a área). */
export function copiarModelo(id, { cwd, destino }) {
  const modelo = listarModelos(cwd).find((m) => m.id === id);
  if (!modelo) falha(`modelo «${id}» não existe`);
  const alvo = isAbsolute(destino) ? destino : resolve(cwd, destino);
  mkdirSync(alvo, { recursive: true });
  cpSync(modelo.dir, join(alvo, basename(modelo.dir)), { recursive: true });
  return join(alvo, basename(modelo.dir));
}

/** CLI: `npx legalsquad squad-modelo [<id> --code <code>] [--para "<pedido>" [--criar]] [--extrair <squad> --id <id>] [--testar] [--json]`. */
export function squadModeloCli(positional, cwd, values = {}) {
  const json = values.json === true;
  try {
    if (values.testar === true) {
      const modelos = listarModelos(cwd);
      const t = testarModelos(modelos);
      if (json) { console.log(JSON.stringify({ success: t.falhas.length === 0, ...t }, null, 2)); return { success: t.falhas.length === 0 }; }
      console.log(`  ${t.ok}/${t.total} pedido(s) de exemplo escolhem o modelo certo (${modelos.length} modelo(s) em ${PASTA_DE_MODELOS}/)`);
      for (const f of t.falhas) {
        console.log(`  ✖ ${f.modelo}: "${f.pedido}"`);
        console.log(`      ${f.esperado === 'escolha' ? 'devia escolher este modelo' : 'não podia escolher este modelo'}, obteve ${f.obtido} (${f.motivo})`);
        console.log(`      ranking: ${f.ranking.join(' · ')}`);
      }
      for (const id of t.sem_exemplos) console.log(`  ⚠ ${id}: sem pedidos_exemplo no modelo.yaml, nada a testar`);
      return { success: t.falhas.length === 0 };
    }
    if (values.para) {
      const pedido = String(values.para);
      const d = escolherModelo(pedido, listarModelos(cwd));
      let criado = null;
      if (d.decisao === 'escolha' && values.criar === true) {
        const r = instanciarModelo(d.escolha.id, { cwd, code: values.code ? String(values.code) : codeLivre(cwd, d.escolha.id) });
        criado = { code: r.code, dir: r.dir, marcadores_restantes: r.manifesto.marcadores, avisos: r.manifesto.avisos, check: { erros: r.check.issues.filter((i) => i.severity === 'error').length, avisos: r.check.issues.filter((i) => i.severity === 'warn').length } };
      }
      if (json) { console.log(JSON.stringify({ success: true, decisao: d.decisao, motivo: d.motivo, escolha: d.escolha || null, candidatos: d.candidatos || null, ranking: d.ranking.slice(0, 5), criado }, null, 2)); return { success: true }; }
      console.log(`  Pedido: "${pedido}"`);
      console.log(`  Decisão: ${d.decisao}${d.escolha ? ` → ${d.escolha.id}` : ''} (${d.motivo})`);
      for (const r of d.ranking.slice(0, 5)) console.log(`    ${r.id}: ${r.score}${r.bloqueado_por.length ? ` (bloqueado: ${r.bloqueado_por.join('; ')})` : ''}${r.casou_por.length ? ` · ${r.casou_por.join('; ')}` : ''}`);
      if (criado) console.log(`  ✓ criado squads/${criado.code}/ (${criado.check.erros} erro(s), ${criado.check.avisos} aviso(s) no check-squad)${criado.avisos.length ? `\n  ⚠ ${criado.avisos.join('\n  ⚠ ')}` : ''}`);
      return { success: true };
    }
    if (values.extrair) {
      const r = extrairModelo(String(values.extrair), { cwd, id: values.id ? String(values.id) : undefined, nome: values.nome, descricao: values.descricao, area: values.area, peca: values.peca, polo: values.polo, forcar: values.forcar === true });
      if (json) { console.log(JSON.stringify({ success: true, id: r.id, dir: r.dir, recuperados: r.extracao.recuperados, total: r.extracao.total, faltantes: r.extracao.faltantes, parciais: r.extracao.parciais }, null, 2)); return { success: true }; }
      console.log(`Modelo: ${r.id}`);
      console.log(`  ✓ gravado em ${PASTA_DE_MODELOS}/${r.id}/ (design.yaml, prosa.yaml, modelo.yaml)`);
      console.log(`  ✓ prosa de ${r.extracao.recuperados} de ${r.extracao.total} marcador(es) recuperada`);
      for (const a of r.extracao.avisos || []) console.log(`  ⚠ ${a}`);
      for (const f of r.extracao.faltantes.slice(0, 12)) console.log(`  ⚠ ${f.arquivo}: ${f.id} (${f.motivo})`);
      if (r.extracao.faltantes.length > 12) console.log(`  ⚠ … e mais ${r.extracao.faltantes.length - 12}`);
      if (r.extracao.parciais.length) console.log(`  ⚠ ${r.extracao.parciais.length} marcador(es) recuperado(s) por âncora parcial (texto fixo mudou desde o Build): ${r.extracao.parciais.slice(0, 6).map((x) => `${x.arquivo}: ${x.id}`).join('; ')}${r.extracao.parciais.length > 6 ? ' …' : ''}`);
      console.log(`  check-squad da origem: ${r.check.issues.filter((i) => i.severity === 'error').length} erro(s), ${r.check.issues.filter((i) => i.severity === 'warn').length} aviso(s)`);
      return { success: true };
    }
    if (!positional) {
      const modelos = listarModelos(cwd);
      if (json) { console.log(JSON.stringify({ success: true, modelos: modelos.map((m) => ({ id: m.id, completo: m.completo, ...m.meta })) }, null, 2)); return { success: true }; }
      if (!modelos.length) { console.log(`  Nenhum squad-modelo em ${PASTA_DE_MODELOS}/. Um pacote de área pode trazê-los; \`squad-modelo --extrair <squad>\` cria um a partir de um squad construído.`); return { success: true }; }
      console.log('  Squads-modelo disponíveis:');
      for (const m of modelos) {
        const p = m.meta?.provas || {};
        const run = p.run && typeof p.run === 'object' ? ` · run ${p.run.nota ?? '?'}/100 (${p.run.ritmo ?? '?'}, ${p.run.data ?? '?'})` : ' · sem run medido';
        console.log(`    ${m.id}${m.completo ? '' : ' (incompleto)'}  ${m.meta?.nome || ''}${m.meta?.descricao ? ': ' + m.meta.descricao : ''}`);
        console.log(`      ${m.meta?.area ? `área ${m.meta.area} · ` : ''}${m.meta?.peca ? `peça ${m.meta.peca} · ` : ''}${m.meta?.polo ? `polo ${m.meta.polo} · ` : ''}check-squad ${p.check_squad ? `${p.check_squad.erros} erro(s), ${p.check_squad.avisos} aviso(s)` : '?'}${run}`);
      }
      console.log('  Criar: `npx legalsquad squad-modelo <id> --code <code>`');
      return { success: true };
    }
    const r = instanciarModelo(String(positional), { cwd, code: values.code ? String(values.code) : undefined });
    const erros = r.check.issues.filter((i) => i.severity === 'error');
    const avisos = r.check.issues.filter((i) => i.severity === 'warn');
    if (json) { console.log(JSON.stringify({ success: erros.length === 0, code: r.code, dir: r.dir, manifesto: r.manifesto, check: r.check.issues }, null, 2)); return { success: erros.length === 0 }; }
    console.log(`Squad: ${r.code} (do modelo ${r.id})`);
    console.log(`  ✓ ${r.manifesto.arquivos} arquivo(s) compilados, ${r.manifesto.prosa?.preenchidos ?? 0} marcador(es) preenchidos pela prosa do modelo, ${r.manifesto.marcadores} restante(s)`);
    for (const a of r.manifesto.avisos) console.log(`  ⚠ ${a}`);
    for (const i of erros) console.log(`  ✖ [${i.code}] ${i.detail}`);
    for (const i of avisos) console.log(`  ⚠ [${i.code}] ${i.detail}`);
    console.log(erros.length ? `  ${erros.length} erro(s) no check-squad` : `  ✓ check-squad: estrutura íntegra${avisos.length ? ` (${avisos.length} aviso(s))` : ''}`);
    console.log(`  Próximo: copie os autos para squads/${r.code}/autos/ e rode \`npm run autos:md\`; depois /legalsquad run ${r.code}.`);
    return { success: erros.length === 0 };
  } catch (erro) {
    if (!(erro instanceof ErroDeModelo) && !(erro instanceof ErroDeCompilacaoDeSquad)) throw erro;
    if (json) console.log(JSON.stringify({ success: false, error: erro.message }, null, 2));
    else console.error(`  ✖ ${erro.message}`);
    return { success: false };
  }
}
