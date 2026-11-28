// `legalsquad diagnostico`: o que esta máquina consegue fazer, dito em uma tela.
//
// Existe porque o depósito e o atalho `npx legalsquad` dependem de coisas que
// variam por máquina e que não dá para provar de longe: hard link no volume do
// projeto, o bit somente-leitura sendo respeitado, o `node` no PATH do shell
// que a IDE abre, o `npx` resolvendo o atalho local, o motor registrado. No
// Windows isso foi desenhado por simulação (14/09/2026): este comando é a
// prova de campo. Cada item diz OK ou o que falta, e `--json` serve para colar
// num chamado de suporte. Nunca altera nada além de arquivos temporários seus.

import { spawnSync } from 'node:child_process';
import { homedir, platform, release } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { lerEstado } from './acervo-estado.js';
import { resolverConfigDeAcervo } from './acervo-config.js';
import { arquivosDoDeposito, carimboDoDeposito, ehProjeto, ligacaoDoProjeto, mesmasAreas, mesmosTribunais, raizDoDeposito } from './deposito.js';
import { siglaDoPackRegional } from './tribunais.js';
import { raizDaReferencia, resumoDaReferencia } from './indice-sync.js';
import { discoverSkillCatalog } from './skill-catalog.js';
import { auditSkillCatalogQuality, skillsRecusadasEmProducao } from './skill-quality.js';
import { descreverPerfil, lerPerfil } from './perfil.js';
import { raizDoPlugin } from './motor-link.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `aviso`: o item não está como o ideal, mas nada deixa de funcionar (o
// comando fora do PATH, com o `npx` do projeto resolvendo). Sai com ⚠ e não
// vira DIAGNOSTICO:ATENCAO, para ninguém "consertar" o que não está quebrado.
function item(nome, ok, detalhe, dica = null, { aviso = false } = {}) {
  return { nome, ok, detalhe, ...(aviso && !ok ? { aviso: true } : {}), ...(dica && !ok ? { dica } : {}) };
}

function comando(cmd, args, opcoes = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20_000, ...opcoes });
  return { ok: r.status === 0 && !r.error, saida: `${r.stdout || ''}${r.stderr || ''}`.trim(), erro: r.error?.message || null };
}

