#!/usr/bin/env node
// O teste de montagem do aluno, de ponta a ponta, numa máquina simulada.
//
// Reproduz o que acontece na máquina de quem instala: empacota a distribuição
// como o `npm install -g github:…` a recebe, instala num prefixo isolado com
// HOME isolada, roda `install-global`, prepara uma pasta de processo (com
// acento, espaço e `&` no nome) num shell SEM `legalsquad` no PATH, sincroniza
// a biblioteca (ou liga um depósito já sincronizado), e confere o que o aluno
// usa: diagnóstico, busca por identificador, hooks de citação, update, um
// segundo projeto sem rede. Nunca toca o `~/.legalsquad` real de quem roda.
//
// É também a prova de campo no Windows: rode `node scripts/e2e-aluno.mjs` lá e
// mande o relatório (`--json relatorio.json`).
//
//   node scripts/e2e-aluno.mjs                       (com rede: faz o sync real)
//   node scripts/e2e-aluno.mjs --deposito <pasta>    (sem rede: liga um depósito já sincronizado)
//   --manter     preserva a árvore temporária para inspeção
//   --estrito    orçamento de tempo estourado vira falha (por padrão é aviso)
//   --json <f>   grava o relatório em JSON
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { release, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RAIZ_DO_MOTOR = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

const { values: opcoes } = parseArgs({
  options: {
    deposito: { type: 'string' },
    manter: { type: 'boolean' },
    estrito: { type: 'boolean' },
    json: { type: 'string' },
  },
});

// Orçamentos de tempo (segundos). Estouro é aviso, salvo `--estrito`.
const ORCAMENTO = { init: 2, update: 20, segundoProjeto: 90 };

const passos = [];
let atual = null;
function passo(nome) {
  atual = { nome, ok: true, tempo_s: null, detalhes: [], falhas: [], avisos: [] };
  passos.push(atual);
  process.stdout.write(`\n▶ ${nome}\n`);
  return atual;
}
function confere(condicao, mensagem) {
  if (condicao) {
    atual.detalhes.push(mensagem);
    process.stdout.write(`  ✓ ${mensagem}\n`);
  } else {
    atual.ok = false;
    atual.falhas.push(mensagem);
    process.stdout.write(`  ✗ ${mensagem}\n`);
  }
  return Boolean(condicao);
}
function aviso(mensagem) {
  atual.avisos.push(mensagem);
  process.stdout.write(`  ⚠ ${mensagem}\n`);
}
function orcamento(chave, segundos) {
  const limite = ORCAMENTO[chave];
  if (segundos <= limite) return confere(true, `${segundos.toFixed(1)} s (orçamento ${limite} s)`);
  if (opcoes.estrito) return confere(false, `${segundos.toFixed(1)} s, acima do orçamento de ${limite} s`);
  aviso(`${segundos.toFixed(1)} s, acima do orçamento de ${limite} s`);
  return true;
}
function cronometrado(fn) {
  const inicio = process.hrtime.bigint();
  const r = fn();
  const s = Number(process.hrtime.bigint() - inicio) / 1e9;
  atual.tempo_s = Math.round(s * 10) / 10;
  return { ...r, segundos: s };
}

function rodar(cmd, args, { cwd, env, entrada, shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, env, input: entrada, encoding: 'utf8', shell, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', erro: r.error?.message || null, saida: `${r.stdout || ''}${r.stderr || ''}` };
}
function ondeNoPath(nome, PATH) {
  const exts = WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const pasta of String(PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const c = join(pasta, nome + ext);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

function tornarGravavel(pasta) {
  for (const e of readdirSync(pasta, { withFileTypes: true })) {
    const c = join(pasta, e.name);
    if (e.isDirectory()) tornarGravavel(c);
    else if (e.isFile()) { try { chmodSync(c, 0o644); } catch { /* segue */ } }
  }
}

// ── Máquina simulada ───────────────────────────────────────────────────────
const raiz = mkdtempSync(join(tmpdir(), 'legalsquad-e2e-'));
const pastas = {
  dist: join(raiz, 'dist'),
  home: join(raiz, 'home'),
  prefixo: join(raiz, 'prefix'),
  nodebin: join(raiz, 'nodebin'),
  cacheNpm: join(raiz, 'npm-cache'),
  casos: join(raiz, 'casos'),
};
for (const p of Object.values(pastas)) mkdirSync(p, { recursive: true });

// PATH com node, npm e npx e SEM `legalsquad`: é o shell que a IDE abre para o
// aluno (no Windows, `%APPDATA%\npm` quase nunca está nele).
let pastaDoNode = dirname(process.execPath);
if (!WIN) {
  symlinkSync(process.execPath, join(pastas.nodebin, 'node'));
  for (const nome of ['npm', 'npx']) {
    const achado = ondeNoPath(nome, process.env.PATH);
    if (achado) symlinkSync(achado, join(pastas.nodebin, nome));
  }
  pastaDoNode = pastas.nodebin;
}
const PATH = WIN
  ? [pastaDoNode, join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(delimiter)
  : [pastaDoNode, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);

const env = { ...process.env, HOME: pastas.home, USERPROFILE: pastas.home, npm_config_cache: pastas.cacheNpm };
for (const chave of ['LEGALSQUAD_DEPOSITO', 'LEGALSQUAD_BIN', 'LEGALSQUAD_RAIZ', 'npm_config_prefix', 'NPM_CONFIG_PREFIX']) delete env[chave];
// No Windows `Path` e `PATH` são a mesma variável; duas chaves no objeto seriam ambíguas.
for (const chave of Object.keys(env)) if (chave.toLowerCase() === 'path') delete env[chave];
env.PATH = PATH;

const shellDoNpm = WIN; // npm.cmd/npx.cmd só rodam por shell no Windows
const npm = (args, cwd) => rodar('npm', args, { cwd, env, shell: shellDoNpm });
const npx = (args, cwd, extraEnv = {}) => rodar('npx', args, { cwd, env: { ...env, ...extraEnv }, shell: shellDoNpm });
let MOTOR = null; // bin/legalsquad.js do motor instalado no prefixo
const motor = (args, cwd, extraEnv = {}) => rodar(process.execPath, [MOTOR, ...args], { cwd, env: { ...env, ...extraEnv } });
const atalho = (projeto, args, cwd = projeto, extraEnv = {}) =>
  rodar(process.execPath, [join(projeto, '_legalsquad', 'motor', 'cli.mjs'), ...args], { cwd, env: { ...env, ...extraEnv } });

const legalsquadNoPath = ondeNoPath('legalsquad', PATH);
process.stdout.write(`Máquina simulada em ${raiz}\n  ${process.platform} ${process.arch}, node ${process.version}\n  PATH do aluno: ${PATH}\n`);
if (legalsquadNoPath) process.stdout.write(`  ⚠ este PATH ainda encontra \`legalsquad\` em ${legalsquadNoPath} (instalação global ao lado do node); a simulação de "comando ausente" fica imperfeita\n`);

let sucesso = false;
try {
  // ── 1. Distribuição empacotada e instalada como o aluno recebe ────────────
  passo('1. dist empacotado e instalado num prefixo isolado');
  {
    const r = cronometrado(() => {
      const build = rodar(process.execPath, [join(RAIZ_DO_MOTOR, 'scripts', 'build-dist.mjs'), pastas.dist], { cwd: RAIZ_DO_MOTOR, env: process.env });
      if (build.status !== 0) return build;
      const pack = npm(['pack', '--pack-destination', raiz], pastas.dist);
      if (pack.status !== 0) return pack;
      const tgz = readdirSync(raiz).find((f) => /^legalsquad-.*\.tgz$/.test(f));
      if (!tgz) return { status: 1, saida: 'tarball não encontrado' };
      return npm(['install', '-g', '--prefix', pastas.prefixo, join(raiz, tgz)], raiz);
    });
    if (!confere(r.status === 0, `build-dist + npm pack + npm install -g --prefix (${r.segundos.toFixed(1)} s)`)) process.stdout.write(r.saida.slice(-1500) + '\n');
    const rootG = npm(['root', '-g', '--prefix', pastas.prefixo], raiz).stdout.trim();
    MOTOR = join(rootG, 'legalsquad', 'bin', 'legalsquad.js');
    confere(existsSync(MOTOR), `motor instalado em ${MOTOR}`);
    const versao = motor(['--version'], raiz).stdout.trim();
    confere(/^\d+\.\d+\.\d+/.test(versao), `\`legalsquad --version\` responde ${versao}`);
  }
  if (!atual.ok) throw new Error('sem instalação não há o que testar');

  // ── 2. install-global na HOME isolada ─────────────────────────────────────
  passo('2. install-global (HOME isolada, CLAUDE.md existente preservado)');
  {
    mkdirSync(join(pastas.home, '.claude'), { recursive: true });
    writeFileSync(join(pastas.home, '.claude', 'CLAUDE.md'), '# Minhas preferências\n\nResponda sempre em português.\n');
    const r = cronometrado(() => motor(['install-global'], raiz));
    if (!confere(r.status === 0, `install-global saiu 0 (${r.segundos.toFixed(1)} s)`)) process.stdout.write(r.saida.slice(-1500) + '\n');
    const claudeMd = existsSync(join(pastas.home, '.claude', 'CLAUDE.md')) ? readFileSync(join(pastas.home, '.claude', 'CLAUDE.md'), 'utf8') : '';
    confere(claudeMd.startsWith('# Minhas preferências'), 'conteúdo anterior do ~/.claude/CLAUDE.md preservado');
    confere(/BEGIN LegalSquad \(install-global\)/.test(claudeMd) && /Onde o motor está nesta máquina/.test(claudeMd), 'bloco global com o caminho do motor');
    confere(/Posso prepará-la agora\?/.test(claudeMd) && !/sem perguntar/.test(claudeMd), 'o bloco pede o sim antes de preparar a pasta');
    confere(existsSync(join(pastas.home, '.claude', 'CLAUDE.md.bak')), 'backup ~/.claude/CLAUDE.md.bak');
    let registro = null;
    try { registro = JSON.parse(readFileSync(join(pastas.home, '.legalsquad', 'motor.json'), 'utf8')); } catch { /* ausente */ }
    confere(registro && existsSync(registro.bin), `motor registrado em ~/.legalsquad/motor.json (${registro?.version || '?'})`);
    confere(existsSync(join(pastas.home, '.claude', 'skills', 'legalsquad', 'SKILL.md')), 'skill /legalsquad instalada');
  }

  // ── 3. init numa pasta de processo, shell sem `legalsquad` ────────────────
  const escritorio = join(pastas.casos, 'Escritório Andrade & Lima', 'Processos');
  const caso1 = join(escritorio, '0801234-56.2026.8.17.2001 - Ação de Cobrança - Maria Souza');
  const caso2 = join(escritorio, '0009876-12.2026.5.06.0001 - Reclamação Trabalhista - José Lima');
  passo('3. init --yes --lang "português" na pasta do processo (PATH sem legalsquad)');
  {
    mkdirSync(join(caso1, 'autos'), { recursive: true });
    writeFileSync(join(caso1, 'autos', '01-peticao-inicial.md'), '# Petição inicial (resumo)\n\nAção de cobrança. Valor: R$ 48.500,00.\n');
    const r = cronometrado(() => motor(['init', '--yes', '--lang', 'português'], caso1));
    if (!confere(r.status === 0, 'init saiu 0')) process.stdout.write(r.saida.slice(-1500) + '\n');
    orcamento('init', r.segundos);
    confere(/inicializado com sucesso/.test(r.stdout), 'mensagens em português ("--lang português" reconhecido)');
    confere(/biblioteca da máquina ainda vazia/.test(r.stdout) && /acervo sync/.test(r.stdout), 'primeira máquina: init avisa a biblioteca vazia e aponta o sync');
    confere(existsSync(join(caso1, '_legalsquad', 'motor', 'cli.mjs')), 'atalho _legalsquad/motor/cli.mjs');
    confere(existsSync(join(caso1, 'node_modules', '.bin', WIN ? 'legalsquad.cmd' : 'legalsquad')), 'shim node_modules/.bin/legalsquad');
    confere(existsSync(join(caso1, '.claude', 'hooks', 'verifica-citacoes.mjs')) && existsSync(join(caso1, '.claude', 'settings.json')), 'hooks de citação e redação instalados');
    const viaNpx = npx(['legalsquad', '--version'], caso1);
    confere(viaNpx.status === 0 && /^\d+\.\d+\.\d+/.test(viaNpx.stdout.trim()), `\`npx legalsquad --version\` resolve o atalho local sem rede (${viaNpx.stdout.trim() || viaNpx.saida.slice(0, 120)})`);
  }

  // ── 4. sync real ou ligação a um depósito já sincronizado ─────────────────
  const envDeposito = opcoes.deposito ? { LEGALSQUAD_DEPOSITO: resolve(opcoes.deposito) } : {};
  if (opcoes.deposito) {
    passo(`4. acervo ligar (depósito já sincronizado em ${resolve(opcoes.deposito)}, sem rede)`);
    const r = cronometrado(() => atalho(caso1, ['acervo', 'ligar'], caso1, envDeposito));
    if (!confere(r.status === 0, `acervo ligar saiu 0 (${r.segundos.toFixed(1)} s)`)) process.stdout.write(r.saida.slice(-1500) + '\n');
    confere(/projeto ligado ao depósito|projeto já em dia/.test(r.stdout), 'projeto ligado ao depósito');
    const m = /(\d+) link\(s\), (\d+) cópia\(s\)/.exec(r.stdout);
    if (m) atual.detalhes.push(`${m[1]} links, ${m[2]} cópias`);
  } else {
    passo('4. acervo sync (servidor real, depósito novo na HOME isolada)');
    const r = cronometrado(() => atalho(caso1, ['acervo', 'sync']));
    if (!confere(r.status === 0, `acervo sync saiu 0 (${r.segundos.toFixed(0)} s)`)) process.stdout.write(r.saida.slice(-2500) + '\n');
    const m = /ACERVO:SYNC (\d+) aplicado\(s\), (\d+) recusado\(s\)/.exec(r.stdout);
    confere(m && Number(m[1]) > 0 && Number(m[2]) === 0, m ? `${m[1]} pacote(s) aplicado(s), ${m[2]} recusado(s)` : 'linha ACERVO:SYNC ausente');
    confere(/projeto ligado ao depósito/.test(r.stdout), 'projeto ligado ao depósito');
    const links = /(\d+) link\(s\), (\d+) cópia\(s\)/.exec(r.stdout);
    if (links) atual.detalhes.push(`${links[1]} links, ${links[2]} cópias`);
    const idx = /índice do acervo regerado: (.+)/.exec(r.stdout);
    if (idx) atual.detalhes.push(`índice do acervo: ${idx[1].trim()}`);
  }
  const status = atalho(caso1, ['acervo', 'status'], caso1, envDeposito);
  confere(/este projeto: ligado em .* em dia com o depósito/.test(status.stdout), '`acervo status`: ligado e em dia');
  const modoCopia = /\(copia\)|\(cópia\)/.test(status.stdout);
  if (modoCopia) aviso('ligação em modo cópia (depósito noutro volume?): hard link não foi exercitado');
  const skills = existsSync(join(caso1, 'skills')) ? readdirSync(join(caso1, 'skills')).filter((n) => !n.startsWith('_')).length : 0;
  confere(skills > 0, `${skills} skills no projeto`);

  // ── 5. diagnóstico ────────────────────────────────────────────────────────
  passo('5. diagnostico --json (nenhum ✗; avisos são permitidos)');
  {
    const r = cronometrado(() => atalho(caso1, ['diagnostico', '--json'], caso1, envDeposito));
    let d = null;
    try { d = JSON.parse(r.stdout); } catch { /* inválido */ }
    if (!confere(d && Array.isArray(d.itens), 'JSON válido')) process.stdout.write(r.saida.slice(-1500) + '\n');
    if (d) {
      const ruins = d.itens.filter((i) => !i.ok && !i.aviso);
      confere(ruins.length === 0, ruins.length ? `itens com ✗: ${ruins.map((i) => `${i.nome} (${i.detalhe})`).join('; ')}` : `${d.itens.length} itens, nenhum ✗`);
      for (const i of d.itens.filter((x) => !x.ok && x.aviso)) aviso(`${i.nome}: ${i.detalhe}`);
      const por = Object.fromEntries(d.itens.map((i) => [i.nome, i]));
      confere(por['atalho executa o motor']?.ok === true, 'atalho executa o motor');
      confere(por['somente-leitura respeitado']?.ok === true, `somente-leitura: ${por['somente-leitura respeitado']?.detalhe}`);
      confere(por['hard link no volume do projeto']?.ok === true, `hard link no volume: ${por['hard link no volume do projeto']?.detalhe}`);
    }
  }

  // ── 6. buscas por identificador e por tema ────────────────────────────────
  passo('6. busca no acervo por identificador (súmula existente, súmula inventada, REsp) e busca de skills');
  {
    const busca = (q) => {
      const r = atalho(caso1, ['search-acervo', '--query', q, '--limit', '3', '--json'], caso1, envDeposito);
      try { return JSON.parse(r.stdout); } catch { return { results: [], erro: r.saida.slice(0, 200) }; }
    };
    const s54 = busca('Súmula 54 STJ');
    confere(s54.results?.[0]?.matched_by?.includes('identificador-exato') && /sumula/i.test(s54.results[0].path), `"Súmula 54 STJ" devolve o verbete em primeiro (${s54.results?.[0]?.processo || s54.erro || 'nada'})`);
    const s999 = busca('Súmula 999 STJ');
    confere(!(s999.results || []).some((x) => x.matched_by.includes('identificador-exato')), '"Súmula 999 STJ" não devolve identificador exato (não existe)');
    const resp = busca('REsp 1.132.866/SP');
    confere(resp.results?.[0]?.matched_by?.includes('identificador-exato'), `"REsp 1.132.866/SP" devolve o acórdão (${resp.results?.[0]?.processo || 'nada'})`);
    const sk = atalho(caso1, ['search-skills', '--query', 'réplica', '--limit', '5', '--json'], caso1, envDeposito);
    let skj = null;
    try { skj = JSON.parse(sk.stdout); } catch { /* inválido */ }
    confere(skj?.results?.some((x) => /replica/.test(x.id)), `search-skills "réplica" devolve skill de réplica (${skj?.results?.map((x) => x.id).slice(0, 3).join(', ') || sk.saida.slice(0, 120)})`);
  }

  // ── 7. hooks de citação com o payload do Claude Code ──────────────────────
  passo('7. hook de citação: bloqueia sem manifesto, bloqueia citação sem entrada, passa completo, bloqueia hash divergente');
  {
    const saida = join(caso1, 'squads', 'peca-modelo', 'output');
    mkdirSync(saida, { recursive: true });
    const peca = join(saida, 'replica.md');
    writeFileSync(peca, '---\ncitation_gate: final\n---\nEXCELENTÍSSIMO SENHOR DOUTOR JUIZ DE DIREITO DA 2ª VARA CÍVEL DO RECIFE/PE\n\nMARIA SOUZA vem apresentar RÉPLICA. Os juros de mora incidem desde o vencimento (art. 397 do Código Civil; Súmula 54 do STJ). Conforme a Súmula 999 do STJ, a multa não se compensa.\n\nNestes termos, pede deferimento.\n');
    const payload = JSON.stringify({ session_id: 'e2e', cwd: caso1, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: peca }, tool_response: { success: true } });
    const hook = () => rodar(process.execPath, [join(caso1, '.claude', 'hooks', 'verifica-citacoes.mjs')], { cwd: caso1, env: { ...env, CLAUDE_PROJECT_DIR: caso1 }, entrada: payload });
    const manifesto = (titulos) => writeFileSync(`${peca}.citation-gate.json`, JSON.stringify({
      schema_version: '1', kind: 'legalsquad.citation-gate-attestation', artifact: 'replica.md',
      artifact_sha256: createHash('sha256').update(readFileSync(peca)).digest('hex'),
      gate_status: 'aprovado', verification_type: 'material', scope: 'citacoes_materiais',
      verified_by: 'e2e', verified_at: new Date().toISOString(),
      citations: titulos.map((t) => ({ title: t, status: 'verificada', source_url: 'https://www.stj.jus.br/', consulted_at: new Date().toISOString() })),
    }, null, 2));
    let r = hook();
    confere(r.status === 2 && /manifesto ausente/.test(r.saida), 'sem manifesto: BLOQUEADO (exit 2)');
    manifesto(['CPC, art. 341', 'Código Civil, art. 397', 'Súmula 54/STJ']);
    r = hook();
    confere(r.status === 2 && /Súmula 999/.test(r.saida), 'manifesto sem a Súmula 999: BLOQUEADO nomeando a citação');
    manifesto(['Código Civil, art. 397', 'Súmula 54/STJ', 'Súmula 999/STJ']);
    r = hook();
    confere(r.status === 0, 'manifesto completo: passa (exit 0)');
    writeFileSync(peca, readFileSync(peca, 'utf8') + '\n');
    r = hook();
    confere(r.status === 2 && /sha256/.test(r.saida), 'peça alterada depois do manifesto: BLOQUEADO por hash');
    rmSync(saida, { recursive: true, force: true });
  }

  // ── 8. update, --version, raiz a partir de uma subpasta ───────────────────
  passo('8. update sem mudança, --version, comando de dentro de autos/');
  {
    const r = cronometrado(() => atalho(caso1, ['update'], caso1, envDeposito));
    if (!confere(r.status === 0 && /já em dia|em dia/.test(r.stdout), 'update: biblioteca já em dia')) process.stdout.write(r.saida.slice(-1200) + '\n');
    orcamento('update', r.segundos);
    const v = atalho(caso1, ['--version']);
    confere(/^\d+\.\d+\.\d+/.test(v.stdout.trim()), `--version pelo atalho: ${v.stdout.trim()}`);
    const deAutos = atalho(caso1, ['acervo', 'status'], join(caso1, 'autos'), envDeposito);
    confere(/raiz do projeto/.test(deAutos.stderr) && /este projeto: ligado/.test(deAutos.stdout), 'de dentro de autos/, a CLI age sobre a casa (raiz no stderr)');
  }

  // ── 9. segundo projeto na mesma máquina ───────────────────────────────────
  passo('9. segundo projeto na mesma máquina (init liga sem rede)');
  {
    mkdirSync(caso2, { recursive: true });
    const r = cronometrado(() => motor(['init', '--yes', '--lang', 'português'], caso2, envDeposito));
    if (!confere(r.status === 0 && /biblioteca da máquina ligada/.test(r.stdout), 'init do segundo projeto ligou a biblioteca')) process.stdout.write(r.saida.slice(-1200) + '\n');
    orcamento('segundoProjeto', r.segundos);
    const m = /biblioteca da máquina ligada: (\d+) skills, (\d+) pacote\(s\)/.exec(r.stdout);
    if (m) atual.detalhes.push(`${m[1]} skills, ${m[2]} pacotes`);
    const s = atalho(caso2, ['acervo', 'status'], caso2, envDeposito);
    confere(/em dia com o depósito/.test(s.stdout), 'segundo projeto em dia com o depósito');
  }

  // ── 10. ligar só as áreas do escritório ───────────────────────────────────
  passo('10. acervo areas: lista, escolhe duas áreas (religa sem rede), a busca oferece o que ficou de fora, --todas volta');
  {
    const lista = atalho(caso2, ['acervo', 'areas'], caso2, envDeposito);
    const m = /ACERVO:AREAS (\d+)/.exec(lista.stdout);
    if (!confere(lista.status === 0 && m && Number(m[1]) > 0, `${m ? m[1] : '?'} área(s) no depósito`)) process.stdout.write(lista.saida.slice(-800) + '\n');
    const disponiveis = [...lista.stdout.matchAll(/^\s+[●○] ([a-z0-9-]+):/gm)].map((x) => x[1]);
    const escolha = ['direito-civil', 'direito-do-consumidor'].filter((a) => disponiveis.includes(a));
    if (escolha.length < 1) {
      aviso(`depósito sem direito-civil/consumidor (áreas: ${disponiveis.join(', ')}); cenário de áreas pulado`);
    } else {
      const r = cronometrado(() => atalho(caso2, ['acervo', 'areas', ...escolha], caso2, envDeposito));
      if (!confere(r.status === 0 && /desligado\(s\) \(fora das áreas escolhidas\)/.test(r.stdout), `áreas ${escolha.join(' + ')}: religado com desligamento do resto (${r.segundos.toFixed(1)} s)`)) process.stdout.write(r.saida.slice(-800) + '\n');
      const skillsAgora = readdirSync(join(caso2, 'skills')).filter((n) => !n.startsWith('_')).length;
      confere(skillsAgora > 0 && skillsAgora < skills, `${skillsAgora} skills ligadas (antes ${skills})`);
      const st = atalho(caso2, ['acervo', 'status'], caso2, envDeposito);
      confere(/áreas ligadas: direito-civil/.test(st.stdout) && /em dia com o depósito/.test(st.stdout), '`acervo status` mostra as áreas e em dia');
      const busca = atalho(caso2, ['search-skills', '--query', 'improbidade administrativa', '--limit', '3', '--json'], caso2, envDeposito);
      let j = null;
      try { j = JSON.parse(busca.stdout); } catch { /* inválido */ }
      confere(Array.isArray(j?.nao_ligadas), 'search-skills traz `nao_ligadas`');
      const fora = (j?.nao_ligadas || []).find((x) => /improbidade/.test(x.id));
      if (fora) confere(true, `oferece ${fora.id} (área ${fora.area}), que existe no depósito e não está ligada`);
      else aviso(`nenhuma skill de improbidade fora das áreas (nao_ligadas: ${JSON.stringify(j?.nao_ligadas || []).slice(0, 200)})`);
      confere(!(j?.results || []).some((x) => /improbidade-administrativa/.test(x.id)), 'a shortlist ligada não traz a skill da área desligada');
      const todas = atalho(caso2, ['acervo', 'areas', '--todas'], caso2, envDeposito);
      confere(todas.status === 0 && readdirSync(join(caso2, 'skills')).filter((n) => !n.startsWith('_')).length === skills, '--todas religa tudo');
    }
  }

  sucesso = passos.every((p) => p.ok);
} catch (erro) {
  if (atual) { atual.ok = false; atual.falhas.push(erro.message); }
  process.stdout.write(`\n✗ interrompido: ${erro.message}\n`);
} finally {
  const relatorio = {
    ok: sucesso,
    em: new Date().toISOString(),
    maquina: { platform: process.platform, arch: process.arch, node: process.version, release: release() },
    modo: opcoes.deposito ? 'deposito-existente' : 'sync-real',
    arvore: opcoes.manter ? raiz : null,
    passos,
  };
  process.stdout.write('\n═══ Relatório ═══\n');
  for (const p of passos) {
    process.stdout.write(`${p.ok ? '✓' : '✗'} ${p.nome}${p.tempo_s !== null ? ` (${p.tempo_s} s)` : ''}${p.avisos.length ? ` ⚠ ${p.avisos.length} aviso(s)` : ''}\n`);
    for (const f of p.falhas) process.stdout.write(`    ✗ ${f}\n`);
  }
  process.stdout.write(`${sucesso ? 'E2E:OK' : 'E2E:FALHOU'}\n`);
  if (opcoes.json) writeFileSync(opcoes.json, JSON.stringify(relatorio, null, 2));
  if (opcoes.manter) {
    process.stdout.write(`árvore preservada em ${raiz}\n`);
  } else {
    // No Windows o atributo somente-leitura (o 0444 do depósito) impede apagar;
    // no POSIX basta a pasta ser gravável.
    try {
      if (WIN) tornarGravavel(raiz);
      rmSync(raiz, { recursive: true, force: true, maxRetries: 3 });
    } catch (erro) {
      process.stdout.write(`(não consegui apagar ${raiz}: ${erro.message})\n`);
    }
  }
  process.exitCode = sucesso ? 0 : 1;
}
