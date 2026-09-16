#!/usr/bin/env node
// Varredura do DJEN — determinística, sem LLM (PLANO-ORQUESTRADOR.md, Fase 6).
//
// Consulta a API pública de comunicações do CNJ (Comunica API) por OAB/UF numa
// janela de datas e grava cada comunicação no cache local via `appendEntry`
// (dedupe pelo hash que o próprio DJEN emite). É o que alimenta as seções
// "Intimações" e "Prazos" do briefing matinal — hoje o agente monitor-dje-djen
// faz isso à mão com curl; aqui vira script do projeto, agendável.
//
// O que NÃO faz, de propósito:
// - não calcula `fatal` (a data fatal segue a best-practice de prazos, com o
//   profissional); o registro entra com `fatal: null` e o agente/skill completa;
// - não registra varredura quando a consulta falha: varredura que falhou não
//   pode parecer frescor;
// - não imprime o teor das comunicações — dado de processo fica no cache
//   privado (`_legalsquad/_memory/`, gitignored), nunca no terminal.
//
// Configuração da OAB (a primeira que existir vence):
//   flags  --oab 12345 --uf PE
//   env    LEGALSQUAD_OAB=12345 LEGALSQUAD_UF=PE
//   arquivo _legalsquad/_memory/djen.json  → {"oab":"12345","uf":"PE"}
//
// Uso:
//   node scripts/orchestra/djen-varredura.mjs [--desde AAAA-MM-DD] [--ate AAAA-MM-DD] [--dias N] [--dry-run] [--json]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, appendEntry, lastSweep, recordSweep, today, trackerPath } from './_lib.mjs';

export const URL_PADRAO = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const TEOR_MAX = 600;

/** Caminho do arquivo de configuração: vizinho do tracker, também privado. */
export function configPath() {
  return join(dirname(trackerPath()), 'djen.json');
}

/** OAB/UF: flags > ambiente > arquivo. Devolve `{oab, uf, origem}` ou `null`. */
export function lerConfig({ flags = {}, env = process.env } = {}) {
  const limpa = (v) => (v == null ? '' : String(v).trim());
  if (limpa(flags.oab) && limpa(flags.uf)) return { oab: limpa(flags.oab).replace(/\D/g, ''), uf: limpa(flags.uf).toUpperCase(), origem: 'flags' };
  if (limpa(env.LEGALSQUAD_OAB) && limpa(env.LEGALSQUAD_UF)) return { oab: limpa(env.LEGALSQUAD_OAB).replace(/\D/g, ''), uf: limpa(env.LEGALSQUAD_UF).toUpperCase(), origem: 'env' };
  const arquivo = configPath();
  if (existsSync(arquivo)) {
    try {
      const j = JSON.parse(readFileSync(arquivo, 'utf8'));
      if (limpa(j.oab) && limpa(j.uf)) return { oab: limpa(j.oab).replace(/\D/g, ''), uf: limpa(j.uf).toUpperCase(), origem: 'arquivo' };
    } catch { /* arquivo ilegível = não configurado */ }
  }
  return null;
}

/** Janela padrão: da véspera da última varredura (sobreposição de segurança) até hoje; sem varredura, 7 dias. */
export function janelaPadrao({ ultima = lastSweep(), hoje = today() } = {}) {
  const desde = ultima ? addDays(String(ultima).slice(0, 10), -1) : addDays(hoje, -7);
  return { desde, ate: hoje };
}

export function montarUrl(base, { oab, uf, desde, ate, pagina, porPagina }) {
  const u = new URL(base);
  u.searchParams.set('numeroOab', oab);
  u.searchParams.set('ufOab', uf);
  u.searchParams.set('dataDisponibilizacaoInicio', desde);
  u.searchParams.set('dataDisponibilizacaoFim', ate);
  u.searchParams.set('itensPorPagina', String(porPagina));
  u.searchParams.set('pagina', String(pagina));
  return u.toString();
}

function tipoDe(item) {
  const t = `${item.tipoComunicacao || ''} ${item.tipoDocumento || ''}`.toLowerCase();
  if (/intima/.test(t)) return 'intimacao';
  if (/senten/.test(t)) return 'sentenca';
  if (/decis/.test(t)) return 'decisao';
  if (/despach/.test(t)) return 'despacho';
  return 'publicacao';
}

function cancelado(item) {
  return item.ativo === false || /cancel/i.test(String(item.status || '')) || Boolean(String(item.motivo_cancelamento || '').trim());
}

