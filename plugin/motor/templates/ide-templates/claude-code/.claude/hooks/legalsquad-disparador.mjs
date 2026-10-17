#!/usr/bin/env node
/**
 * Disparador de máquina dos hooks do projeto LegalSquad: acha a raiz pelo ARQUIVO
 * tocado, não pela sessão.
 *
 * Medição dos moldes de 24/09/2026 (defeito 34, G12): os hooks de projeto são
 * registrados como `node "$CLAUDE_PROJECT_DIR/.claude/hooks/…"` (settings.json do
 * projeto, frontmatter da skill e dos agentes). Quando a sessão foi aberta em outra
 * pasta (o agente despachado de outra sessão, a pasta do caso dentro da casa do
 * escritório, o repositório do motor), `$CLAUDE_PROJECT_DIR` aponta a pasta da
 * sessão: o settings.json do projeto nem é carregado, e o frontmatter chama um
 * arquivo que não existe. O gate de redação e a guarda de memória (LGPD) não rodaram
 * no run de alimentos; o de citações só rodou pela cópia de máquina, que só avisa.
 *
 * Este arquivo é registrado UMA vez na máquina (`legalsquad install-global`, em
 * ~/.claude/settings.json), para `PreToolUse` e `PostToolUse` de Write|Edit. A cada
 * escrita ele sobe a partir de `tool_input.file_path` até achar `_legalsquad/`; sem
 * raiz, sai 0 sem ler nada (não é trabalho jurídico). Com raiz, roda os hooks DA
 * PRÓPRIA RAIZ (a cópia de `.claude/hooks/` que o init e o update mantêm na versão
 * do projeto), com a mesma entrada, `CLAUDE_PROJECT_DIR` apontando a raiz achada, e
 * devolve o código de saída e as mensagens deles:
 *
 * - `pre`  → `guarda-memoria.mjs` (bloqueia antes de gravar dado de cliente na
 *            memória do chefe). Roda sempre que há raiz: é barato (uma regex de
 *            caminho) e o settings.json do projeto não o registra.
 * - `post` → `verifica-redacao.mjs` e `verifica-citacoes.mjs`. Não roda quando a
 *            raiz achada É a pasta da sessão e o settings.json dela já registra os
 *            dois: aí os hooks do projeto estão vivos e rodar de novo só repete a
 *            mensagem. O de citações também não roda quando é byte a byte a cópia de
 *            máquina (`verifica-citacoes.mjs` ao lado deste arquivo), que o backstop
 *            do install-global já executa em toda escrita.
 *
 * Hook de projeto ausente numa raiz achada não é silêncio: dentro do escopo do gate
 * (memória do chefe no `pre`; `squads/*\/output/` no `post`) sai 2 dizendo que o gate
 * não rodou e como restaurá-lo (`legalsquad update` na raiz).
 *
 * Codex (fallback, mesmo arquivo): o install-global também o registra em
 * ~/.codex/hooks.json quando o Codex está na máquina. Lá a escrita de arquivo é o
 * `apply_patch`, e o payload não traz `file_path`: `tool_input.command` é o texto do
 * patch (`*** Add File: …`, `*** Update File: …`, `*** Move to: …`), com caminhos
 * relativos ao `cwd` do evento. Por isso os hooks do `.codex/hooks.json` do projeto,
 * que só leem `file_path`, saem 0 sem olhar nada, dentro ou fora da raiz. Aqui cada
 * arquivo do patch vira uma entrada no formato que os hooks do projeto já leem
 * (`Write` com `content` para arquivo novo, `Edit` com as linhas `+` em `new_string`
 * para alteração), e cada um acha a própria raiz. Arquivo apagado não passa por gate.
 *
 * Plugin do Claude Code: o mesmo arquivo viaja em `<plugin>/scripts/` e o
 * `hooks/hooks.json` do plugin o registra (pre e post), sem tocar em
 * settings.json. Quem também rodou o `install-global` teria o disparador duas
 * vezes em cada escrita; a cópia do plugin cede a vez quando a da máquina está
 * registrada em `~/.claude/settings.json` e existe no disco.
 *
 * Sem dependência e sem import de `src/`: é copiado para ~/.claude/hooks/,
 * ~/.codex/hooks/ e para o plugin.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MODO = process.argv[2] === 'pre' ? 'pre' : 'post';
const HOOKS = MODO === 'pre' ? ['guarda-memoria'] : ['verifica-redacao', 'verifica-citacoes'];
const ESCOPO = MODO === 'pre' ? /(?:^|\/)_legalsquad\/_memory\// : /(?:^|\/)squads\/[^/]+\/output\//;

function real(caminho) {
  try { return realpathSync(caminho); } catch { return resolve(caminho); }
}

/** Primeira pasta, subindo a partir do arquivo, que tem `_legalsquad/` (diretório). */
function raizDoProjeto(arquivo) {
  let dir = dirname(resolve(arquivo));
  for (;;) {
    try { if (statSync(join(dir, '_legalsquad')).isDirectory()) return dir; } catch { /* sobe */ }
    const acima = dirname(dir);
    if (acima === dir) return null;
    dir = acima;
  }
}

