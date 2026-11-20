// Rituais agendados do chefe — MIKE-CHEFE.md §6 ("A pessoa: memória, rituais,
// checkpoints").
//
// O briefing (`src/chefe-briefing.js`) existe e ninguém o chama sozinho. Este
// módulo é a ponte até o agendador — e ele foi desenhado a partir de UMA regra
// do contrato de autonomia: **agendar rotina é decisão M3**
// (`_legalsquad/core/runner.pipeline.md`, seção do chefe). M3 é "propõe, só
// executa com o sim explícito do profissional". Por isso o comando tem duas
// bocas e não uma:
//
//   `legalsquad chefe --agendar`             monta e MOSTRA. Não escreve nada.
//   `legalsquad chefe --agendar --aplicar`   o "sim". Só então grava.
//
// `--aplicar` sozinho é recusado de propósito: assinar sem ver a minuta não é
// consentimento. O flag é a resposta a uma proposta que o usuário leu.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE A DOC OFICIAL CONFIRMOU (lido em 31/08/2026) e o que ela NEGOU
//
// A plataforma tem três camadas de agendamento, e a tabela comparativa aparece
// igual em `/docs/en/scheduled-tasks`, `/docs/en/routines` e
// `/docs/en/desktop-scheduled-tasks`:
//
//   cloud routine   roda sem a máquina ligada · piso de 1 h · **sem acesso a
//                   arquivo local ("No (fresh clone)")**
//   desktop task    roda na máquina · piso de 1 min · vê arquivo local · exige
//                   o app Desktop aberto e o computador acordado
//   /loop           roda na máquina · piso de 1 min · exige SESSÃO ABERTA
//
// Duas descobertas mudaram o desenho, e as duas são negativas:
//
// 1. **A rotina na nuvem não serve para ESTE ritual.** Não é o piso de 1 h que
//    a inviabiliza: é o clone. Cada execução parte de um clone novo de um
//    repositório do GitHub e não enxerga a máquina do escritório. O briefing lê
//    o cache do DJEN e a carteira, que vivem em `_legalsquad/_memory/` e são
//    ignorados pelo git POR DECISÃO (MIKE-CHEFE §6, 31/08/2026). A rotina
//    rodaria sobre uma casa sem os dados e produziria três seções
//    "indisponível". Oferecê-la como alternativa equivalente seria vender um
//    agendamento que não pode funcionar.
//
// 2. **Nenhuma das duas camadas nativas se registra por linha de comando.**
//    Rotina na nuvem: `claude.ai/code/routines` ou `/schedule` numa sessão
//    (conversacional). Desktop task: a página Routines do app (New routine →
//    Local) ou pedindo ao Claude numa sessão do Desktop. Existe um arquivo em
//    `~/.claude/scheduled-tasks/<nome>/SKILL.md`, mas a doc é explícita: "Schedule,
//    folder, model, and enabled state are not in this file". Escrever esse
//    arquivo NÃO registra tarefa nenhuma — geraria um arquivo órfão e a
//    sensação de que algo foi agendado. Por isso este módulo não o escreve.
//
// Sobra o agendador do sistema operacional, que é justamente onde um comando de
// shell pertence. `--aplicar` grava UM arquivo: o LaunchAgent do macOS. E só
// isso: **`launchctl` não é chamado por nós**. Escrever o arquivo é reversível
// com um `rm`; carregar o agente é o ato que passa a disparar coisas na máquina
// do usuário, e esse ato é dele.
//
// Zero dependência: `node:crypto` para o hash do rótulo, `node:fs`/`node:path`
// para o resto.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ehCasaLegalSquad } from './chefe-briefing.js';

/** Horário padrão do ritual. Briefing é a primeira coisa do expediente. */
export const HORA_PADRAO = '08:00';

// Dias em que o ritual roda. Prazo processual corre em dia útil (CPC 219), e um
// briefing de sábado só ensina o escritório a ignorar o briefing. Quem quiser
// todo dia edita a linha gerada: o plano é um snippet, não uma caixa-preta.
const DIAS_UTEIS = [1, 2, 3, 4, 5];

