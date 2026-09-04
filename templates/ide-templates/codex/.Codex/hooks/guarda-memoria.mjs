#!/usr/bin/env node
/**
 * Guarda de Memória — trava LGPD da memória do chefe, como MECANISMO.
 *
 * MIKE-CHEFE.md §6 e §10.4: "Memória sem dado identificável de cliente, por
 * projeto, com bloqueio por hook (LGPD)". Uma linha de prosa mandando o chefe
 * "não gravar CPF" é exatamente o tipo de proibição que este produto já decidiu
 * que não segura — quem segura é o motor. Isto é o motor.
 *
 * POR QUE `PreToolUse`, se os outros dois hooks da casa são `PostToolUse`:
 * `verifica-citacoes.mjs` e `verifica-redacao.mjs` RELEEM O ARQUIVO DO DISCO,
 * então só funcionam depois da escrita (o frontmatter da skill `/legalsquad`
 * documenta isso: em PreToolUse eles leriam os bytes anteriores e toda peça
 * nova viraria falso positivo). Este aqui não lê disco nenhum — inspeciona
 * `tool_input.content`/`new_string`, o texto que a chamada QUER gravar. E
 * precisa mesmo ser antes: num gate de privacidade, "gravou e depois avisou" é
 * o dado já em disco, já no backup, já no git. PostToolUse aqui seria tarde.
 *
 * ESCOPO (estreito de propósito):
 * - roda como `PreToolUse` casando `Write|Edit`;
 * - só age quando o ALVO está dentro de `_legalsquad/_memory/`;
 * - qualquer escrita fora dali passa sem ser inspecionada e sem custo (uma
 *   regex de caminho e sai). Um gate de privacidade que atrapalha o resto da
 *   máquina é desinstalado na primeira semana, e aí não protege nada.
 *
 * FAIL-CLOSED, mas dentro do escopo — a distinção importa:
 * - entrada que NÃO permite sequer descobrir o caminho (stdin ilegível, JSON
 *   quebrado, sem `file_path`) → sai 0. Não sabemos se é memória; bloquear
 *   tudo aqui travaria a sessão inteira por um hook que nem sabe o que olha.
 * - a partir do momento em que o caminho é reconhecido como memória, TUDO que
 *   for dúvida bloqueia: conteúdo ausente, formato de tool_input inesperado,
 *   arquivo ilegível no modo `--check`.
 *
 * O QUE ELE DETECTA (e o que não): CPF e CNPJ com dígito verificador conferido,
 * OAB com UF, número de processo CNJ, e-mail e telefone brasileiro.
 * **Nome próprio NÃO é detectável com segurança** e não é tentado — "Dra.
 * Marina" e "o caso Marina" são indistinguíveis de "regime marinha" para
 * qualquer regra determinística, e um detector de nomes ou vaza (perde "João
 * Silva") ou bloqueia a memória inteira (todo substantivo capitalizado). A
 * consequência é declarada, não escondida: nome de cliente escrito na memória
 * PASSA por este hook. A régua editorial ("cliente do caso X", nunca o nome)
 * continua sendo do chefe e da revisão humana — o hook cobre o que dá para
 * cobrir mecanicamente e diz em voz alta o que não cobre.
 *
 * A mensagem de bloqueio nomeia O TIPO achado, nunca o VALOR: um gate de
 * privacidade que ecoa o CPF no stderr só mudou o dado de lugar.
 *
 * Sem dependência e sem import de `src/`: este arquivo é COPIADO para dentro da
 * casa do usuário (via `templates/ide-templates/<ide>/`), onde `src/` não existe
 * em caminho relativo previsível — mesma restrição de `verifica-citacoes.mjs`.
 * Os detectores são, por isso, duplicados de `src/chefe-memoria.js`; a trava
 * contra divergência é `tests/chefe-memoria.test.js`, que roda os dois sobre o
 * mesmo corpus e exige veredito idêntico.
 */

import { readFileSync } from 'node:fs';

const EXIT_BLOQUEADO = 2;

// Só este prefixo. `squads/*/_memory/` (memória de run por squad) NÃO está no
// escopo desta versão — ver MIKE-CHEFE §6, que fala da memória do chefe.
const ESCOPO = /(?:^|\/)_legalsquad\/_memory\//;