// `.Codex` (maiúscula) é a pasta que o motor criava até a 0.9.48; o Codex lê `.codex`.
// O `legalsquad update` renomeia, mas um projeto ainda não atualizado num sistema que
// diferencia maiúsculas (Linux) só tem a antiga: o gate continua achando o hook lá.
function hookDoProjeto(raiz, nome) {
  for (const pasta of ['.claude', '.codex', '.Codex']) {
    const caminho = join(raiz, pasta, 'hooks', `${nome}.mjs`);
    if (existsSync(caminho)) return caminho;
  }
  return null;
}

function projetoJaRegistra(raiz) {
  const sessao = process.env.CLAUDE_PROJECT_DIR;
  if (!sessao || real(sessao) !== real(raiz)) return false;
  try {
    const settings = readFileSync(join(raiz, '.claude', 'settings.json'), 'utf8');
    return HOOKS.every((h) => settings.includes(`${h}.mjs`));
  } catch {
    return false;
  }
}

/**
 * Esta cópia é a do plugin do Claude Code e a da máquina (install-global) também
 * está registrada? Então quem roda é a da máquina. `CLAUDE_PLUGIN_ROOT` só existe
 * no processo de hook de plugin (doc: plugins-reference, "Environment
 * variables"), então as cópias de ~/.claude e ~/.codex nunca entram aqui.
 */
let cedeAVez = null;
function copiaDoPluginCedeAVez() {
  if (cedeAVez !== null) return cedeAVez;
  cedeAVez = false;
  const plugin = process.env.CLAUDE_PLUGIN_ROOT;
  if (!plugin || !real(AQUI).startsWith(real(plugin))) return cedeAVez;
  const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  if (!existsSync(join(claude, 'hooks', 'legalsquad-disparador.mjs'))) return cedeAVez;
  try {
    cedeAVez = readFileSync(join(claude, 'settings.json'), 'utf8').includes('legalsquad-disparador.mjs');
  } catch {
    // sem settings.json: a da máquina não está registrada
  }
  return cedeAVez;
}

function mesmaCopiaDaMaquina(caminho, nome) {
  try { return readFileSync(caminho).equals(readFileSync(join(AQUI, `${nome}.mjs`))); } catch { return false; }
}

/**
 * Arquivos que um `apply_patch` do Codex toca, com o texto novo de cada um. As
 * linhas `+` são o que a escrita acrescenta (o que a guarda de memória precisa ver
 * antes); contexto e linhas `-` já estavam no arquivo. `Move to` troca o destino.
 */
function arquivosDoPatch(texto) {
  const ops = [];
  let atual = null;
  for (const linha of texto.split(/\r?\n/)) {
    const m = linha.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (m) { atual = { op: m[1], caminho: m[2].trim(), mais: [], menos: [] }; ops.push(atual); continue; }
    const mv = linha.match(/^\*\*\* Move to: (.+)$/);
    if (mv && atual) { atual.caminho = mv[1].trim(); continue; }
    if (!atual || linha.startsWith('***')) continue;
    if (linha.startsWith('+')) atual.mais.push(linha.slice(1));
    else if (linha.startsWith('-')) atual.menos.push(linha.slice(1));
  }
  return ops.filter((o) => o.op !== 'Delete');
}

