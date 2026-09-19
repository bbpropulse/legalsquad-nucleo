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
import { arquivosDoDeposito, carimboDoDeposito, ehProjeto, ligacaoDoProjeto, mesmasAreas, raizDoDeposito } from './deposito.js';
import { discoverSkillCatalog } from './skill-catalog.js';
import { auditSkillCatalogQuality, skillsRecusadasEmProducao } from './skill-quality.js';
import { descreverPerfil, lerPerfil } from './perfil.js';

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
  itens.push(item('motor em uso', true, `${versaoDoMotor} em ${PACKAGE_ROOT}`));
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
    'rode `legalsquad install-global` (ou `node "<motor>/bin/legalsquad.js" install-global`)'));

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
    else itens.push(item('projeto ligado ao depósito', true, `ligado em ${ligacao.ligado_em} (${ligacao.modo}), em dia${ligacao.areas ? `; áreas: ${ligacao.areas.join(', ')}` : '; todas as áreas'}`));
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

export function diagnosticoCli(cwd, values = {}) {
  const resultado = diagnosticar(cwd, {});
  if (values.json === true) console.log(JSON.stringify(resultado, null, 2));
  else imprimirDiagnostico(resultado);
  return { success: true, ...resultado };
}

// Só para testes: provas isoladas.
export const _provas = { provaDeHardLink, provaDeSomenteLeitura };
