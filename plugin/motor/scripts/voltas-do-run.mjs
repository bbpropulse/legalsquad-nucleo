#!/usr/bin/env node
/**
 * As voltas de um run: o que disparou cada versão da peça, lido do que o run deixou em disco (sem
 * token, sem rede, só leitura). Feito em 10/11/2026 para o run da resposta a ofício do MP (37
 * versões, 6 finais): antes dele, cada vai e vem era explicado caso a caso.
 *
 * Lê `review-state.json` (laços atuais e histórico), `run-state.json` (as respostas do
 * profissional), as pastas `vN/` e `_tmp/agentes.jsonl` (os despachos), e diz:
 *   - por versão: a hora, o arquivo, o gatilho (a decisão de gate ou a resposta do profissional que
 *     veio logo antes) e se é cópia da versão anterior do mesmo arquivo;
 *   - por final: quantos verificadores o Citation Gate final despachou e quanto tempo o laço levou;
 *   - o placar: rodadas abertas pelo profissional × pelos gates, cópias, verificadores por final.
 *
 * Uso: node scripts/voltas-do-run.mjs <pasta do run> [--json]
 *      (a pasta é squads/<nome>/output/<run_id>)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const lerJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } };
const hora = (t) => new Date(t).toISOString().slice(11, 19);

/** Os eventos do run em ordem: versões, decisões de gate, aberturas de laço, respostas e despachos. */
/**
 * Onde estão os ledgers: na pasta do run, depois que ele fecha; na do squad, enquanto o run aberto é
 * este (o `run-state.json` do squad tem o mesmo runId). Medido em 10/11/2026: o run em andamento
 * não era lido.
 */
export function ledgersDoRun(runDir) {
  if (existsSync(join(runDir, 'review-state.json'))) return runDir;
  const squad = resolve(runDir, '..', '..');
  const aberto = lerJson(join(squad, 'run-state.json'));
  return aberto && aberto.runId === basename(resolve(runDir)) && existsSync(join(squad, 'review-state.json')) ? squad : null;
}

export function eventosDoRun(runDir) {
  const ev = [];
  const base = ledgersDoRun(runDir) || runDir;
  const rs = lerJson(join(base, 'review-state.json')) || {};
  const lacos = [
    ...Object.entries(rs.loops || {}).map(([g, l]) => [g, l]),
    ...Object.entries(rs.historico || {}).flatMap(([g, ls]) => (Array.isArray(ls) ? ls : [ls]).map((l) => [g, l])),
  ];
  for (const [gate, l] of lacos) {
    if (!l) continue;
    if (l.aberto_em) ev.push({ t: Date.parse(l.aberto_em), tipo: 'abre', gate, laco: l.loop });
    for (const c of l.cycles || []) {
      const d = c.decision || {};
      const vozes = (c.verdicts || []).map((v) => v.reviewer);
      ev.push({ t: Date.parse(c.em), tipo: 'decisao', gate, laco: l.loop, acao: d.action, motivo: d.reason, vozes, fixes: d.fixes || [], ajustes: d.ajustes || [] });
    }
  }
  const run = lerJson(join(base, 'run-state.json')) || {};
  for (const h of run.checkpoints_historico || []) ev.push({ t: Date.parse(h.em), tipo: 'resposta', parada: h.step, resposta: String(h.resposta || '') });
  for (const v of readdirSync(runDir).filter((x) => /^v\d+$/.test(x))) {
    for (const f of readdirSync(join(runDir, v)).filter((x) => /\.md$/.test(x))) {
      const p = join(runDir, v, f);
      ev.push({ t: statSync(p).mtimeMs, tipo: 'versao', versao: v, arquivo: f, sha: createHash('sha256').update(readFileSync(p)).digest('hex') });
    }
  }
  const ag = join(runDir, '_tmp', 'agentes.jsonl');
  if (existsSync(ag)) {
    for (const linha of readFileSync(ag, 'utf-8').split('\n').filter(Boolean)) {
      const a = (() => { try { return JSON.parse(linha); } catch { return null; } })();
      if (a && a.ev === 'pedido') ev.push({ t: Date.parse(a.em), tipo: 'despacho', agente: a.tipo, descricao: a.descricao || '' });
    }
  }
  return ev.filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
}

/** O gatilho de uma versão: a última decisão que pede texto novo, ou a resposta do profissional, antes dela. */
function gatilhoAntes(ev, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const e = ev[k];
    if (e.tipo === 'versao') return null;
    if (e.tipo === 'resposta') return { origem: 'profissional', texto: `${e.parada}: ${e.resposta.slice(0, 140)}` };
    if (e.tipo === 'decisao' && (e.vozes || []).includes('profissional')) return { origem: 'profissional', texto: `${e.gate}: ${(e.fixes[0] || '').slice(0, 140)}` };
    if (e.tipo === 'decisao' && e.acao === 'revise') return { origem: 'gate', texto: `${e.gate} (${e.vozes.join('+')}): ${(e.fixes[0] || '').slice(0, 140)}` };
    if (e.tipo === 'decisao' && e.ajustes && e.ajustes.length) return { origem: 'gate', texto: `${e.gate} (${e.vozes.join('+')}), ${e.ajustes.length} ajuste(s): ${e.ajustes[0].slice(0, 120)}` };
  }
  return null;
}