function textoDoPatch(toolInput) {
  const c = toolInput.command;
  if (typeof c === 'string') return c.includes('*** Begin Patch') ? c : '';
  if (Array.isArray(c)) return c.find((p) => typeof p === 'string' && p.includes('*** Begin Patch')) || '';
  return '';
}

/** Roda os hooks do projeto de UM arquivo e devolve o código de saída. */
function disparar(arquivo, entrada, codex) {
  const raiz = raizDoProjeto(arquivo);
  if (!raiz) return 0;
  if (copiaDoPluginCedeAVez()) return 0;
  // No Codex, os hooks do projeto não enxergam o arquivo do patch: nada a repetir.
  if (MODO === 'post' && !codex && projetoJaRegistra(raiz)) return 0;
  const noEscopo = ESCOPO.test(arquivo.replace(/\\/g, '/'));
  let saida = 0;
  for (const nome of HOOKS) {
    const hook = hookDoProjeto(raiz, nome);
    if (!hook) {
      if (noEscopo) {
        process.stderr.write(`LegalSquad: o gate ${nome} do projeto ${raiz} não está instalado (${nome}.mjs ausente em .claude/hooks/ e .codex/hooks/), e ${arquivo} está no escopo dele. Rode \`legalsquad update\` nessa pasta para restaurar os hooks.\n`);
        saida = 2;
      }
      continue;
    }
    if (nome === 'verifica-citacoes' && mesmaCopiaDaMaquina(hook, nome)) continue;
    const r = spawnSync(process.execPath, [hook], {
      input: entrada,
      cwd: raiz,
      env: { ...process.env, CLAUDE_PROJECT_DIR: raiz },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error) {
      // O gate não chegou a rodar: dentro do escopo, isso é dito, não engolido.
      if (noEscopo) {
        process.stderr.write(`LegalSquad: o gate ${nome} de ${raiz} não rodou (${r.error.message}).\n`);
        saida = 2;
      }
      continue;
    }
    if (r.status === 2) saida = 2;
    else if (r.status !== 0 && saida === 0) saida = r.status ?? 1;
  }
  return saida;
}

let bruto = '';
try { bruto = readFileSync(0, 'utf8'); } catch { process.exit(0); }
let dados;
try { dados = JSON.parse(bruto); } catch { process.exit(0); }
const toolInput = dados && typeof dados === 'object' && dados.tool_input && typeof dados.tool_input === 'object' ? dados.tool_input : {};
const base = typeof dados.cwd === 'string' && dados.cwd ? dados.cwd : process.cwd();
const absoluto = (c) => (isAbsolute(c) ? c : resolve(base, c));

// Alvos: o arquivo do Write/Edit (Claude Code) ou cada arquivo do patch (Codex),
// este último traduzido para a entrada que os hooks do projeto já sabem ler.
const alvos = [];
const candidato = toolInput.file_path || toolInput.path || '';
if (typeof candidato === 'string' && candidato) {
  alvos.push({ arquivo: absoluto(candidato), entrada: bruto, codex: false });
} else {
  const patch = textoDoPatch(toolInput);
  for (const op of patch ? arquivosDoPatch(patch) : []) {
    const arquivo = absoluto(op.caminho);
    const novo = op.mais.join('\n');
    const traduzido = op.op === 'Add'
      ? { tool_name: 'Write', tool_input: { file_path: arquivo, content: novo } }
      : { tool_name: 'Edit', tool_input: { file_path: arquivo, old_string: op.menos.join('\n'), new_string: novo } };
    alvos.push({ arquivo, entrada: JSON.stringify({ ...dados, ...traduzido }), codex: true });
  }
}

let saida = 0;
for (const { arquivo, entrada, codex } of alvos) {
  const r = disparar(arquivo, entrada, codex);
  if (r === 2) saida = 2;
  else if (r !== 0 && saida === 0) saida = r;
}
process.exit(saida);
