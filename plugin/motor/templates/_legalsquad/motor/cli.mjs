#!/usr/bin/env node
// Atalho local do motor LegalSquad. `npx legalsquad …` dentro do projeto cai
// aqui (por node_modules/.bin/legalsquad) e este arquivo acha o motor instalado
// na máquina e o executa, sem depender de o prefixo global do npm estar no PATH.
//
// Por que existe: no Windows (e em qualquer shell aberto sem o perfil do
// terminal, como o que a IDE abre), `legalsquad` não é encontrado mesmo
// instalado; e o `npx` sem binário local tenta o registro e falha com 404,
// porque o motor não é publicado no npm. Com este arquivo, quem resolve o motor
// é o projeto. Ordem: LEGALSQUAD_BIN › motor.json do projeto (gravado por
// init/update) › ~/.legalsquad/motor.json (gravado por install-global e pelo
// plugin do Claude Code: vale para todos os projetos da máquina) › prefixos
// conhecidos do node que está rodando › `npm root -g`. Projeto criado pelo
// motor do plugin inverte as duas primeiras: o registro da máquina vem antes.
//
// Entre os candidatos que existem, vence o de versão mais nova: um motor.json
// gravado por um motor antigo (outro prefixo do nvm, por exemplo) não prende o
// projeto a ele quando há um motor mais novo instalado para o node em uso.
// Gerado por `legalsquad init`/`update` a partir de templates/_legalsquad/motor/.
// Não edite: o próximo update sobrescreve.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BIN_REL = ['legalsquad', 'bin', 'legalsquad.js'];