/** Hard link entre duas pastas (ou dentro de uma): cria, confere nlink, apaga. */
function provaDeHardLink(origemDir, destinoDir) {
  const nome = `.legalsquad-diagnostico-${process.pid}-${Date.now()}`;
  const a = join(origemDir, `${nome}.a`);
  const b = join(destinoDir, `${nome}.b`);
  try {
    writeFileSync(a, 'prova de hard link\n');
    linkSync(a, b);
    const nlink = Number(statSync(b).nlink);
    return { ok: nlink === 2, detalhe: nlink === 2 ? 'hard link criado e reconhecido (nlink 2)' : `link criado, mas nlink veio ${nlink}` };
  } catch (erro) {
    return { ok: false, detalhe: `${erro.code || erro.message}`, codigo: erro.code };
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

/** O bit somente-leitura é respeitado por quem escreve? (root e Administrador passam por cima.) */
function provaDeSomenteLeitura(dir) {
  const caminho = join(dir, `.legalsquad-diagnostico-ro-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(caminho, 'x');
    chmodSync(caminho, 0o444);
    try {
      writeFileSync(caminho, 'y');
      return { ok: false, detalhe: 'escrita num arquivo 0444 PASSOU: este usuário ignora o bit (root/Administrador?); a proteção do depósito é só o registro' };
    } catch (erro) {
      return { ok: true, detalhe: `escrita num arquivo 0444 falha com ${erro.code} (como deve)` };
    }
  } catch (erro) {
    return { ok: false, detalhe: `não consegui criar o arquivo de prova: ${erro.code || erro.message}` };
  } finally {
    try { chmodSync(caminho, 0o644); } catch { /* pode não existir */ }
    rmSync(caminho, { force: true });
  }
}

/** Todas as ocorrências de `nome` no PATH deste processo, na ordem do PATH. */
function todosNoPath(nome, env = process.env) {
  const extensoes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  const achados = [];
  for (const pasta of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const ext of extensoes) {
      const candidato = join(pasta, `${nome}${ext}`);
      if (existsSync(candidato)) { achados.push(candidato); break; }
    }
  }
  return achados;
}

export function diagnosticar(cwd, { deposito: depositoExplicito = null, env = process.env } = {}) {
  const itens = [];
  const so = `${platform()} ${release()}${process.arch ? ` ${process.arch}` : ''}`;
  itens.push(item('sistema', true, so));

  // Node e npm, como o shell desta sessão os vê.
  const [maior, menor] = process.versions.node.split('.').map(Number);
  const nodeOk = maior > 22 || (maior === 22 && menor >= 15);
  itens.push(item('node', nodeOk, `${process.version} em ${process.execPath}`, 'o motor exige Node 22.15 ou mais novo (zstd nativo)'));
  const npm = comando('npm', ['--version']);
  itens.push(item('npm', npm.ok, npm.ok ? `npm ${npm.saida.split('\n')[0]}` : (npm.erro || npm.saida || 'não encontrado'), 'sem npm no PATH deste shell não há instalação nem atualização'));

  // O comando global e o motor. Rodando por `npx legalsquad diagnostico`, o npx
  // põe o node_modules/.bin do projeto no PATH deste processo: o comando "é
  // encontrado" pelo atalho, não pelo shell do usuário. Dizer ✓ aí escondia
  // exatamente o que o diagnóstico existe para mostrar.
  // O npx põe node_modules/.bin NA FRENTE do PATH: o primeiro achado é o
  // atalho mesmo quando o shell tem o comando mais adiante. Vale o primeiro
  // achado FORA de um node_modules/.bin; só sem nenhum é que é "só pelo atalho".
  const achados = todosNoPath('legalsquad', env);
  const doShell = achados.find((c) => !/node_modules[\\/]\.bin$/.test(dirname(c))) || null;
  const achado = doShell || achados[0] || null;
  const peloAtalho = Boolean(achado) && !doShell;
  const noPath = doShell ? comando(doShell, ['--help']) : { ok: false };
  itens.push(item('legalsquad no PATH', noPath.ok,
    noPath.ok
      ? `o shell encontra o comando (${achado})`
      : peloAtalho
        ? `só pelo atalho do projeto (${achado}, que o npx põe no PATH); fora de uma pasta preparada este shell não encontra o comando (normal no Windows e em shells sem o perfil do terminal)`
        : 'não encontrado neste shell (normal no Windows e em shells sem o perfil do terminal)',
    'use `npx legalsquad` dentro do projeto, ou `node "<caminho do motor>"`', { aviso: true }));
  const versaoDoMotor = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  // Motor embutido no plugin do Claude Code: quem registra e quem liga o
  // disparador é o próprio plugin, no início de cada conversa, não o install-global.
  const plugin = raizDoPlugin(PACKAGE_ROOT);
  const refazer = plugin
    ? 'abra uma conversa nova no Claude: o plugin LegalSquad refaz isto ao iniciar (confira em /plugin que ele está ativo)'
    : 'rode `legalsquad install-global` (ou `node "<motor>/bin/legalsquad.js" install-global`)';
  itens.push(item('motor em uso', true, `${versaoDoMotor} em ${PACKAGE_ROOT}${plugin ? ' (plugin do Claude Code)' : ''}`));
  const registro = join(homedir(), '.legalsquad', 'motor.json');
  let registrado = null;
  let registroErro = null;
  try {
    registrado = JSON.parse(readFileSync(registro, 'utf8'));
  } catch (erro) {
    registroErro = erro.code === 'ENOENT' ? null : `ilegível (${erro.message})`;
  }
  itens.push(item('motor registrado na máquina', Boolean(registrado?.bin && existsSync(registrado.bin)),
    registroErro ? `${registro} ${registroErro}` : registrado ? `${registrado.version || '?'} em ${registrado.bin}${existsSync(registrado.bin || '') ? '' : ' (arquivo não existe mais)'}` : `${registro} ausente`,
    refazer));

  // Hooks do projeto com a sessão fora da raiz (medição de 24/09/2026, defeito 34):
  // sem o disparador de máquina, o gate de redação e a guarda de memória só rodam
  // quando a IDE foi aberta na própria raiz do projeto.
  let settingsMaquina = '';
  try { settingsMaquina = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'); } catch { /* sem settings de máquina */ }
  const comDisparadorDaMaquina = settingsMaquina.includes('legalsquad-disparador.mjs') && existsSync(join(homedir(), '.claude', 'hooks', 'legalsquad-disparador.mjs'));
  const comDisparadorDoPlugin = Boolean(plugin) && existsSync(join(plugin, 'scripts', 'legalsquad-disparador.mjs'));
  const comDisparador = comDisparadorDaMaquina || comDisparadorDoPlugin;
  itens.push(item('hooks do projeto fora da raiz', comDisparador,
    comDisparador
      ? `o disparador ${comDisparadorDaMaquina ? 'de máquina' : 'do plugin'} acha a raiz pelo arquivo tocado (sessão aberta em outra pasta também passa pelos gates do projeto)`
      : 'disparador de máquina não registrado: com a sessão aberta fora da raiz, o gate de redação e a guarda de memória do projeto não rodam',
    refazer, { aviso: true }));

  // O mesmo para o Codex, só se ele está na máquina. Lá o disparador é o ÚNICO
  // caminho dos gates: o `apply_patch` não passa `file_path`, e os hooks do
  // `.codex/hooks.json` do projeto saem 0 sem olhar o arquivo, dentro ou fora da
  // raiz. O Codex só executa hook de usuário aprovado em `/hooks`, e essa
  // aprovação não é conferível daqui: o item diz isso em vez de prometer.
  const codexDir = join(homedir(), '.codex');
  if (existsSync(codexDir)) {
    let hooksCodex = '';
    try { hooksCodex = readFileSync(join(codexDir, 'hooks.json'), 'utf8'); } catch { /* sem hooks de máquina */ }
    let configCodex = '';
    try { configCodex = readFileSync(join(codexDir, 'config.toml'), 'utf8'); } catch { /* sem config */ }
    const desligados = /^\s*(?:codex_)?hooks\s*=\s*false\b/m.test(configCodex);
    const comCodex = hooksCodex.includes('legalsquad-disparador.mjs') && existsSync(join(codexDir, 'hooks', 'legalsquad-disparador.mjs'));
    itens.push(item('hooks do projeto no Codex', comCodex && !desligados,
      desligados
        ? 'hooks desligados em ~/.codex/config.toml ([features] hooks = false): no Codex, nenhum gate do projeto roda'
        : comCodex
          ? 'disparador registrado em ~/.codex/hooks.json (acha a raiz pelo arquivo do apply_patch); o Codex só o executa depois de aprovado em /hooks, e a aprovação não é conferível daqui'
          : 'disparador não registrado em ~/.codex/hooks.json: no Codex, o gate de redação, o de citações e a guarda de memória do projeto não rodam (nem na raiz)',
      desligados ? 'tire `hooks = false` de [features] em ~/.codex/config.toml' : 'rode `legalsquad install-global` e aprove o disparador em /hooks no Codex', { aviso: true }));
  }

  // O projeto atual.
  const projeto = ehProjeto(cwd);
  itens.push(item('pasta atual é um projeto', projeto, projeto ? cwd : `${cwd} não tem _legalsquad/`, 'o diagnóstico do atalho e da ligação precisa de um projeto'));
  let config = null;
  if (projeto) {
    try { config = resolverConfigDeAcervo(cwd); } catch { config = null; }
    const atalho = join(cwd, '_legalsquad', 'motor', 'cli.mjs');
    const shim = join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'legalsquad.cmd' : 'legalsquad');
    itens.push(item('atalho do motor no projeto', existsSync(atalho) && existsSync(shim),
      `${existsSync(atalho) ? 'cli.mjs presente' : 'cli.mjs AUSENTE'}; ${existsSync(shim) ? 'shim em node_modules/.bin presente' : 'shim AUSENTE'}`,
      'rode `legalsquad update` (ou `node "<motor>/bin/legalsquad.js" update`) nesta pasta'));
    if (existsSync(atalho)) {
      const r = spawnSync(process.execPath, [atalho], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...env } });
      const ok = r.status === 0 && /legalsquad/i.test(r.stdout || '');
      itens.push(item('atalho executa o motor', ok, ok ? 'node _legalsquad/motor/cli.mjs respondeu com a ajuda do motor' : (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().split('\n').slice(-2).join(' | ')));
    }
    // Só com o shim presente, e nunca instalando nada: sem `--no-install` o npx
    // consultaria o registro npm (e executaria o que servissem sob este nome).
    if (existsSync(shim)) {
      const npx = comando('npx', ['--no-install', 'legalsquad'], { cwd });
      itens.push(item('npx legalsquad no projeto', npx.ok && /legalsquad/i.test(npx.saida), npx.ok ? 'o npx resolveu o atalho local (sem rede)' : (npx.erro || npx.saida.split('\n').slice(-2).join(' | ')), 'o npx não resolveu o atalho local; `legalsquad update` refaz os shims'));
    } else {
      itens.push(item('npx legalsquad no projeto', false, 'não testado: o shim local não existe (sem ele o npx iria ao registro npm)', 'rode `legalsquad update` nesta pasta'));
    }
  }

  // O depósito e a ligação.
  const deposito = depositoExplicito || raizDoDeposito({ env, config: config?.ok ? config : null });
  let estado = null;
  let estadoErro = null;
  try { estado = lerEstado(deposito); } catch (erro) { estadoErro = erro.message; }
  const registros = existsSync(deposito) ? arquivosDoDeposito(deposito) : null;
  itens.push(item('depósito da máquina', Boolean(estado && !estado.novo && registros?.size),
    estadoErro ? `estado ilegível: ${estadoErro}` : (estado?.novo ? `${deposito} vazio` : `${deposito}: ${Object.keys(estado.packs).length} pacote(s), ${registros?.size || 0} arquivo(s) registrados, sync em ${estado.sincronizado_em}`),
    'rode `npx legalsquad acervo sync` uma vez nesta máquina'));
  if (projeto && estado && !estado.novo) {
    const ligacao = ligacaoDoProjeto(cwd);
    if (!ligacao) itens.push(item('projeto ligado ao depósito', false, 'AINDA NÃO LIGADO', 'rode `npx legalsquad acervo ligar`'));
    else if (ligacao.carimbo !== carimboDoDeposito(deposito, estado)) itens.push(item('projeto ligado ao depósito', false, `ligado em ${ligacao.ligado_em} (${ligacao.modo}), mas DEFASADO em relação ao depósito`, 'rode `npx legalsquad acervo ligar`'));
    else if (!mesmasAreas(ligacao.areas || null, config?.ok ? config.areas : null)) itens.push(item('projeto ligado ao depósito', false, `ligado em ${ligacao.ligado_em} (${ligacao.modo}), mas as áreas escolhidas mudaram desde então`, 'rode `npx legalsquad acervo ligar`'));
    else if (!mesmosTribunais(ligacao.tribunais ?? null, config?.ok ? config.tribunais : null)) itens.push(item('projeto ligado ao depósito', false, `ligado em ${ligacao.ligado_em} (${ligacao.modo}), mas os tribunais regionais escolhidos mudaram desde então`, 'rode `npx legalsquad acervo ligar`'));
    else itens.push(item('projeto ligado ao depósito', true, `ligado em ${ligacao.ligado_em} (${ligacao.modo}), em dia${ligacao.areas ? `; áreas: ${ligacao.areas.join(', ')}` : '; todas as áreas'}`));
    // Pacotes regionais no depósito e o projeto que nunca escolheu a jurisdição (projeto de antes de
    // 0.9.104): nenhum regional está ligado, e a linha diz como ligar. Aviso, não falha.
    const regionais = Object.keys(estado.packs).filter((id) => siglaDoPackRegional(id));
    if (regionais.length && !(config?.ok && config.tribunaisRespondidos)) {
      itens.push(item('tribunais regionais', false, `${regionais.length} pacote(s) regionais no depósito e nenhum ligado: o escritório ainda não disse em que tribunais atua`, 'rode `npx legalsquad acervo tribunais <sigla…>` (ex.: tjpe trf5 trt6), `--uf <UF> --justica estadual,federal,trabalho` ou `--todos`', { aviso: true }));
    }
  }

  // Skills que o resolvedor recusa por defeito estrutural. Em 15/09/2026 um
  // depósito tinha 158 skills `active` que nenhum squad conseguia usar, e o
  // aluno só descobria quando o squad parava na inicialização. Aviso, não
  // falha: o resto da biblioteca funciona, e o conserto é do curador (republicar
  // a área), não do aluno. Lê o relatório da última auditoria quando há um;
  // sem ele, audita agora (só leitura).
  if (projeto && existsSync(join(cwd, 'skills'))) {
    const recusa = skillsRecusadasNoProjeto(cwd);
    if (recusa.erro) {
      itens.push(item('skills que o resolvedor recusa', false, `auditoria não rodou: ${recusa.erro}`, 'rode `npx legalsquad audit-skills` e veja o erro completo', { aviso: true }));
    } else {
      const porMotivo = {};
      for (const r of recusa.recusadas) for (const m of r.motivos) porMotivo[m] = (porMotivo[m] || 0) + 1;
      const resumo = Object.entries(porMotivo).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${n}× ${m}`).join('; ');
      itens.push(item('skills que o resolvedor recusa', recusa.recusadas.length === 0,
        recusa.recusadas.length === 0
          ? `nenhuma das ${recusa.total} skills de produção reprova o gate estrutural (${recusa.fonte})`
          : `${recusa.recusadas.length} de ${recusa.total} skills de produção reprovam o gate estrutural e nenhum squad consegue usá-las (${recusa.fonte}): ${resumo}`,
        'é defeito do pacote, não desta máquina: avise o curador da área; `npx legalsquad audit-skills` lista cada skill e o motivo', { aviso: true }));
    }
  }

  // Ritmo/perfil: quanto de verificação por LLM cada run paga. Quem instalou o
  // perfil rápido para um curso precisa ver isso aqui, não descobrir num run.
  if (projeto) {
    const perfil = lerPerfil(cwd);
    itens.push(item('perfil do projeto', true, `${descreverPerfil(perfil)}${perfil.origem === 'padrao' ? ' (padrão; o ritmo de cada run é escolhido na parada intake)' : ' (perfil gravado: teto de todos os runs)'}`));
  }
  // Leitura dos autos: o que a máquina tem para ler PDF sem gastar modelo. Sem
  // pdftotext o índice não extrai texto; sem tesseract e o venv do projeto, a
  // folha digitalizada só se lê pelo modelo, página a página (lento e caro).
  if (projeto) {
    const temBinario = (bin, args) => {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000, env: { ...env } });
      return !r.error;
    };
    const pdftotext = temBinario('pdftotext', ['-v']);
    const tesseract = temBinario('tesseract', ['--version']);
    const venv = existsSync(join(cwd, '_legalsquad', '.venv'));
    const partes = [`pdftotext ${pdftotext ? '✓' : '✗'}`, `tesseract ${tesseract ? '✓' : '✗'}`, `venv de OCR do projeto ${venv ? '✓' : '✗'}`];
    const ok = pdftotext && tesseract && venv;
    itens.push(item('leitura dos autos por código', ok, `${partes.join(' · ')}${ok ? ': PDF vira índice e Markdown com OCR sem gastar modelo' : ''}`,
      'pdftotext: `brew install poppler` (macOS) ou poppler-utils; OCR: `brew install tesseract tesseract-lang` e, no projeto, `npm run autos:md:deps` (cria _legalsquad/.venv); sem isso, folha digitalizada só se lê pelo modelo', { aviso: true }));
  }

  // Provas de campo no volume da pasta atual.
  const base = cwd;
  const dentro = provaDeHardLink(base, base);
  itens.push(item('hard link no volume do projeto', dentro.ok, dentro.detalhe, 'sem hard link o depósito liga por cópia (mais disco); confira o sistema de arquivos (exFAT/FAT32 não têm hard link)'));
  if (existsSync(deposito)) {
    // A origem da prova fica na pasta que é nossa (`acervo/_packs`), e um
    // depósito que não aceita escrita é dito como tal, não como "outro volume".
    const pastaDeProva = join(deposito, 'acervo', '_packs');
    let gravavel = true;
    try { mkdirSync(pastaDeProva, { recursive: true }); } catch { gravavel = false; }
    const cruzado = gravavel ? provaDeHardLink(pastaDeProva, base) : { ok: false, detalhe: 'depósito não aceita escrita', codigo: 'EACCES' };
    const semLinkPorDono = !cruzado.ok && ['EACCES', 'EPERM', 'EROFS'].includes(cruzado.codigo);
    itens.push(item('hard link entre depósito e projeto', cruzado.ok,
      cruzado.ok ? cruzado.detalhe : `${cruzado.detalhe} (${cruzado.codigo === 'EXDEV' ? 'volumes diferentes' : semLinkPorDono ? 'sem permissão de escrita no depósito: dono ou montagem' : 'ver código'})`,
      semLinkPorDono ? 'o depósito foi criado por outro usuário (sudo?) ou está em montagem só leitura' : 'projeto e ~/.legalsquad no mesmo volume; ou aponte LEGALSQUAD_DEPOSITO para o volume do projeto'));
  }
  const ro = provaDeSomenteLeitura(base);
  itens.push(item('somente-leitura respeitado', ro.ok, ro.detalhe, 'como root/Administrador o bit não protege; a posse continua garantida pelo registro do depósito'));

  // Caminhos longos (Windows). O caminho completo é limitado a 260 até alguém
  // ligar `LongPathsEnabled`, e o acervo publicado tinha nomes de até 250
  // caracteres (14/09/2026): o depósito e cada projeto ligado carregam o mesmo
  // caminho relativo, então a conta é feita para os dois.
  if (process.platform === 'win32') {
    const longos = caminhosLongos(registros, [deposito, cwd]);
    const chave = longPathsEnabled();
    const ok = chave === true || longos.acima === 0;
    itens.push(item('caminhos longos (limite de 260 do Windows)', ok,
      longos.maior === 0
        ? 'sem registro de arquivos para medir'
        : `maior caminho relativo do depósito: ${longos.maior} caracteres; ${longos.acima} arquivo(s) passariam de 260 (${longos.onde}); LongPathsEnabled: ${chave === null ? 'não lido' : chave ? 'ativo' : 'desligado'}`,
      'ative caminhos longos no Windows (chave LongPathsEnabled do registro, precisa de administrador) ou use uma pasta de projeto mais curta; pacotes republicados com nomes de até 100 caracteres resolvem de vez'));
  }

  // Pasta sincronizada com a nuvem: 83 mil hard links dentro do OneDrive viram
  // 83 mil arquivos a subir, e o cliente pode trocar o link por cópia própria.
  const nuvem = pastaDeNuvem(cwd, env) || pastaDeNuvem(deposito, env);
  itens.push(item('fora de pasta sincronizada com a nuvem', !nuvem,
    nuvem ? `${nuvem.caminho} parece estar no ${nuvem.servico}` : 'projeto e depósito fora de OneDrive, iCloud Drive, Google Drive e Dropbox',
    'mantenha o projeto (e o depósito) numa pasta local: a sincronização de nuvem duplica os links e pode substituí-los por cópias', { aviso: true }));

  return { ok: itens.every((i) => i.ok || i.aviso), itens, deposito };
}