/**
 * O marcador que o ritual grava a cada execução, dentro da casa do projeto.
 *
 * Mora em `_legalsquad/_memory/chefe/` por dois motivos que se somam: o
 * diretório é ignorado pelo git por regra de DIRETÓRIO e nunca entra no tarball
 * (`package.json` `files` publica só `core/` e `config/`). É estado de máquina
 * do escritório, não conhecimento versionável.
 *
 * O nome NÃO termina em `.md` de propósito: `listarFatos` em `src/chefe-memoria.js`
 * varre `*.md` menos o índice para regerar o `MEMORY.md`. Um arquivo `.md` aqui
 * viraria "fato" e apareceria no índice da memória do chefe. O ponto na frente e
 * a ausência de extensão mantêm o marcador invisível para aquela varredura.
 */
export function caminhoMarcador(raiz) {
  return join(String(raiz), '_legalsquad', '_memory', 'chefe', '.ultimo-briefing');
}

/**
 * Registra que o ritual rodou. **Só timestamp e status** — nunca uma linha do
 * briefing.
 *
 * A régua não é estética: o conteúdo do briefing traz número de processo, nome
 * de cliente e teor de intimação, exatamente o que a trava LGPD de
 * `src/chefe-memoria.js` recusa. O marcador responde "o ritual rodou e deu
 * certo?", que é pergunta de mecanismo. Quem quiser o conteúdo roda o briefing.
 *
 * Nunca lança: gravar o marcador é contabilidade, e contabilidade que derruba o
 * ritual inverte a prioridade. Disco cheio, permissão negada ou casa read-only
 * devolvem `null` em silêncio. Fora de uma casa LegalSquad também devolve
 * `null`, sem criar diretório nenhum — rodar o comando na pasta errada não pode
 * semear `_legalsquad/` onde ele não existe.
 */
export function registrarExecucao(raiz, { sucesso, modo = 'briefing', agora = new Date() } = {}) {
  if (!ehCasaLegalSquad(raiz)) return null;
  const arquivo = caminhoMarcador(raiz);
  try {
    mkdirSync(join(String(raiz), '_legalsquad', '_memory', 'chefe'), { recursive: true });
    const registro = {
      gerado_em: agora.toISOString(),
      status: sucesso ? 'ok' : 'falha',
      modo,
    };
    writeFileSync(arquivo, `${JSON.stringify(registro)}\n`, 'utf8');
    return arquivo;
  } catch {
    return null;
  }
}

/**
 * Lê o marcador. Devolve `null` quando não há registro, e também quando há um
 * arquivo ilegível: para o `--status`, "nunca rodou" e "não consigo ler o que
 * ficou" são a mesma resposta útil (não sei dizer que rodou), e o comando avisa
 * a diferença ao usuário em vez de tratar lixo como dado.
 */
export function lerMarcador(raiz) {
  const arquivo = caminhoMarcador(raiz);
  if (!existsSync(arquivo)) return null;
  try {
    const dados = JSON.parse(readFileSync(arquivo, 'utf8'));
    return dados && typeof dados === 'object' && dados.gerado_em ? dados : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Montagem do plano (sem escrita e sem execução; só o realpath da raiz)
// ─────────────────────────────────────────────────────────────────────────────

/** `HH:MM` em 24 h. Horário inválido é erro, nunca chute silencioso. */
function parseHora(hora) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hora).trim());
  if (!m) return null;
  return { hora: Number(m[1]), minuto: Number(m[2]) };
}