// Sobe a partir de `inicio` até achar _legalsquad/motor/motor.json (o projeto).
export function acharMotorJson(inicio) {
  let dir = resolve(inicio);
  for (;;) {
    const caminho = join(dir, '_legalsquad', 'motor', 'motor.json');
    if (existsSync(caminho)) return caminho;
    const pai = dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
}

export function candidatos({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  home = homedir(),
  inicio = AQUI,
  cwd = process.cwd(),
} = {}) {
  const lista = [];
  if (env.LEGALSQUAD_BIN) lista.push(env.LEGALSQUAD_BIN);
  const registros = [];
  for (const base of [inicio, cwd]) {
    const motorJson = acharMotorJson(base);
    if (motorJson) registros.push(motorJson);
  }
  // O registro da máquina, gravado pelo install-global e pelo plugin do Claude
  // Code (HOME do serviço pode não ser o do usuário: tenta o do node também).
  const daMaquina = join(home, '.legalsquad', 'motor.json');
  registros.push(daMaquina);
  const lidos = [];
  for (const registro of registros) {
    try {
      const { bin, origem } = JSON.parse(readFileSync(registro, 'utf-8'));
      if (typeof bin === 'string' && bin) lidos.push({ bin, origem, registro });
    } catch {
      // registro ausente ou ilegível: segue para o próximo
    }
  }
  // Projeto criado pelo motor do plugin do Claude Code: o caminho gravado nele
  // tem a versão do plugin no nome e some quando o plugin atualiza. O registro
  // da máquina, que o plugin refaz a cada conversa, vem primeiro.
  if (lidos.some((l) => l.origem === 'plugin' && l.registro !== daMaquina)) {
    lidos.sort((a, b) => (a.registro === daMaquina ? -1 : 0) - (b.registro === daMaquina ? -1 : 0));
  }
  for (const { bin } of lidos) lista.push(bin);
  if (platform === 'win32') {
    // Instalador oficial: %APPDATA%\npm; nvm-windows e afins: ao lado do node.exe.
    if (env.APPDATA) lista.push(join(env.APPDATA, 'npm', 'node_modules', ...BIN_REL));
    lista.push(join(dirname(execPath), 'node_modules', ...BIN_REL));
  } else {
    // O prefixo do node que está rodando (nvm, Homebrew, /usr/local) e os usuais.
    lista.push(join(dirname(dirname(execPath)), 'lib', 'node_modules', ...BIN_REL));
    lista.push(join(home, '.npm-global', 'lib', 'node_modules', ...BIN_REL));
    lista.push(join('/opt/homebrew/lib/node_modules', ...BIN_REL));
    lista.push(join('/usr/local/lib/node_modules', ...BIN_REL));
  }
  return [...new Set(lista)];
}

// Último recurso: pergunta ao npm. Lento (abre o npm) e `\r` no Windows.
export function raizGlobalDoNpm(exec = execSync) {
  try {
    return String(exec('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] })).replace(/\r/g, '').trim() || null;
  } catch {
    return null;
  }
}

/** Versão do motor em `<bin>/../../package.json`, ou null. */
export function versaoDoMotor(bin, ler = (c) => readFileSync(c, 'utf8')) {
  try {
    return String(JSON.parse(ler(join(dirname(dirname(bin)), 'package.json'))).version || '') || null;
  } catch {
    return null;
  }
}

/** Compara "a.b.c" numericamente; sufixos de pré-release perdem para a versão limpa. */
export function compararVersoes(a, b) {
  const partes = (v) => String(v || '0').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [partes(a), partes(b)];
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  // Mesma base: a versão limpa vence a pré-release (0.8.0 > 0.8.0-beta).
  const pre = (v) => String(v || '').includes('-');
  if (pre(a) !== pre(b)) return pre(a) ? -1 : 1;
  return 0;
}

export function resolverMotor(opts = {}) {
  const existe = opts.existe || existsSync;
  const versaoDe = opts.versaoDe || versaoDoMotor;
  const procurados = [];
  const existentes = [];
  for (const caminho of candidatos(opts)) {
    procurados.push(caminho);
    if (existe(caminho)) existentes.push(caminho);
  }
  if (existentes.length === 0) {
    const raiz = (opts.raizGlobal || raizGlobalDoNpm)();
    if (raiz) {
      const caminho = join(raiz, ...BIN_REL);
      procurados.push(caminho);
      if (existe(caminho)) existentes.push(caminho);
    }
  }
  if (existentes.length === 0) return { bin: null, procurados };
  // LEGALSQUAD_BIN é escolha explícita de quem opera: vence sempre. Fora isso,
  // o primeiro (motor.json) vence, salvo se outro candidato existente for de
  // versão mais nova (as duas versões precisam ser legíveis para comparar).
  const env = opts.env || process.env;
  if (env.LEGALSQUAD_BIN && existentes[0] === env.LEGALSQUAD_BIN) {
    return { bin: existentes[0], versao: versaoDe(existentes[0]), procurados };
  }
  let escolhido = existentes[0];
  let versao = versaoDe(escolhido);
  for (const outro of existentes.slice(1)) {
    const v = versaoDe(outro);
    if (versao && v && compararVersoes(v, versao) > 0) { escolhido = outro; versao = v; }
  }
  return { bin: escolhido, versao, procurados };
}

/** O motor resolvido é ESTE atalho (ou outro atalho)? Executá-lo seria forkar sem fim. */
export function ehAtalho(bin) {
  try {
    if (realpathSync(bin) === realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch {
    // caminho inválido: não é este arquivo
  }
  return /(^|[\\/])cli\.mjs$/.test(String(bin)) && /(^|[\\/])_legalsquad[\\/]motor[\\/]/.test(String(bin))
    || /(^|[\\/])node_modules[\\/](\.bin[\\/]legalsquad|legalsquad[\\/]cli\.mjs)$/.test(String(bin));
}

function main() {
  // Guarda contra recursão: o atalho nunca executa um atalho, e uma cadeia de
  // atalhos (variável apontando para outro projeto) para na segunda camada.
  const profundidade = Number.parseInt(process.env.LEGALSQUAD_ATALHO_PROFUNDIDADE || '0', 10) || 0;
  if (profundidade >= 2) {
    console.error('LegalSquad: o atalho `npx legalsquad` chamou a si mesmo (LEGALSQUAD_BIN ou motor.json apontam para outro atalho, não para o motor).');
    process.exit(1);
  }
  const { bin, procurados } = resolverMotor();
  if (!bin) {
    console.error('LegalSquad: o motor não foi encontrado nesta máquina.');
    console.error('Com o plugin LegalSquad do Claude Code: abra uma conversa nova no Claude (o plugin registra o motor ao iniciar) e confira em /plugin que ele está ativo.');
    console.error('Sem o plugin: instale com npm install -g github:bbpropulse/legalsquad-nucleo');
    console.error('e depois rode `legalsquad update` (ou `node <caminho do motor>/bin/legalsquad.js update`) nesta pasta.');
    console.error('Procurei em:\n  ' + procurados.join('\n  '));
    process.exit(1);
  }
  if (ehAtalho(bin)) {
    console.error(`LegalSquad: ${bin} é um atalho, não o motor. Aponte LEGALSQUAD_BIN (ou _legalsquad/motor/motor.json) para <motor>/bin/legalsquad.js.`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, LEGALSQUAD_ATALHO_PROFUNDIDADE: String(profundidade + 1) },
  });
  if (r.error) {
    console.error(`LegalSquad: falha ao executar o motor em ${bin}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.signal) {
    // Morreu por sinal (Ctrl+C, kill): repassa o mesmo sinal em vez de fingir exit 1.
    try { process.kill(process.pid, r.signal); } catch { /* sem suporte ao sinal */ }
    process.exit(1);
  }
  process.exit(r.status === null ? 1 : r.status);
}

// Só executa quando chamado como programa (npm chega por symlink, então realpath).
function chamadoComoPrograma() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (chamadoComoPrograma()) main();