/** Skills de produção do projeto que o resolvedor recusaria: pelo relatório da última auditoria, ou auditando agora. */
export function skillsRecusadasNoProjeto(cwd) {
  const relatorio = join(cwd, 'skills', '_quality-report.json');
  try {
    if (existsSync(relatorio)) {
      const r = JSON.parse(readFileSync(relatorio, 'utf8'));
      if (Array.isArray(r.results)) {
        const producao = r.results.filter((x) => ['active', 'pilot'].includes(String(x.lifecycle || '').toLowerCase()));
        return { fonte: 'relatório da última auditoria, skills/_quality-report.json', total: producao.length, recusadas: skillsRecusadasEmProducao(r.results) };
      }
    }
    const results = auditSkillCatalogQuality(discoverSkillCatalog(join(cwd, 'skills'))).results;
    const producao = results.filter((x) => ['active', 'pilot'].includes(String(x.lifecycle || '').toLowerCase()));
    return { fonte: 'auditoria feita agora', total: producao.length, recusadas: skillsRecusadasEmProducao(results) };
  } catch (erro) {
    return { erro: erro.message, total: 0, recusadas: [] };
  }
}

/** Quantos caminhos do depósito passariam de 260 ao lado de cada prefixo (depósito e projeto). */
export function caminhosLongos(registros, prefixos) {
  let maior = 0;
  const acimaPor = new Map();
  if (registros) {
    for (const rel of registros.keys()) {
      maior = Math.max(maior, rel.length);
      for (const prefixo of prefixos) {
        // `<prefixo>\<rel>` + terminador
        if (prefixo.length + 1 + rel.length + 1 > 260) acimaPor.set(prefixo, (acimaPor.get(prefixo) || 0) + 1);
      }
    }
  }
  const acima = Math.max(0, ...acimaPor.values());
  const onde = [...acimaPor.entries()].map(([p, n]) => `${n} em ${p}`).join('; ') || 'nenhum';
  return { maior, acima, onde };
}