export function voltasDoRun(runDir) {
  const ev = eventosDoRun(runDir);
  const versoes = [];
  const ultimoSha = new Map();
  let gatilho = null;
  ev.forEach((e, i) => {
    if (e.tipo !== 'versao') return;
    // Versão sem gatilho próprio herda o da anterior (o redator grava a minuta e o revisor a revisão).
    gatilho = gatilhoAntes(ev, i) || gatilho;
    const tipoDeArquivo = e.arquivo.replace(/-(minuta|final)\.md$/, '-$1');
    const copia = ultimoSha.get(tipoDeArquivo) === e.sha;
    ultimoSha.set(tipoDeArquivo, e.sha);
    versoes.push({ versao: e.versao, hora: hora(e.t), t: e.t, arquivo: e.arquivo, final: /-final\.md$/.test(e.arquivo), copia, gatilho });
  });
  // Por final: os verificadores despachados depois dela e antes da próxima versão, e o tempo do laço.
  const finais = versoes.filter((v) => v.final).map((v) => {
    const proxima = versoes.find((x) => x.t > v.t);
    const ate = proxima ? proxima.t : Infinity;
    const janela = ev.filter((e) => e.t >= v.t && e.t < ate);
    const verificadores = janela.filter((e) => e.tipo === 'despacho' && e.agente === 'verificador-citacoes').length;
    const decisaoFinal = janela.find((e) => e.tipo === 'decisao' && e.gate === 'citacao');
    const aberturas = janela.filter((e) => e.tipo === 'abre' && e.gate === 'citacao').length;
    const fim = decisaoFinal ? decisaoFinal.t : null;
    return { versao: v.versao, verificadores, aberturas_do_laco: aberturas, fechou: Boolean(decisaoFinal), minutos: fim ? Math.round((fim - v.t) / 6000) / 10 : null, proxima: proxima ? proxima.versao : null };
  });
  const rodadas = { profissional: 0, gate: 0 };
  let anterior = null;
  for (const v of versoes) {
    if (v.gatilho && v.gatilho !== anterior) rodadas[v.gatilho.origem] += 1;
    anterior = v.gatilho;
  }
  return {
    run: runDir,
    versoes: versoes.map(({ t, ...v }) => v),
    finais,
    placar: {
      versoes: versoes.length,
      finais: finais.length,
      copias: versoes.filter((v) => v.copia).length,
      rodadas_do_profissional: rodadas.profissional,
      rodadas_dos_gates: rodadas.gate,
      verificadores_nos_finais: finais.reduce((n, f) => n + f.verificadores, 0),
      finais_sem_fechar: finais.filter((f) => !f.fechou).map((f) => f.versao),
      laco_final_reaberto: finais.filter((f) => f.aberturas_do_laco > 1).map((f) => f.versao),
    },
  };
}

function texto(r) {
  const linhas = [`Voltas do run ${r.run}`, ''];
  for (const v of r.versoes) {
    const g = v.gatilho ? `${v.gatilho.origem === 'profissional' ? 'PROFISSIONAL' : 'gate'}: ${v.gatilho.texto}` : 'primeira redação';
    linhas.push(`${v.versao.padEnd(4)} ${v.hora}  ${v.arquivo.padEnd(34)} ${v.copia ? '[CÓPIA] ' : ''}${g}`);
  }
  linhas.push('', 'Finais:');
  for (const f of r.finais) linhas.push(`  ${f.versao}: ${f.verificadores} verificador(es), laço aberto ${f.aberturas_do_laco}x, ${f.fechou ? `fechou em ${f.minutos} min` : 'NÃO FECHOU'}${f.proxima ? `; depois veio a ${f.proxima}` : ''}`);
  const p = r.placar;
  linhas.push('', `Placar: ${p.versoes} versões, ${p.finais} finais, ${p.copias} cópia(s); rodadas abertas pelo profissional ${p.rodadas_do_profissional}, pelos gates ${p.rodadas_dos_gates}; ${p.verificadores_nos_finais} verificador(es) nos finais${p.finais_sem_fechar.length ? `; finais sem fechar: ${p.finais_sem_fechar.join(', ')}` : ''}${p.laco_final_reaberto.length ? `; laço final reaberto em: ${p.laco_final_reaberto.join(', ')}` : ''}.`);
  return linhas.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir || !ledgersDoRun(dir)) {
    console.error('uso: node scripts/voltas-do-run.mjs <squads/<nome>/output/<run_id>> [--json]  (a pasta do run; o run aberto é lido pelos ledgers do squad)');
    process.exit(1);
  }
  const r = voltasDoRun(resolve(dir));
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : texto(r));
}
