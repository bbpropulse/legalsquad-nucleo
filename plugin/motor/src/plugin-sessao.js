#!/usr/bin/env node
// Hook SessionStart do plugin do Claude Code: a "instalação" do LegalSquad para
// quem não usa terminal.
//
// Com o npm, dois comandos preparam a máquina: `npm install -g` traz o motor e
// `legalsquad install-global` liga o resto (bloco do roteador no
// `~/.claude/CLAUDE.md`, registro do motor em `~/.legalsquad/motor.json`,
// disparador dos hooks do projeto). O advogado que instala pelo `/plugin` não
// roda nenhum dos dois, então o plugin faz, a cada conversa nova, só o que um
// plugin pode fazer (https://code.claude.com/docs/en/plugins-reference e
// https://code.claude.com/docs/en/hooks#sessionstart):
//
// 1. Registro da máquina: grava `~/.legalsquad/motor.json` apontando para o motor
//    embutido no plugin (`<plugin>/motor/bin/legalsquad.js`), pela mesma regra do
//    `install-global` (motor-link.js: vale o de versão mais nova, nunca rebaixa).
//    É o que o `npx legalsquad` de todos os projetos lê; como a pasta do plugin
//    muda a cada versão, é também o que mantém os projetos funcionando depois de
//    uma atualização do plugin.
// 2. O bloco do roteador: plugin não carrega `CLAUDE.md`, então o texto vai como
//    `additionalContext`, que a doc garante como contexto antes do primeiro
//    pedido. Se o bloco do npm já estiver no `CLAUDE.md` global, vai só o
//    complemento (bloco-roteador.js).
// 3. O disparador dos hooks do projeto NÃO é gravado em settings.json aqui: ele
//    vem no `hooks/hooks.json` do próprio plugin, que o Claude Code carrega junto
//    com os hooks do usuário, e sai junto quando o plugin é desinstalado. Quem
//    também tem o do `install-global` não o vê rodar duas vezes: a cópia do
//    plugin cede a vez à da máquina (templates/.../hooks/legalsquad-disparador.mjs).
//
// Sem rede, sem npm, sem git, sem prompt. Com tudo em dia, lê dois arquivos
// pequenos e não grava nada. Qualquer falha vira aviso no contexto, nunca erro:
// uma conversa não pode deixar de abrir por causa do LegalSquad.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binDoMotor, raizDoPlugin, registrarMotorNaMaquina } from './motor-link.js';
import { blocoPlugin, complementoPlugin, temBlocoNpm } from './bloco-roteador.js';
import { compararVersoes } from '../templates/_legalsquad/motor/cli.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** O mesmo piso do `engines` do package.json (zstd nativo do `node:zlib`). */
export const NODE_MINIMO = '22.15.0';

function versaoDoPacote(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')).version;
}

/**
 * Faz o trabalho e devolve o que o hook imprime. Opções existem para os testes
 * (HOME temporária, pasta do Claude, versão do Node).
 */
export async function sessaoDoPlugin({
  packageRoot = PACKAGE_ROOT,
  home = homedir(),
  claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  nodeVersion = process.versions.node,
} = {}) {
  const versao = versaoDoPacote(packageRoot);
  const motor = binDoMotor(packageRoot);
  const avisosContexto = [];
  const avisosUsuario = [];

  if (compararVersoes(nodeVersion, NODE_MINIMO) < 0) {
    avisosUsuario.push(`LegalSquad: o Node.js deste computador é o ${nodeVersion}, e o LegalSquad precisa do ${NODE_MINIMO} ou mais novo. Baixe o instalador da versão LTS em https://nodejs.org, instale com as opções padrão e abra o Claude de novo.`);
    avisosContexto.push(`**Aviso da máquina:** o Node.js aqui é o ${nodeVersion}, abaixo do mínimo do LegalSquad (${NODE_MINIMO}); a sincronização da biblioteca (\`acervo sync\`) falha nele. Antes de qualquer trabalho jurídico com o motor, peça ao usuário para instalar a versão LTS pelo instalador de https://nodejs.org (sem terminal) e abrir o Claude de novo. Não tente instalar Node por conta própria.`);
  }

  let registro = null;
  try {
    const r = await registrarMotorNaMaquina(home, { bin: motor, version: versao, registradoPor: 'plugin' });
    registro = { ...r, doPlugin: r.proprio };
  } catch (erro) {
    avisosContexto.push(`**Aviso da máquina:** o registro \`~/.legalsquad/motor.json\` não pôde ser gravado (${erro.code || erro.message}); fora de uma pasta preparada, use \`node "${motor}"\`.`);
  }

  let claudeMd = '';
  try {
    claudeMd = readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf-8');
  } catch {
    // sem CLAUDE.md global: vai o bloco inteiro
  }
  const comBlocoNpm = temBlocoNpm(claudeMd);

  const partes = [comBlocoNpm ? complementoPlugin({ motor, versao, registro }) : blocoPlugin({ motor, versao, registro })];
  if (avisosContexto.length) partes.push(avisosContexto.join('\n\n'));
  const contexto = partes.join('\n\n');

  // A mensagem ao usuário aparece só quando há o que dizer: a primeira conversa
  // depois de instalar ou atualizar o plugin, ou um Node velho demais.
  if (registro?.doPlugin && registro.acao === 'gravado') {
    avisosUsuario.unshift(`LegalSquad ${versao} pronto neste computador. Para começar, peça em português o que precisa ou digite /legalsquad:legalsquad.`);
  }

  return {
    contexto,
    systemMessage: avisosUsuario.length ? avisosUsuario.join(' ') : null,
    registro,
    comBlocoNpm,
    versao,
    motor,
    plugin: raizDoPlugin(packageRoot),
  };
}

/** O JSON que a doc do SessionStart define (hookSpecificOutput.additionalContext). */
export function saidaDoHook({ contexto, systemMessage }) {
  const saida = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contexto } };
  if (systemMessage) saida.systemMessage = systemMessage;
  return JSON.stringify(saida);
}

function chamadoComoPrograma() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (chamadoComoPrograma()) {
  // A entrada do hook (JSON no stdin) não muda nada aqui: o trabalho é o mesmo
  // em startup, resume, clear e compact. Não é lida para não esperar um stdin
  // que, rodado à mão, nunca fecha.
  try {
    process.stdout.write(saidaDoHook(await sessaoDoPlugin()) + '\n');
  } catch (erro) {
    // Último recurso: a conversa abre, e o Claude sabe onde o motor está.
    const motor = binDoMotor(PACKAGE_ROOT);
    process.stdout.write(saidaDoHook({
      contexto: `LegalSquad (plugin do Claude Code): a preparação do início da conversa falhou (${erro.message}). O motor está em \`node "${motor}"\`; para pedidos jurídicos, use \`/legalsquad:legalsquad\`.`,
      systemMessage: null,
    }) + '\n');
  }
  process.exit(0);
}