function longPathsEnabled() {
  const r = comando('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled']);
  if (!r.ok) return null;
  const m = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.saida);
  return m ? Number.parseInt(m[1], 16) === 1 : null;
}

const SERVICOS_DE_NUVEM = [
  [/[\\/]OneDrive[^\\/]*[\\/]/i, 'OneDrive'],
  [/[\\/]Library[\\/]Mobile Documents[\\/]/, 'iCloud Drive'],
  [/[\\/]iCloud Drive[\\/]/i, 'iCloud Drive'],
  [/[\\/]Google Drive[^\\/]*[\\/]|[\\/]GoogleDrive[\\/]|[\\/]Meu Drive[\\/]|[\\/]My Drive[\\/]/i, 'Google Drive'],
  [/[\\/]Dropbox[^\\/]*[\\/]/i, 'Dropbox'],
];
export function pastaDeNuvem(caminho, env) {
  if (!caminho) return null;
  const comBarra = `${caminho}${caminho.endsWith('/') || caminho.endsWith('\\') ? '' : '/'}`;
  for (const [re, servico] of SERVICOS_DE_NUVEM) if (re.test(comBarra)) return { caminho, servico };
  for (const variavel of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const raiz = env[variavel];
    if (raiz && comBarra.toLowerCase().startsWith(String(raiz).replace(/[\\/]+$/, '').toLowerCase() + (raiz.includes('\\') ? '\\' : '/'))) return { caminho, servico: 'OneDrive' };
  }
  return null;
}