/** Comunicação do DJEN → registro do tracker. `null` quando cancelada. */
export function mapearItem(item) {
  if (!item || typeof item !== 'object' || cancelado(item)) return null;
  const processo = String(item.numeroprocessocommascara || item.numero_processo || '').trim() || '?';
  const texto = String(item.texto || '').replace(/\s+/g, ' ').trim();
  const cabeca = [item.tipoComunicacao, item.nomeOrgao].filter(Boolean).join(' — ');
  const teor = `${cabeca ? `${cabeca}: ` : ''}${texto}`.slice(0, TEOR_MAX);
  const chave = String(item.hash || item.id || '').slice(0, 16);
  return {
    id: `${processo}|djen-${chave || 'sem-hash'}`,
    processo,
    tribunal: item.siglaTribunal || null,
    orgao: item.nomeOrgao || null,
    tipo: tipoDe(item),
    teor,
    cliente: null,
    prazo_dias: null,
    fatal: null,
    data_disponibilizacao: item.data_disponibilizacao || item.datadisponibilizacao || null,
    link: item.link || null,
    djen_id: item.id ?? null,
    origem: 'djen-varredura',
  };
}

async function buscarPagina(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error(`DJEN respondeu HTTP ${r.status}`);
    let j;
    try { j = await r.json(); } catch { throw new Error('DJEN não devolveu JSON'); }
    if (!j || typeof j !== 'object' || !Array.isArray(j.items)) throw new Error('DJEN devolveu JSON sem `items`');
    return j.items;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Faz a varredura. Devolve o resumo; lança em falha de rede/HTTP/JSON — e,
 * nesse caso, NÃO registra varredura. `fetchImpl` e `base` são injetáveis.
 */
export async function varrer({
  oab, uf, desde, ate, fetchImpl = globalThis.fetch, base = process.env.LEGALSQUAD_DJEN_URL || URL_PADRAO,
  dryRun = false, porPagina = 100, maxPaginas = 50, timeoutMs = 30_000,
} = {}) {
  if (!oab || !uf) throw new Error('OAB e UF são obrigatórias');
  if (!desde || !ate) ({ desde, ate } = { ...janelaPadrao(), ...(desde ? { desde } : {}), ...(ate ? { ate } : {}) });
  let pagina = 1;
  let total = 0;
  let novas = 0;
  let ignoradas = 0;
  const vistos = new Set();
  for (; pagina <= maxPaginas; pagina++) {
    const items = await buscarPagina(fetchImpl, montarUrl(base, { oab, uf, desde, ate, pagina, porPagina }), timeoutMs);
    for (const item of items) {
      total += 1;
      const entrada = mapearItem(item);
      if (!entrada) { ignoradas += 1; continue; }
      if (vistos.has(entrada.id)) continue;
      vistos.add(entrada.id);
      if (dryRun) { novas += 1; continue; }
      if (appendEntry(entrada).added) novas += 1;
    }
    if (items.length < porPagina) break;
  }
  const ultima_varredura = dryRun ? null : recordSweep();
  return { oab, uf, desde, ate, paginas: Math.min(pagina, maxPaginas), total, novas, ignoradas, dryRun, ultima_varredura };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const cfg = lerConfig({ flags: { oab: flag('--oab'), uf: flag('--uf') } });
  if (!cfg) {
    process.stderr.write(`DJEN: OAB não configurada — passe --oab e --uf, ou LEGALSQUAD_OAB/LEGALSQUAD_UF, ou grave ${configPath()} com {"oab":"…","uf":"…"}\n`);
    process.exit(1);
  }
  const dias = flag('--dias');
  const janela = { ...janelaPadrao(), ...(dias ? { desde: addDays(today(), -Number(dias)) } : {}) };
  const desde = flag('--desde') || janela.desde;
  const ate = flag('--ate') || janela.ate;
  const dryRun = args.includes('--dry-run');
  varrer({ ...cfg, desde, ate, dryRun })
    .then((r) => {
      if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ ...r, origem_config: cfg.origem }, null, 2)}\n`);
      else process.stdout.write(`varredura DJEN: OAB ${cfg.oab}/${cfg.uf} · ${r.desde}..${r.ate} · ${r.total} comunicação(ões) · ${r.novas} nova(s)${r.ignoradas ? ` · ${r.ignoradas} cancelada(s) ignorada(s)` : ''}${dryRun ? ' · dry-run (nada gravado)' : ''}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`DJEN: varredura falhou — ${err.message}. Nada gravado, varredura não registrada.\n`);
      process.exit(1);
    });
}