const MARCADORES = {
  cpf: '[CPF removido]',
  cnpj: '[CNPJ removido]',
  oab: '[OAB removido]',
  processo_cnj: '[processo removido]',
  email: '[e-mail removido]',
  telefone: '[telefone removido]',
};

const ROTULO = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  oab: 'inscrição OAB com UF',
  processo_cnj: 'número de processo (CNJ)',
  email: 'endereço de e-mail',
  telefone: 'telefone brasileiro',
};

const UF = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';

const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

const soDigitos = (texto) => String(texto).replace(/\D/g, '');

function cpfValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  for (let corte = 9; corte <= 10; corte += 1) {
    let soma = 0;
    for (let i = 0; i < corte; i += 1) soma += Number(d[i]) * (corte + 1 - i);
    let dv = (soma * 10) % 11;
    if (dv === 10) dv = 0;
    if (dv !== Number(d[corte])) return false;
  }
  return true;
}

function cnpjValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const dv = (tamanho) => {
    let peso = tamanho - 7;
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) {
      soma += Number(d[i]) * peso;
      peso -= 1;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

const DETECTORES = [
  // A 2ª alternativa é a mesma numeração CNJ sem pontuação (20 dígitos corridos).
  { tipo: 'processo_cnj', re: /(?<!\d)(?:\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}|\d{20})(?!\d)/g },
  { tipo: 'cnpj', re: /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/g, valida: cnpjValido },
  { tipo: 'cpf', re: /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/g, valida: cpfValido },
  {
    tipo: 'oab',
    re: new RegExp(
      String.raw`\bOAB\b[\s./:-]{0,3}(?:${UF})\b[\s.:-]{0,3}(?:n[.º°o]{0,2}\s*)?\d[\d.]{2,}`
      + String.raw`|\bOAB\b[\s.:-]{0,3}(?:n[.º°o]{0,2}\s*)?\d[\d.]{2,}\s*[/-]\s*(?:${UF})\b`,
      'gi',
    ),
  },
  { tipo: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  {
    tipo: 'telefone',
    re: new RegExp(
      [
        String.raw`\+\s?55[\s.-]?(?:\(\d{2}\)|\d{2})[\s.-]?\d{4,5}[\s.-]?\d{4}(?!\d)`,
        String.raw`\(\d{2}\)\s*\d{4,5}[\s.-]?\d{4}(?!\d)`,
        String.raw`(?<![\d(])\d{2}[\s.-]\d{4,5}[\s.-]\d{4}(?!\d)`,
        String.raw`(?<![\d(])9?\d{4}-\d{4}(?!\d)`,
      ].join('|'),
      'g',
    ),
    valida: (valor) => {
      const d = soDigitos(valor).replace(/^55/, '');
      if (d.length <= 9) return true;
      return DDDS.has(Number(d.slice(0, 2)));
    },
  },
];

/** Tipos achados, sem repetição e sem o valor casado. */
function tiposDetectados(texto) {
  const alvo = texto == null ? '' : String(texto);
  const achados = [];
  for (const { tipo, re, valida } of DETECTORES) {
    const varredura = new RegExp(re.source, re.flags);
    let m = varredura.exec(alvo);
    while (m) {
      if (!valida || valida(m[0])) {
        achados.push(tipo);
        break;
      }
      if (m[0] === '') varredura.lastIndex += 1;
      m = varredura.exec(alvo);
    }
  }
  return achados;
}

function normalizar(caminho) {
  return String(caminho || '').replace(/\\/g, '/');
}

function bloquear(motivo, tipos = []) {
  const lista = tipos.map((t) => ROTULO[t] || t).join(', ');
  const linhas = [
    `GUARDA DE MEMÓRIA — BLOQUEADO: ${motivo}`,
    lista ? `Tipo(s) detectado(s): ${lista}. (O valor não é repetido aqui de propósito.)` : '',
    'A memória do chefe é do ESCRITÓRIO, não do cliente (LGPD). Registre o FATO sem o dado:',
    '  • "cliente do caso X pediu parcelamento" em vez do CPF;',
    '  • "o processo da 3ª Vara Cível" em vez do número CNJ;',
    '  • "o contato é o sócio responsável" em vez do e-mail/telefone.',
    `Se precisar mesmo mascarar um texto de terceiro, use redigir() de src/chefe-memoria.js — ele troca cada achado por ${MARCADORES.cpf} e afins.`,
    'Dado identificável de cliente pertence ao acervo do caso (sigiloso, fora da memória), nunca a esta pasta.',
  ].filter(Boolean);
  const mensagem = linhas.join('\n');

  // Duas vias de bloqueio, de propósito: a decisão JSON (lida pelo harness que
  // a interpreta) E `exit 2` com stderr (que bloqueia pelo código de saída
  // sozinho). São redundantes; num gate fail-closed, redundância é a escolha
  // certa — o pior caso é a mensagem aparecer duas vezes, não o dado passar.
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: mensagem,
    },
  })}\n`);
  process.stderr.write(`${mensagem}\n`);
  process.exit(EXIT_BLOQUEADO);
}

/**
 * Junta tudo que a chamada QUER GRAVAR.
 *
 * Devolve `null` quando não consegue determinar o conteúdo — o chamador trata
 * `null` como bloqueio, porque no escopo da memória "não sei o que vai ser
 * escrito" e "vai ser escrito um CPF" precisam ter a mesma resposta.
 *
 * `old_string` do Edit é ignorado: é o que JÁ está no arquivo, não o que a
 * chamada introduz. Bloquear por ele impediria justamente a edição que REMOVE
 * um dado que vazou.
 */
function conteudoProposto(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const partes = [];
  if (typeof toolInput.content === 'string') partes.push(toolInput.content);
  if (typeof toolInput.new_string === 'string') partes.push(toolInput.new_string);
  // Forma de lote (MultiEdit e parentes): cada item traz seu `new_string`.
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.new_string === 'string') partes.push(edit.new_string);
      else return null; // item em formato desconhecido — não dá para afirmar que é limpo
    }
  }
  return partes.length ? partes.join('\n') : null;
}

function inspecionar(caminho, conteudo) {
  if (!ESCOPO.test(normalizar(caminho))) return; // fora do escopo: nem lê
  if (conteudo === null) {
    bloquear(
      `não foi possível determinar o conteúdo proposto para ${normalizar(caminho)} — `
      + 'dentro de _legalsquad/_memory/ o desconhecido é tratado como suspeito',
    );
  }
  const tipos = tiposDetectados(conteudo);
  if (tipos.length) {
    bloquear(`a escrita em ${normalizar(caminho)} contém dado identificável de cliente`, tipos);
  }
}

// ── Modo CLI: `guarda-memoria.mjs --check <arquivo>` ─────────────────────────
// Audita um arquivo de memória JÁ gravado (ex.: memória herdada de antes do
// gate). Mesmo veredito, mesma mensagem.
const indiceCheck = process.argv.indexOf('--check');
if (indiceCheck >= 0) {
  const alvo = process.argv[indiceCheck + 1];
  if (!alvo) {
    process.stderr.write('uso: guarda-memoria.mjs --check <arquivo-dentro-de-_legalsquad/_memory>\n');
    process.exit(EXIT_BLOQUEADO);
  }
  if (!ESCOPO.test(normalizar(alvo))) process.exit(0);
  let conteudo = null;
  try {
    conteudo = readFileSync(alvo, 'utf8');
  } catch (erro) {
    bloquear(`não foi possível ler ${normalizar(alvo)} para auditar (${erro.code || erro.message})`);
  }
  inspecionar(alvo, conteudo);
  process.exit(0);
}

// ── Modo hook: JSON do PreToolUse em stdin ──────────────────────────────────
let bruto = '';
try {
  bruto = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // sem stdin não há caminho a reconhecer — fora do escopo
}

let dados;
try {
  dados = JSON.parse(bruto);
} catch {
  process.exit(0); // idem: JSON quebrado não permite nem saber se é memória
}

const toolInput = dados && typeof dados === 'object' ? dados.tool_input : null;
const caminho = toolInput && typeof toolInput === 'object'
  ? (toolInput.file_path || toolInput.path || '')
  : '';
if (!caminho) process.exit(0);

inspecionar(caminho, conteudoProposto(toolInput));
process.exit(0);