export function imprimirDiagnostico(resultado) {
  console.log(`DIAGNOSTICO:${resultado.ok ? 'OK' : 'ATENCAO'}`);
  for (const i of resultado.itens) {
    console.log(`  ${i.ok ? '✓' : i.aviso ? '⚠' : '✗'} ${i.nome}: ${i.detalhe}`);
    if (i.dica) console.log(`      → ${i.dica}`);
  }
}

/**
 * O servidor de referência nesta máquina (plano do servidor de referência, seção 3.7 D.4): versão do
 * índice e camadas presentes, tamanho do cache de texto e se o servidor responde (`GET /saude`, sem
 * licença, uma tentativa curta). Servidor que não responde é falha, não aviso: a conferência de
 * citações do run depende dele (o índice local só acelera).
 */
export async function diagnosticarReferencia(cwd, { env = process.env, fetchImpl = globalThis.fetch, tempoMs = 5000 } = {}) {
  const itens = [];
  let config;
  try { config = resolverConfigDeAcervo(cwd); } catch (erro) {
    itens.push(item('servidor de referência', false, `acervo.json ilegível: ${erro.message}`, 'corrija o JSON de _legalsquad/config/acervo.json'));
    return itens;
  }
  let raiz;
  try { raiz = raizDaReferencia({ env }); } catch (erro) {
    itens.push(item('índice do servidor de referência', false, erro.message));
    return itens;
  }
  const resumo = resumoDaReferencia(raiz);
  const presentes = resumo.camadas.filter((c) => c.presente && c.versao);
  const nacional = presentes.find((c) => c.camada === 'nacional');
  const naoPublicadas = resumo.camadas.filter((c) => c.nao_publicada).map((c) => c.camada);
  const faltam = resumo.cobertura?.faltam || [];
  const completo = Boolean(resumo.cobertura?.completa);
  itens.push(item('índice do servidor de referência', Boolean(nacional),
    nacional
      ? `${presentes.map((c) => `${c.camada} ${c.versao}${c.bytes ? ` (${(c.bytes / 1e6).toFixed(0)} MB)` : ''}`).join(', ')} em ${join(raiz, 'indice')}; verificado em ${(nacional.verificado_em || '?').slice(0, 10)}${naoPublicadas.length ? `; o servidor ainda não publica: ${naoPublicadas.join(', ')}` : ''}${completo ? '; índice completo' : `; índice INCOMPLETO${faltam.length ? ` (faltam ${faltam.slice(0, 6).join(', ')}${faltam.length > 6 ? '…' : ''})` : ''}`}`
      : `sem índice nesta máquina (${join(raiz, 'indice')}): a conferência de citações vai inteira ao servidor${resumo.ilegivel ? `; estado.json ilegível: ${resumo.ilegivel}` : ''}`,
    'rode `npx legalsquad acervo sync` (ou `npx legalsquad ref sync`)', { aviso: !nacional }));
  itens.push(item('cache de texto conferido', true, `${resumo.textos.arquivos} texto(s), ${(resumo.textos.bytes / 1e6).toFixed(2)} MB em ${join(raiz, 'textos')} (endereçado pelo sha256; vale enquanto o hash do índice não muda)`));
  let saude = null;
  let motivo = null;
  try {
    const r = await fetchImpl(`${config.servidorUrl}/saude`, { signal: AbortSignal.timeout(tempoMs) });
    saude = r.ok ? await r.json() : null;
    if (!r.ok) motivo = `HTTP ${r.status}`;
  } catch (erro) {
    motivo = erro?.cause?.code || erro?.name || 'sem resposta';
  }
  const defasado = saude?.indice && nacional?.versao && saude.indice !== nacional.versao;
  itens.push(item('servidor de referência responde', Boolean(saude?.ok),
    saude?.ok
      ? `${config.servidorUrl} (${config.origemDoServidor}): índice ${saude.indice || '?'}, ${saude.docs ?? '?'} documento(s), ${saude.dispositivos ?? '?'} dispositivo(s)${defasado ? `; o índice desta máquina está na ${nacional.versao}` : ''}`
      : `${config.servidorUrl} não respondeu (${motivo}): o Citation Gate espera e tenta de novo, e nada é aprovado sem conferência`,
    defasado ? 'rode `npx legalsquad acervo sync` para trazer a diferença' : saude?.ok ? null : 'confira a internet desta máquina; se persistir, avise o suporte (o servidor pode estar em manutenção)'));
  return itens;
}

export async function diagnosticoCli(cwd, values = {}) {
  const resultado = diagnosticar(cwd, {});
  resultado.itens.push(...await diagnosticarReferencia(cwd, values.fetchImpl ? { fetchImpl: values.fetchImpl } : {}));
  resultado.ok = resultado.itens.every((i) => i.ok || i.aviso);
  if (values.json === true) console.log(JSON.stringify(resultado, null, 2));
  else imprimirDiagnostico(resultado);
  return { success: true, ...resultado };
}

// Só para testes: provas isoladas.
export const _provas = { provaDeHardLink, provaDeSomenteLeitura };
