// ---------------------------------------------------------------------------
// Squads de um projeto, com a ÁREA DE ORIGEM de cada um.
//
// Revisão de 22/09/2026: num escritório cível, o chefe reusou "Sala de Recursos
// Criminais" para embargos de declaração contra sentença cível, porque `squads/`
// recebe os squads prontos de todo pacote ligado (o criminal traz seis, o
// trabalhista três; o civil traz só modelos) e nada dizia de que área cada um
// veio. A área é um FILTRO do roteador: squad de outra área nunca é candidato a
// reuso, mesmo com o mesmo nome de peça.
//
// De onde vem a área, nesta ordem: `area:` declarado no squad.yaml (do
// profissional) › o modelo que o gerou (`_build/modelo-origem.json` → `area` do
// `modelo.yaml`) › o pacote que o trouxe (registro do depósito: `squads/<code>/
// squad.yaml` → `pack_id` → slug) › nenhuma (`sem_area`, nunca "outra área").
// ---------------------------------------------------------------------------
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ligacaoDoProjeto, normalizarSlugDeArea, ramosDoDeposito, slugDoPack } from './deposito.js';
import { listarModelos } from './squad-modelo.js';
import { casaArea, ramosDaArea } from './area.js';
import { escalarDeChave } from './squad-check.js';

const escalar = (y, chave) => escalarDeChave(String(y || ''), chave) || '';

function lerJsonOuNulo(caminho) {
  try { return JSON.parse(readFileSync(caminho, 'utf8')); } catch { return null; }
}

/** `Map<path, { pack_id }>` só das entradas `squads/` dos registros do depósito. */
function squadsDoDeposito(deposito) {
  const pasta = join(deposito, 'acervo', '_packs', '_arquivos');
  let nomes;
  try { nomes = readdirSync(pasta).filter((n) => n.endsWith('.json')); } catch { return null; }
  const mapa = new Map();
  for (const nome of nomes) {
    const registro = lerJsonOuNulo(join(pasta, nome));
    for (const a of registro?.arquivos || []) if (typeof a?.path === 'string' && a.path.startsWith('squads/')) mapa.set(a.path, { pack_id: registro.pack_id });
  }
  return mapa;
}

/**
 * Lista `squads/<code>/` (fora `_modelos` e pastas ocultas) com nome, meta, área e
 * origem da área. `registros` (Map path → { pack_id }) pode ser injetado nos testes;
 * por padrão vem do depósito ao qual o projeto está ligado.
 */
export function listarSquads(cwd, { registros = undefined } = {}) {
  const squadsDir = join(cwd, 'squads');
  if (!existsSync(squadsDir)) return [];
  let mapa = registros;
  if (mapa === undefined) {
    // Só as entradas `squads/` dos registros: o mapa inteiro do depósito tem dezenas de
    // milhares de skills e julgados, e aqui bastam os poucos squads que os pacotes trazem.
    const ligacao = ligacaoDoProjeto(cwd);
    mapa = ligacao?.deposito ? squadsDoDeposito(ligacao.deposito) : null;
  }
  const modelos = new Map(listarModelos(cwd).map((m) => [m.id, m.meta || {}]));
  const squads = [];
  for (const e of readdirSync(squadsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const yamlPath = join(squadsDir, e.name, 'squad.yaml');
    if (!existsSync(yamlPath)) continue;
    const y = readFileSync(yamlPath, 'utf8');
    const item = { code: e.name, nome: escalar(y, 'name') || e.name, goal: escalar(y, 'goal'), area: null, area_slug: null, origem_da_area: 'nenhuma', modelo: null, pacote: null };
    const declarada = escalar(y, 'area');
    const origem = lerJsonOuNulo(join(squadsDir, e.name, '_build', 'modelo-origem.json'));
    if (origem?.modelo) item.modelo = String(origem.modelo);
    const doPack = mapa?.get(`squads/${e.name}/squad.yaml`)?.pack_id || null;
    if (doPack) item.pacote = doPack;
    if (declarada) {
      item.area = declarada; item.origem_da_area = 'declarada';
    } else if (item.modelo && modelos.get(item.modelo)?.area) {
      item.area = String(modelos.get(item.modelo).area); item.origem_da_area = 'modelo';
    } else if (doPack && slugDoPack(doPack)) {
      item.area = slugDoPack(doPack); item.origem_da_area = 'pacote';
    }
    item.area_slug = item.area ? normalizarSlugDeArea(item.area) : null;
    squads.push(item);
  }
  return squads.sort((a, b) => a.code.localeCompare(b.code));
}

/** Separa os squads do projeto pela área do caso: `da_area`, `de_outra_area`, `sem_area`. */
export function squadsPorArea(cwd, areaPedida, opcoes = {}) {
  const todos = listarSquads(cwd, opcoes);
  // Ramos do curador ("família" mora no pacote civil); `opcoes.ramos` só nos testes.
  const ramos = opcoes.ramos ?? ramosDoDeposito(ligacaoDoProjeto(cwd)?.deposito);
  const area = areaPedida ? String(areaPedida) : null;
  const da_area = [];
  const de_outra_area = [];
  const sem_area = [];
  for (const s of todos) {
    if (!s.area) sem_area.push(s);
    else if (!area || casaArea(s.area, area, ramosDaArea(s.area, ramos))) da_area.push(s);
    else de_outra_area.push(s);
  }
  return { area_pedida: area, squads: todos, da_area, de_outra_area, sem_area };
}

/** CLI: `npx legalsquad squads [--area <área>] [--json]`. */
export function squadsCli(cwd, values = {}) {
  const r = squadsPorArea(cwd, values.area ? String(values.area) : null);
  if (values.json === true) {
    console.log(JSON.stringify({ success: true, ...r, da_area: r.da_area.map((s) => s.code), de_outra_area: r.de_outra_area.map((s) => s.code), sem_area: r.sem_area.map((s) => s.code) }, null, 2));
    return { success: true };
  }
  const linha = (s) => `    ${s.code.padEnd(30)} ${s.nome}${s.area ? ` · área ${s.area} (${s.origem_da_area})` : ' · sem área'}`;
  if (!r.squads.length) { console.log('  nenhum squad em squads/'); return { success: true }; }
  if (r.area_pedida) {
    console.log(`  Área do caso: ${r.area_pedida}`);
    console.log(`  Da área (${r.da_area.length}):`); for (const s of r.da_area) console.log(linha(s));
    console.log(`  De outra área (${r.de_outra_area.length}, nunca candidatos a reuso):`); for (const s of r.de_outra_area) console.log(linha(s));
    if (r.sem_area.length) { console.log(`  Sem área declarada (${r.sem_area.length}; declare \`area:\` no squad.yaml):`); for (const s of r.sem_area) console.log(linha(s)); }
  } else {
    console.log(`  ${r.squads.length} squad(s) em squads/:`); for (const s of r.squads) console.log(linha(s));
  }
  return { success: true };
}
