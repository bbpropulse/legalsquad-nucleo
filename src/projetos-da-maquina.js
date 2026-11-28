// Os projetos LegalSquad desta máquina (0.9.152).
//
// Trocar o motor já basta para o motor novo rodar em todo projeto: o `npx legalsquad` de cada pasta lê
// `~/.legalsquad/motor.json`. O que fica velho é o que o `init` COPIOU para dentro de cada projeto
// (`_legalsquad/`, `scripts/`, hooks, templates da IDE), e isso só o `update` naquela pasta troca. O aluno
// não usa terminal e não lembra de cada pasta onde iniciou o LegalSquad; por isso a máquina guarda a
// lista em `~/.legalsquad/projetos.json`, e atualizar o motor (`install-global`, ou `update --todos`)
// atualiza todos os projetos da lista.
//
// Quem grava na lista: o `init` e o `update` de cada projeto, e o SessionStart do plugin (a pasta da
// conversa). Projeto criado antes desta versão entra pela busca nas conversas do Claude Code
// (`~/.claude/projects/*/*.jsonl`, campo `cwd`), feita a cada `install-global`.
//
// A lista é local e só tem caminhos de pasta, datas e a versão de cada projeto: nada dela sai da máquina.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { raizDoProjeto, ehCasaLegalSquad } from './fs-utils.js';

export const ARQUIVO = 'projetos.json';
// Um run que gravou o estado há menos que isto está rodando: atualizar os scripts no meio dele pode
// deixar o estado de um lado e o script de outro. Esse projeto fica para a próxima vez.
export const JANELA_RUN_ATIVO_MS = 2 * 60 * 60 * 1000;

// `LEGALSQUAD_PROJETOS` troca o arquivo da lista (a suíte de testes usa um descartável: um `init` de teste
// não pode entrar na lista da máquina de quem roda os testes).
export function caminhoDaLista(home = homedir()) {
  return process.env.LEGALSQUAD_PROJETOS || join(home, '.legalsquad', ARQUIVO);
}

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

/** A lista como está no disco; [] se ausente ou ilegível. */
export async function lerProjetos(home = homedir()) {
  try {
    const lido = JSON.parse(await readFile(caminhoDaLista(home), 'utf-8'));
    const lista = Array.isArray(lido?.projetos) ? lido.projetos : [];
    return lista.filter((p) => p && typeof p.caminho === 'string' && p.caminho);
  } catch {
    return [];
  }
}

async function gravarProjetos(home, projetos) {
  const caminho = caminhoDaLista(home);
  await mkdir(dirname(caminho), { recursive: true });
  const ordenada = [...projetos].sort((a, b) => a.caminho.localeCompare(b.caminho));
  const conteudo = JSON.stringify({ sobre: 'Pastas onde o LegalSquad foi iniciado nesta máquina. Atualizar o motor atualiza todas.', projetos: ordenada }, null, 2) + '\n';
  // Troca atômica: duas conversas podem gravar ao mesmo tempo.
  const temporario = `${caminho}.${process.pid}.tmp`;
  await writeFile(temporario, conteudo, 'utf-8');
  await rename(temporario, caminho);
}