/** Escapa texto para dentro do plist. Caminho de usuário pode ter `&` ou `<`. */
function escXml(valor) {
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Aspas simples para shell (crontab). `'` vira `'\''`. */
function shq(valor) {
  return `'${String(valor).replace(/'/g, "'\\''")}'`;
}

/**
 * Rótulo do LaunchAgent. Precisa ser estável (rodar duas vezes não pode gerar
 * dois agentes) e único por PROJETO (dois escritórios na mesma máquina são dois
 * rituais). O hash do caminho absoluto entrega as duas coisas; o nome da pasta
 * vai junto só para o humano reconhecer o arquivo em `~/Library/LaunchAgents/`.
 */
export function rotuloRitual(raiz) {
  const alvo = caminhoCanonico(raiz);
  const hash = createHash('sha256').update(alvo).digest('hex').slice(0, 8);
  const slug = basename(alvo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projeto';
  return `com.legalsquad.chefe.${slug}.${hash}`;
}

/**
 * Caminho canônico do projeto, com os symlinks resolvidos.
 *
 * O rótulo do ritual é o hash do caminho, então DUAS GRAFIAS da mesma pasta
 * seriam dois rituais. Não é hipótese de laboratório: no macOS `/tmp` e
 * `/var` são symlinks para `/private/…`, e `process.cwd()` devolve a forma
 * resolvida enquanto o caminho digitado pelo usuário costuma ser a curta. Sem
 * esta normalização, agendar por um caminho e conferir pelo outro produziria
 * "nenhum agendamento" com o arquivo ali do lado, e insistir criaria o segundo
 * LaunchAgent disparando o mesmo briefing.
 *
 * Falha (pasta inexistente, permissão) devolve a entrada intocada: canonizar é
 * melhoria, não pré-requisito.
 */
function caminhoCanonico(raiz) {
  try {
    return realpathSync(String(raiz));
  } catch {
    return String(raiz);
  }
}

/**
 * Monta o plano completo do ritual. Não escreve nada e não executa nada; a
 * única leitura de disco é o `realpath` da raiz (ver `caminhoCanonico`). Tudo
 * que varia por máquina (`execPath`, `binPath`, `home`, `plataforma`) é
 * injetável, porque é isso que torna o plano testável sem depender do macOS de
 * quem roda a suíte.
 *
 * O comando agendado é `<node absoluto> <bin absoluto> chefe --briefing`, e não
 * `npx legalsquad`: cron e launchd rodam com um PATH mínimo e sem o shell de
 * login do usuário, então `npx` (que ainda pode consultar o registro) é o modo
 * mais confiável de o ritual falhar às 8h de uma terça. Dois caminhos absolutos
 * não dependem de PATH nenhum.
 */
export function montarPlano(raiz, {
  hora = HORA_PADRAO,
  execPath = process.execPath,
  binPath = process.argv[1],
  home = homedir(),
  plataforma = process.platform,
} = {}) {
  const t = parseHora(hora);
  if (!t) {
    return { erro: `horário inválido: "${hora}". Use HH:MM em 24 h, por exemplo 08:00.` };
  }

  // Uma canonização, no topo: o rótulo, o WorkingDirectory do plist, o caminho
  // do log e a linha de cron precisam falar do MESMO caminho, senão o --status
  // procura num lugar e o agendamento vive em outro.
  const alvo = caminhoCanonico(raiz);
  const rotulo = rotuloRitual(alvo);
  const argv = [execPath, binPath, 'chefe', '--briefing'];

  // O log recebe o briefing INTEIRO, com número de processo, nome de cliente e
  // teor de intimação. É por isso que ele vai para dentro de
  // `_legalsquad/_memory/`, e não para `/tmp` ou para a raiz do projeto: ali o
  // git ignora por regra de diretório e o tarball nunca leva. É a mesma classe
  // de dado, no mesmo lugar, que o `djen-tracker.jsonl` que já vive lá.
  // Mandar para /dev/null seria pior de outro jeito: um ritual cuja saída
  // ninguém pode ler não é ritual, é consumo de CPU.
  const log = join(alvo, '_legalsquad', '_memory', 'chefe', 'briefing.log');

  const plistPath = join(home, 'Library', 'LaunchAgents', `${rotulo}.plist`);

  const calendario = DIAS_UTEIS.map((dia) => [
    '    <dict>',
    `      <key>Weekday</key><integer>${dia}</integer>`,
    `      <key>Hour</key><integer>${t.hora}</integer>`,
    `      <key>Minute</key><integer>${t.minuto}</integer>`,
    '    </dict>',
  ].join('\n')).join('\n');

  const plistXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escXml(rotulo)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...argv.map((a) => `    <string>${escXml(a)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escXml(alvo)}</string>`,
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    calendario,
    '  </array>',
    '  <key>StandardOutPath</key>',
    `  <string>${escXml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escXml(log)}</string>`,
    // RunAtLoad false: carregar o agente não pode disparar um briefing na hora.
    // Quem carrega está configurando, não pedindo o briefing de hoje.
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  const cronLinha = `${t.minuto} ${t.hora} * * 1-5 cd ${shq(alvo)} && ${shq(execPath)} ${shq(binPath)} chefe --briefing >> ${shq(log)} 2>&1`;

  return {
    raiz: alvo,
    hora: `${String(t.hora).padStart(2, '0')}:${String(t.minuto).padStart(2, '0')}`,
    rotulo,
    argv,
    // Só os dois caminhos vão entre aspas; `chefe --briefing` são literais e
    // aspas neles só fariam a linha parecer mais frágil do que é.
    comando: `${shq(execPath)} ${shq(binPath)} chefe --briefing`,
    log,
    plistPath,
    plistXml,
    cronLinha,
    plataforma,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Texto para o usuário
//
// Regra de produto: sem travessão em prosa lida pelo usuário final. As linhas
// abaixo usam ponto, dois-pontos e parênteses.
// ─────────────────────────────────────────────────────────────────────────────

/** As três camadas, com o custo real de cada uma. */
function linhasOpcoes(plano) {
  return [
    'Três caminhos, e eles não são equivalentes:',
    '',
    '1. Agendador do sistema (launchd no macOS, cron no Linux). RECOMENDADO aqui.',
    '   Roda o comando direto, sem precisar do Claude Code aberto. Vê os arquivos',
    '   locais, que é o que este ritual exige. Precisa da máquina ligada no horário.',
    '   É o único caminho que eu consigo preparar para você por escrito.',
    '',
    '2. Desktop task (app Claude Code Desktop).',
    '   Roda na sua máquina, enxerga os arquivos locais e aceita intervalo de até',
    '   1 minuto. Exige o app aberto e o computador acordado: se ele dormir no',
    '   horário, a execução é pulada (o app faz uma execução de recuperação ao',
    '   acordar). Vale a pena quando você quer que o Claude LEIA o briefing e aja,',
    '   não só que o comando rode.',
    '   Como registrar: no app Desktop, aba Code, Routines, New routine, opção Local.',
    '   Aponte a pasta do projeto e use estas instruções:',
    `     Rode \`legalsquad chefe --briefing\` em ${plano.raiz} e me diga a ação mais urgente do dia.`,
    '   Não existe comando de terminal para criar essa tarefa. Confirmei na doc:',
    '   ela é criada pela interface do app ou pedindo ao Claude numa sessão do Desktop.',
    '',
    '3. Cloud routine (roda na nuvem, sem a máquina ligada).',
    '   NÃO serve para este ritual, e o motivo não é o piso de 1 hora.',
    '   A rotina na nuvem parte de um clone novo do repositório a cada execução e',
    '   não tem acesso a arquivo local (está na tabela da doc oficial). O briefing',
    '   lê o cache do DJEN e a carteira, que vivem em _legalsquad/_memory/ e são',
    '   ignorados pelo git por decisão de sigilo. A rotina rodaria sobre uma casa',
    '   sem os dados e devolveria três seções indisponíveis.',
    '   Se um dia você quiser um ritual na nuvem, ele precisa ser outro ritual,',
    '   sobre dados que estejam no repositório.',
  ];
}

/**
 * O texto da PROPOSTA (M3). Ele existe para ser lido antes de qualquer escrita,
 * e diz em toda parte que nada foi gravado.
 */
export function formatarProposta(plano) {
  const linhas = [];
  linhas.push('🎩 Ritual do briefing matinal: proposta de agendamento.');
  linhas.push('');
  linhas.push('NADA foi agendado e nenhum arquivo foi gravado. Isto é a minuta.');
  linhas.push('');
  linhas.push('O que rodaria:');
  linhas.push(`  Comando: ${plano.comando}`);
  linhas.push(`  Na pasta: ${plano.raiz}`);
  linhas.push(`  Quando: ${plano.hora}, de segunda a sexta.`);
  linhas.push(`  Saída em: ${plano.log}`);
  linhas.push('  Atenção: esse log guarda o briefing inteiro, com número de processo e');
  linhas.push('  nome de cliente. Ele fica em _legalsquad/_memory/, que o git ignora e o');
  linhas.push('  pacote nunca leva. Se você versionar essa pasta, estará versionando isso.');
  linhas.push('');
  // O caminho do node costuma trazer a VERSÃO (Homebrew, nvm, asdf). Atualizar
  // o node deixa o agendamento apontando para um binário que sumiu, e o ritual
  // passa a falhar em silêncio às 8h. Dizer isso agora é mais barato que o
  // escritório descobrir em março que não recebe briefing desde janeiro.
  linhas.push('  Um aviso sobre o caminho do node: ele pode conter o número da versão.');
  linhas.push('  Se você atualizar o node, o agendamento aponta para um binário que não');
  linhas.push('  existe mais e o ritual passa a falhar calado. Depois de atualizar, rode');
  linhas.push('  `legalsquad chefe --agendar --aplicar` de novo e confira com `--status`.');
  linhas.push('');
  linhas.push(...linhasOpcoes(plano));
  linhas.push('');

  if (plano.plataforma === 'darwin') {
    linhas.push(`Snippet 1: LaunchAgent do macOS, para ${plano.plistPath}`);
    linhas.push('');
    linhas.push(plano.plistXml.trimEnd());
    linhas.push('');
    linhas.push('Depois de gravar esse arquivo, você carrega o agente com:');
    linhas.push(`  launchctl load ${shq(plano.plistPath)}`);
    linhas.push('Eu não rodo esse comando. Gravar um arquivo é reversível com um rm;');
    linhas.push('carregar o agente é o que passa a disparar coisas na sua máquina.');
    linhas.push('');
  }

  linhas.push('Snippet 2: linha de crontab (portátil, funciona em macOS e Linux).');
  linhas.push('Instale com `crontab -e` e cole a linha:');
  linhas.push('');
  linhas.push(`  ${plano.cronLinha}`);
  linhas.push('');
  if (plano.plataforma === 'darwin') {
    linhas.push('No macOS, o cron precisa de Acesso Total ao Disco concedido ao cron para');
    linhas.push('ler a pasta do projeto. O LaunchAgent acima evita esse passo.');
    linhas.push('');
    linhas.push('Para eu gravar o LaunchAgent por você, confirme rodando:');
    linhas.push('  legalsquad chefe --agendar --aplicar');
    linhas.push('Eu gravo o arquivo e paro ali. O launchctl load continua sendo seu.');
  } else {
    linhas.push(`Nesta plataforma (${plano.plataforma}) eu não gravo o agendamento.`);
    linhas.push('Só sei gerar com segurança o LaunchAgent do macOS. Instalar crontab por');
    linhas.push('conta própria significaria reescrever a sua tabela inteira de cron, e um');
    linhas.push('erro ali apaga agendamentos que não são meus. A linha acima está pronta:');
    linhas.push('rode `crontab -e` e cole. No Windows, falta suporte (o Agendador de');
    linhas.push('Tarefas não está implementado aqui).');
  }
  return linhas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Aplicação (a única escrita, e só depois do "sim")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava o LaunchAgent. **Idempotente por construção**: o caminho é derivado do
 * hash do projeto, então rodar duas vezes escreve no MESMO arquivo. Não há como
 * duplicar o ritual por insistência; o segundo `--aplicar` só descobre que o
 * conteúdo já é aquele e não faz nada.
 *
 * Nunca chama `launchctl`. Ver o cabeçalho do módulo.
 */
export function aplicarPlano(plano) {
  if (plano.plataforma !== 'darwin') {
    return {
      ok: false,
      motivo: `só sei gravar o agendamento no macOS (launchd). Nesta plataforma (${plano.plataforma}), use a linha de crontab que o --agendar imprime.`,
    };
  }
  const dir = join(plano.plistPath, '..');
  try {
    if (existsSync(plano.plistPath) && readFileSync(plano.plistPath, 'utf8') === plano.plistXml) {
      return { ok: true, mudou: false, caminho: plano.plistPath };
    }
    const existia = existsSync(plano.plistPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(plano.plistPath, plano.plistXml, 'utf8');
    return { ok: true, mudou: true, atualizado: existia, caminho: plano.plistPath };
  } catch (err) {
    return { ok: false, motivo: `não consegui gravar ${plano.plistPath}: ${err.message}` };
  }
}

/** Texto do resultado de `--aplicar`. */
export function formatarAplicacao(plano, resultado) {
  const linhas = ['🎩 Ritual do briefing matinal.'];
  if (!resultado.ok) {
    linhas.push('');
    linhas.push(`Não agendei: ${resultado.motivo}`);
    return linhas.join('\n');
  }
  linhas.push('');
  if (!resultado.mudou) {
    linhas.push(`Já estava agendado, e o arquivo já está exatamente assim: ${resultado.caminho}`);
    linhas.push('Nada foi reescrito.');
  } else if (resultado.atualizado) {
    linhas.push(`Atualizei o agendamento existente: ${resultado.caminho}`);
    linhas.push('Mesmo rótulo, mesmo arquivo, então não há ritual duplicado.');
  } else {
    linhas.push(`Gravei o LaunchAgent: ${resultado.caminho}`);
  }
  linhas.push('');
  linhas.push(`Roda ${plano.hora}, de segunda a sexta, e escreve em ${plano.log}`);
  linhas.push('');
  linhas.push('Falta UM passo, e ele é seu:');
  if (resultado.mudou && resultado.atualizado) {
    linhas.push(`  launchctl unload ${shq(plano.plistPath)}`);
  }
  linhas.push(`  launchctl load ${shq(plano.plistPath)}`);
  linhas.push('');
  linhas.push('Eu não carrego o agente. Gravar o arquivo é reversível com um rm; carregar');
  linhas.push('é o que passa a disparar o comando sozinho na sua máquina, e essa decisão');
  linhas.push('é sua. Para desfazer tudo, rode o unload e apague o arquivo.');
  return linhas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Horário REALMENTE gravado no plist, lido do arquivo.
 *
 * Existe porque o `--status` erraria sem ele: o plano que o comando monta usa a
 * hora PADRÃO (o `--status` não recebe `--hora`), e reportar essa hora como se
 * fosse a agendada mentiria para quem aplicou em outro horário. Foi exatamente
 * o que o smoke test pegou: plist gravado às 07:15, status anunciando 08:00.
 * Não conseguir ler devolve `null`, e o texto diz que não sabe.
 */
export function horaAgendada(plistXml) {
  const h = /<key>Hour<\/key><integer>(\d+)<\/integer>/.exec(String(plistXml));
  const m = /<key>Minute<\/key><integer>(\d+)<\/integer>/.exec(String(plistXml));
  if (!h || !m) return null;
  return `${String(h[1]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
}

/**
 * Texto do `--status`. **Não roda `launchctl`**, nem para consultar: o que o
 * comando sabe é o que está em disco, e ele diz exatamente isso. Afirmar
 * "carregado" a partir da presença do arquivo seria inventar; o comando entrega
 * a linha para o usuário conferir.
 */
export function formatarStatus(plano, { plistExiste, marcador, marcadorPresenteIlegivel = false, horaNoArquivo = null }) {
  const linhas = ['🎩 Ritual do briefing matinal: status.', ''];

  if (plano.plataforma === 'darwin') {
    if (plistExiste) {
      linhas.push(`Agendamento gravado: ${plano.plistPath}`);
      linhas.push(horaNoArquivo
        ? `Previsto para ${horaNoArquivo}, de segunda a sexta.`
        : 'Não consegui ler o horário dentro do arquivo. Abra-o para conferir.');
      linhas.push('Se ele está carregado no launchd, eu não sei dizer daqui. Confira com:');
      linhas.push(`  launchctl list | grep ${shq(plano.rotulo)}`);
    } else {
      linhas.push('Nenhum agendamento gravado por mim para este projeto.');
      linhas.push(`Eu procurei em: ${plano.plistPath}`);
      linhas.push('Rode `legalsquad chefe --agendar` para ver a proposta.');
      linhas.push('Se você agendou por crontab ou pelo app Desktop, eu não enxergo daqui.');
    }
  } else {
    linhas.push(`Nesta plataforma (${plano.plataforma}) eu não gravo nem leio agendamento.`);
    linhas.push('Rode `legalsquad chefe --agendar` para a linha de crontab pronta.');
  }

  linhas.push('');
  if (marcador) {
    linhas.push(`Última execução do briefing: ${marcador.gerado_em} (status: ${marcador.status}, modo: ${marcador.modo || 'briefing'}).`);
    if (marcador.status === 'falha') {
      linhas.push('A última rodada terminou em falha. Rode `legalsquad chefe --briefing` à mão');
      linhas.push('para ver o motivo de cada fonte.');
    }
  } else if (marcadorPresenteIlegivel) {
    linhas.push('Há um registro de última execução, mas não consegui lê-lo.');
    linhas.push(`Arquivo: ${caminhoMarcador(plano.raiz)}`);
  } else {
    linhas.push('O briefing ainda não rodou nenhuma vez neste projeto.');
  }
  return linhas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador de linha de comando (a casca que imprime)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entrada dos modos `--agendar` e `--status`. Mesmo desenho do
 * `src/chefe-briefing.js`: o núcleo é puro, esta função é a única que imprime.
 * Devolve `{ success }` no padrão do bin.
 */
export function ritualCli(cwd, { agendar = false, aplicar = false, status = false, hora = HORA_PADRAO } = {}) {
  if (!ehCasaLegalSquad(cwd)) {
    // Mesma régua dos vizinhos: fora de uma casa não há projeto para agendar.
    // A mensagem sai em português direto (e não pelo i18n) porque estes textos
    // do ritual ainda não estão nos locales; ver README.
    console.error('Esta pasta não é uma casa LegalSquad (`_legalsquad/` ausente). Execute `npx legalsquad init` primeiro.');
    return { success: false };
  }

  const plano = montarPlano(cwd, { hora });
  if (plano.erro) {
    console.error(`chefe: ${plano.erro}`);
    return { success: false };
  }

  if (status) {
    const arquivo = caminhoMarcador(cwd);
    const marcador = lerMarcador(cwd);
    const plistExiste = existsSync(plano.plistPath);
    // O horário sai do ARQUIVO, não do plano: `--status` não recebe `--hora`, e
    // repetir o padrão aqui anunciaria um horário que pode não ser o agendado.
    let horaNoArquivo = null;
    if (plistExiste) {
      try {
        horaNoArquivo = horaAgendada(readFileSync(plano.plistPath, 'utf8'));
      } catch {
        horaNoArquivo = null;
      }
    }
    console.log(formatarStatus(plano, {
      plistExiste,
      marcador,
      marcadorPresenteIlegivel: !marcador && existsSync(arquivo),
      horaNoArquivo,
    }));
    return { success: true };
  }

  if (!agendar) {
    // `--aplicar` sozinho. Recusar aqui é o gate M3 em mecanismo: o "sim" só
    // vale como resposta a uma proposta que o usuário viu.
    console.error('chefe: `--aplicar` só funciona junto de `--agendar`. Rode `legalsquad chefe --agendar` primeiro para ver o que seria gravado.');
    return { success: false };
  }

  if (!aplicar) {
    console.log(formatarProposta(plano));
    return { success: true };
  }

  const resultado = aplicarPlano(plano);
  console.log(formatarAplicacao(plano, resultado));
  return { success: resultado.ok };
}