function versaoDoProjeto(dir) {
  try {
    return readFileSync(join(dir, '_legalsquad', '.legalsquad-version'), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Acrescenta (ou atualiza) a pasta na lista. `dir` pode ser uma pasta de dentro do projeto: vale a raiz,
 * a mesma regra da CLI. Sem projeto LegalSquad em `dir`, não grava nada. Devolve a entrada ou null.
 */
export async function registrarProjeto(dir, { home = homedir(), atualizado = false } = {}) {
  const raiz = raizDoProjeto(dir);
  if (!raiz) return null;
  const caminho = real(raiz);
  const projetos = await lerProjetos(home);
  const i = projetos.findIndex((p) => real(p.caminho) === caminho);
  const antes = i >= 0 ? projetos[i] : null;
  const entrada = {
    caminho,
    registrado_em: antes?.registrado_em || hoje(),
    ...(atualizado ? { atualizado_em: hoje() } : antes?.atualizado_em ? { atualizado_em: antes.atualizado_em } : {}),
    versao: versaoDoProjeto(caminho) || antes?.versao || null,
  };
  if (antes && JSON.stringify(antes) === JSON.stringify(entrada)) return entrada;
  if (i >= 0) projetos[i] = entrada;
  else projetos.push(entrada);
  await gravarProjetos(home, projetos);
  return entrada;
}

/** Tira da lista as pastas dadas (projeto apagado ou que deixou de ser LegalSquad). */
async function retirarDaLista(home, caminhos) {
  if (!caminhos.length) return;
  const fora = new Set(caminhos.map(real));
  const projetos = (await lerProjetos(home)).filter((p) => !fora.has(real(p.caminho)));
  await gravarProjetos(home, projetos);
}

// Lê só o começo do arquivo: o `cwd` aparece nas primeiras linhas e as conversas podem ter centenas de MB.
function cwdsDoInicio(arquivo, bytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(arquivo, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const texto = buf.subarray(0, n).toString('utf-8');
    return [...new Set([...texto.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)].map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return null;
      }
    }).filter(Boolean))];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Os projetos LegalSquad que aparecem nas conversas do Claude Code desta máquina: para cada conversa, a
 * pasta onde ela abriu (`cwd`) e a raiz LegalSquad dessa pasta, se houver. É como os projetos criados
 * antes da lista entram nela, sem o aluno ter de lembrar onde estão.
 */
export function descobrirPelasConversas(home = homedir(), { claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude') } = {}) {
  const base = join(claudeDir, 'projects');
  const raizes = new Set();
  let pastas;
  try {
    pastas = readdirSync(base);
  } catch {
    return [];
  }
  const vistos = new Set();
  for (const p of pastas) {
    let arquivos;
    try {
      arquivos = readdirSync(join(base, p)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const a of arquivos) {
      for (const cwd of cwdsDoInicio(join(base, p, a))) {
        if (vistos.has(cwd)) continue;
        vistos.add(cwd);
        if (!existsSync(cwd)) continue;
        const raiz = raizDoProjeto(cwd);
        if (raiz) raizes.add(real(raiz));
      }
    }
  }
  return [...raizes].sort();
}

// Pasta que fica de fora da atualização em massa: tem `_legalsquad/.versao-fixa` (cópia de medição, caso
// guardado numa versão de propósito) ou é o código-fonte do próprio motor (o repositório e as cópias de
// trabalho dele também têm `_legalsquad/`, e o `update` gravaria os templates por cima do código).
export const MARCADOR_VERSAO_FIXA = '.versao-fixa';

export function motivoParaNaoAtualizar(dir) {
  if (existsSync(join(dir, '_legalsquad', MARCADOR_VERSAO_FIXA))) return 'versão fixada (_legalsquad/.versao-fixa)';
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    if (pkg?.name === 'legalsquad' && existsSync(join(dir, 'src', 'install-global.js'))) return 'código-fonte do motor';
  } catch {
    // projeto sem package.json do motor
  }
  return null;
}

/** Há um run gravando estado agora (state.json de um squad ou de uma vaga mexido há pouco, com status de execução)? */
export function runEmAndamento(dir, { agora = Date.now(), janelaMs = JANELA_RUN_ATIVO_MS } = {}) {
  const squads = join(dir, 'squads');
  let nomes;
  try {
    nomes = readdirSync(squads);
  } catch {
    return null;
  }
  const estados = [];
  for (const s of nomes) {
    estados.push(join(squads, s, 'state.json'));
    try {
      for (const r of readdirSync(join(squads, s, 'runs'))) estados.push(join(squads, s, 'runs', r, 'state.json'));
    } catch {
      // squad sem vagas
    }
  }
  for (const e of estados) {
    try {
      const st = statSync(e);
      if (agora - st.mtimeMs > janelaMs) continue;
      const status = JSON.parse(readFileSync(e, 'utf-8'))?.status;
      if (status === 'running') return e;
    } catch {
      // ausente ou ilegível: não bloqueia
    }
  }
  return null;
}

// Guarda o que o update imprimiu para resumir depois: com vários projetos, a saída inteira de cada um
// não ajuda ninguém a ler o resultado.
async function quieto(fn) {
  const linhas = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => linhas.push(a.join(' '));
  console.error = (...a) => linhas.push(a.join(' '));
  try {
    return { resultado: await fn(), linhas };
  } catch (erro) {
    return { resultado: { success: false, erro: erro.message }, linhas };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/**
 * Atualiza todos os projetos da lista (mais os achados nas conversas, que entram na lista). `update` é a
 * função de update do motor, injetada para não criar dependência circular e para o teste.
 *
 * Devolve { atualizados, pulados, falhas, ausentes, retirados } com um item por projeto. Pula: a pasta
 * atual quando `pular` a traz (quem chamou já a atualizou), projeto com run gravando estado agora e pasta
 * que não está acessível (disco externo desligado: fica na lista). Tira da lista a pasta que existe mas
 * deixou de ser projeto LegalSquad.
 */
export async function atualizarTodos({ update, home = homedir(), descobrir = true, pular = [], opcoes = {}, agora = Date.now(), aoAndar = () => {} } = {}) {
  if (descobrir) {
    for (const raiz of descobrirPelasConversas(home)) await registrarProjeto(raiz, { home });
  }
  const lista = await lerProjetos(home);
  const jaFeitos = new Set(pular.map(real));
  const out = { atualizados: [], pulados: [], falhas: [], ausentes: [], retirados: [] };
  for (const p of lista) {
    const dir = p.caminho;
    if (jaFeitos.has(real(dir))) continue;
    if (!existsSync(dir)) {
      out.ausentes.push({ caminho: dir });
      continue;
    }
    if (!ehCasaLegalSquad(dir)) {
      out.retirados.push({ caminho: dir });
      continue;
    }
    const fixo = motivoParaNaoAtualizar(dir);
    if (fixo) {
      out.pulados.push({ caminho: dir, motivo: fixo, fixo: true });
      continue;
    }
    const ativo = runEmAndamento(dir, { agora });
    if (ativo) {
      out.pulados.push({ caminho: dir, motivo: 'run em andamento' });
      continue;
    }
    const antes = versaoDoProjeto(dir);
    aoAndar(dir);
    const { resultado, linhas } = await quieto(() => update(dir, opcoes));
    if (resultado && resultado.success !== false) {
      await registrarProjeto(dir, { home, atualizado: true });
      out.atualizados.push({ caminho: dir, de: antes, para: versaoDoProjeto(dir) });
    } else {
      out.falhas.push({ caminho: dir, erro: resultado?.erro || linhas.filter((l) => /⚠|erro|falh/i.test(l)).slice(-3).join(' | ') || 'update sem sucesso' });
    }
  }
  await retirarDaLista(home, out.retirados.map((r) => r.caminho));
  return out;
}

/** O resumo para a saída da CLI, uma linha por projeto. */
export function resumoDaAtualizacao(r) {
  const linhas = [];
  for (const a of r.atualizados) linhas.push(`  ✓ ${a.caminho}${a.de && a.para && a.de !== a.para ? ` (${a.de} → ${a.para})` : ''}`);
  for (const p of r.pulados) linhas.push(p.fixo ? `  ·  ${p.caminho}: ${p.motivo}; não é atualizada em massa` : `  ⏸  ${p.caminho}: ${p.motivo}; atualiza quando o run terminar (\`legalsquad update\` nela, ou o próximo \`update --todos\`)`);
  for (const f of r.falhas) linhas.push(`  ⚠️  ${f.caminho}: ${f.erro}`);
  for (const a of r.ausentes) linhas.push(`  ·  ${a.caminho}: pasta não acessível agora (disco desligado ou movida); continua na lista`);
  for (const t of r.retirados) linhas.push(`  ·  ${t.caminho}: não é mais um projeto LegalSquad; saiu da lista`);
  return linhas;
}
