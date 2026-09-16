// Memória do chefe — MIKE-CHEFE.md §6 ("A pessoa: memória, rituais, checkpoints").
//
// O chefe que não lembra do escritório não é chefe: repete a mesma pergunta de
// onboarding, esquece que este escritório não usa travessão, e refaz decisão já
// tomada. Este módulo é a curadoria em disco dessa memória: um arquivo por FATO
// em `_legalsquad/_memory/chefe/`, mais um `MEMORY.md` de índice.
//
// TRÊS INVARIANTES, nesta ordem de importância:
//
// 1. **Dado identificável de cliente NUNCA entra** (LGPD; MIKE-CHEFE §10.4). Não
//    é convenção de prosa: `escrever()` RECUSA o gravação quando os detectores
//    acham CPF, CNPJ, OAB+UF, número de processo CNJ, e-mail ou telefone. Há
//    duas portas para dentro de `_memory/` e as duas estão trancadas com a MESMA
//    régua — o agente escrevendo pela ferramenta Write passa pelo hook
//    `.claude/hooks/guarda-memoria.mjs`; o motor escrevendo por código passa por
//    aqui. Trancar só uma das portas seria teatro.
// 2. **Memória é por PROJETO** — vive na casa do escritório, nunca em `~`, e
//    nunca viaja no pacote. `package.json` `files` publica só `_legalsquad/core/`
//    e `_legalsquad/config/`; `_memory/` fica de fora e o `scripts/verify.mjs`
//    reprova o tarball que a contenha (check "npm pack (higiene do tarball)",
//    linha `VAZAMENTO: _legalsquad/_memory/`). A exclusão JÁ EXISTE — este
//    módulo se apoia nela, não a cria.
// 3. **Puro e sem dependência**: só `node:fs`/`node:path` e o parser de
//    frontmatter da casa. O NÚCLEO (`escrever`/`ler`/`redigir`/detectores) não
//    faz rede, não lê `process.env` e não imprime — dá para testá-lo sem
//    capturar stdout. A única exceção é o adaptador `memoriaCli`, no fim do
//    arquivo, que existe justamente para ser a casca que imprime (mesmo
//    desenho de `src/chefe-briefing.js`).
//
// O que este módulo NÃO faz: não decide O QUE virar memória (isso é do chefe),
// não resume, não deduplica semanticamente e não expira fato velho. Curadoria
// de conteúdo é trabalho do chefe com revisão humana; aqui só há o mecanismo.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFrontMatter, parseScalar } from './frontmatter.js';

// "Hoje" é o dia no fuso do FORO, não o da máquina — a MESMA régua que o
// briefing do chefe usa (src/chefe-briefing.js documenta o porquê: contêiner e
// cron rodam em UTC). Aqui o efeito é menor que num prazo processual, mas duas
// datas diferentes para "hoje" dentro do mesmo chefe seria incoerência gratuita.
import { today as hojeNoForo } from '../scripts/orchestra/_lib.mjs';

/** Os quatro tipos de fato que o chefe registra. Fechado de propósito: tipo
 *  livre vira lixeira, e o índice deixa de ser navegável. */
export const TIPOS = Object.freeze(['perfil', 'preferencia', 'decisao', 'licao']);

/** Diretório da memória do chefe, dentro da casa do projeto. */
export function dirMemoria(raiz) {
  return join(String(raiz), '_legalsquad', '_memory', 'chefe');
}

/** Caminho do índice. */
export function caminhoIndice(raiz) {
  return join(dirMemoria(raiz), 'MEMORY.md');
}

// ─────────────────────────────────────────────────────────────────────────────
// Detectores de dado identificável
//
// ATENÇÃO — este bloco é DUPLICADO, de propósito, em
// `.claude/hooks/guarda-memoria.mjs`. O hook é copiado para dentro da casa do
// usuário (`init` copia `templates/ide-templates/<ide>/`), onde `src/` não
// existe em caminho relativo previsível; por isso todo hook da casa é
// self-contained (ver `.claude/hooks/verifica-citacoes.mjs`, que também só
// importa builtin). A trava contra divergência é o teste
// `tests/chefe-memoria.test.js`, que roda os DOIS sobre o mesmo corpus e exige
// veredito idêntico. Mexeu aqui, mexa lá — o teste cobra.
// ─────────────────────────────────────────────────────────────────────────────

/** Marcador que substitui cada tipo em `redigir()`. */
export const MARCADORES = Object.freeze({
  cpf: '[CPF removido]',
  cnpj: '[CNPJ removido]',
  oab: '[OAB removido]',
  processo_cnj: '[processo removido]',
  email: '[e-mail removido]',
  telefone: '[telefone removido]',
});

const UF = 'AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO';

// DDDs efetivamente alocados no Brasil. Sem esta lista, "de 10 a 30 pessoas"
// e "art. 20.1234-5678" viram telefone; com ela, o detector exige um prefixo
// que existe no plano de numeração.
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

/**
 * Dígitos verificadores do CPF (módulo 11). É ESTE cálculo — e não o formato —
 * que separa um CPF de um pedaço de número de processo: `\d{11}` casa com
 * qualquer coisa, o DV casa com 1 em ~100.
 */
export function cpfValido(valor) {
  const d = soDigitos(valor);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 000.000.000-00 e irmãos passam no módulo 11
  for (let corte = 9; corte <= 10; corte += 1) {
    let soma = 0;
    for (let i = 0; i < corte; i += 1) soma += Number(d[i]) * (corte + 1 - i);
    let dv = (soma * 10) % 11;
    if (dv === 10) dv = 0;
    if (dv !== Number(d[corte])) return false;
  }
  return true;
}

/** Dígitos verificadores do CNPJ (módulo 11, pesos 2..9 cíclicos). */
export function cnpjValido(valor) {
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

// Ordem = prioridade na resolução de sobreposição. O CNJ vem primeiro porque é
// o padrão mais longo e mais específico: quem casa com ele não deve ser
// reclassificado como telefone só porque um pedaço parece um.
const DETECTORES = [
  {
    tipo: 'processo_cnj',
    // NNNNNNN-DD.AAAA.J.TR.OOOO (Resolução CNJ 65/2008). Formato fixo: a
    // máscara já é o filtro, não há DV a conferir. A segunda alternativa cobre
    // a mesma numeração SEM pontuação (20 dígitos corridos) — é como o número
    // sai de sistema de tribunal, e sem ela a memória guardaria o processo
    // inteiro só por não estar formatado.
    re: /(?<!\d)(?:\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}|\d{20})(?!\d)/g,
  },
  {
    tipo: 'cnpj',
    re: /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/g,
    valida: cnpjValido,
  },
  {
    tipo: 'cpf',
    // Duas grafias. A nua exige `(?<!\d)…(?!\d)` para não morder o meio de uma
    // sequência maior (o CNJ sem pontuação tem 20 dígitos); a formatada não
    // precisa de guarda à direita, senão "CPF 111.444.777-35." no fim da frase
    // deixaria de casar por causa do ponto final.
    re: /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/g,
    valida: cpfValido,
  },
  {
    tipo: 'oab',
    // "OAB/SP 123.456", "OAB SP nº 123456" e a ordem inversa "OAB 123456/SP".
    // Exige a UF: "OAB" sozinho é assunto ("consultar a OAB"), não identificador.
    re: new RegExp(
      String.raw`\bOAB\b[\s./:-]{0,3}(?:${UF})\b[\s.:-]{0,3}(?:n[.º°o]{0,2}\s*)?\d[\d.]{2,}`
      + String.raw`|\bOAB\b[\s.:-]{0,3}(?:n[.º°o]{0,2}\s*)?\d[\d.]{2,}\s*[/-]\s*(?:${UF})\b`,
      'gi',
    ),
  },
  {
    tipo: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    tipo: 'telefone',
    // Quatro grafias reais, todas exigindo ESTRUTURA (parênteses, +55 ou
    // separador). Sequência de 10-11 dígitos crua NÃO é telefone aqui — seria
    // um gerador de falso positivo em cima de qualquer número do processo.
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
      if (d.length <= 9) return true; // número local com separador, sem DDD
      return DDDS.has(Number(d.slice(0, 2)));
    },
  },
];

/**
 * Acha dado identificável em `texto`.
 *
 * Devolve `[{ tipo, inicio, fim }]` — **nunca o valor casado**. Isso é
 * deliberado: o achado viaja para mensagem de erro e para stderr do hook, e um
 * relatório que ecoa o CPF só muda o dado de lugar. A mensagem diz O QUE achou,
 * não QUAL era.
 *
 * Sobreposição é resolvida por (posição, tamanho, prioridade do detector):
 * ganha quem começa antes; empatado, o mais longo; empatado, o de índice menor
 * na lista `DETECTORES`.
 */
export function detectar(texto) {
  const alvo = texto == null ? '' : String(texto);
  const brutos = [];
  DETECTORES.forEach(({ tipo, re, valida }, prioridade) => {
    // Regex `g` guarda `lastIndex`; recriar por chamada evita estado entre usos.
    const varredura = new RegExp(re.source, re.flags);
    let m = varredura.exec(alvo);
    while (m) {
      if (!valida || valida(m[0])) {
        brutos.push({ tipo, inicio: m.index, fim: m.index + m[0].length, prioridade });
      }
      if (m[0] === '') varredura.lastIndex += 1; // paranoia contra loop infinito
      m = varredura.exec(alvo);
    }
  });

  brutos.sort((a, b) => (
    a.inicio - b.inicio
    || (b.fim - b.inicio) - (a.fim - a.inicio)
    || a.prioridade - b.prioridade
  ));

  const achados = [];
  let limite = -1;
  for (const bruto of brutos) {
    if (bruto.inicio < limite) continue; // sobrepõe um achado já aceito
    achados.push({ tipo: bruto.tipo, inicio: bruto.inicio, fim: bruto.fim });
    limite = bruto.fim;
  }
  return achados;
}

/** Só os tipos encontrados, sem repetição e na ordem de `DETECTORES`. */
export function tiposDetectados(texto) {
  const vistos = new Set(detectar(texto).map((a) => a.tipo));
  return DETECTORES.map((d) => d.tipo).filter((tipo) => vistos.has(tipo));
}

/**
 * Devolve o texto com cada dado identificável trocado pelo marcador do tipo
 * (`[CPF removido]`, `[processo removido]`, …).
 *
 * É a ferramenta do chamador ANTES de gravar: `escrever()` não redige sozinho
 * de propósito. Redigir em silêncio esconderia do chefe (e do humano que
 * revisa) que ele quase gravou dado de cliente; o produto quer o contrário —
 * que o erro apareça, seja corrigido na origem ("cliente do caso X" em vez do
 * CPF) e não vire hábito.
 */
export function redigir(texto) {
  const alvo = texto == null ? '' : String(texto);
  const achados = detectar(alvo);
  if (!achados.length) return alvo;
  let saida = '';
  let cursor = 0;
  for (const { tipo, inicio, fim } of achados) {
    saida += alvo.slice(cursor, inicio) + MARCADORES[tipo];
    cursor = fim;
  }
  return saida + alvo.slice(cursor);
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrita e leitura
// ─────────────────────────────────────────────────────────────────────────────

const CABECALHO_INDICE = `# Memória do chefe

<!-- ÍNDICE GERADO por src/chefe-memoria.js — o corpo abaixo é reescrito a cada
     \`escrever()\` a partir dos arquivos desta pasta. Anotação à mão aqui se perde;
     escreva o fato como arquivo próprio.
     LGPD: nada nesta pasta pode conter dado identificável de cliente. A trava é
     mecânica (src/chefe-memoria.js + .claude/hooks/guarda-memoria.mjs). -->
`;

function slugificar(texto) {
  const slug = String(texto || '')
    .normalize('NFD')
    // Escrito com escape, não com o caractere literal: combining marks são
    // INVISÍVEIS na revisão de código (mesma razão do `\uFEFF` em frontmatter.js).
    .replace(/[\u0300-\u036f]/g, '') // tira acento sem perder a letra
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'fato';
}

function escaparPipe(texto) {
  // O índice é tabela Markdown: um `|` no título quebraria a linha em duas células.
  return String(texto).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** Lista os arquivos de fato (todo `.md` menos o índice), em ordem estável. */
function arquivosDeFato(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((nome) => nome.endsWith('.md') && nome !== 'MEMORY.md')
    .sort();
}

function lerFato(dir, nome) {
  const bruto = readFileSync(join(dir, nome), 'utf-8');
  const fm = extractFrontMatter(bruto);
  if (!fm) {
    // Frontmatter ilegível não some do índice: sumir em silêncio é como um fato
    // gravado deixa de existir sem ninguém notar. Entra marcado (mesma regra do
    // `readTrackerResult`, que CONTA as linhas ilegíveis em vez de descartá-las).
    return { arquivo: nome, tipo: '?', titulo: `(frontmatter ilegível) ${nome}`, data: '', origem: '', corpo: bruto, legivel: false };
  }
  return {
    arquivo: nome,
    tipo: parseScalar(fm, 'tipo') || '?',
    titulo: parseScalar(fm, 'titulo') || nome,
    data: parseScalar(fm, 'data') || '',
    origem: parseScalar(fm, 'origem') || '',
    corpo: bruto.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(),
    legivel: true,
  };
}

/** Reescreve `MEMORY.md` a partir dos arquivos em disco (índice auto-curável). */
function reindexar(dir) {
  const linhas = arquivosDeFato(dir).map((nome) => {
    const fato = lerFato(dir, nome);
    return `| ${fato.data || '—'} | ${fato.tipo} | ${escaparPipe(fato.titulo)} | [${nome}](${nome}) |`;
  });
  const corpo = linhas.length
    ? ['', '| Data | Tipo | Fato | Arquivo |', '|---|---|---|---|', ...linhas, ''].join('\n')
    : '\n_Sem fatos registrados._\n';
  const conteudo = `${CABECALHO_INDICE}${corpo}`;
  writeFileSync(join(dir, 'MEMORY.md'), conteudo, 'utf-8');
  return { arquivo: join(dir, 'MEMORY.md'), fatos: linhas.length };
}

/**
 * Grava UM fato e reindexa.
 *
 * @param {string} raiz  raiz da casa LegalSquad (a pasta que contém `_legalsquad/`).
 * @param {object} fato
 * @param {'perfil'|'preferencia'|'decisao'|'licao'} fato.tipo
 * @param {string} fato.titulo  uma linha — é o que aparece no índice.
 * @param {string} fato.corpo   o fato em si, em Markdown.
 * @param {string} [fato.origem='chefe']  quem apurou (onboarding, run, humano…).
 * @param {Date}   [fato.agora]  injetável para teste.
 * @returns {{ arquivo: string, indice: string, slug: string, data: string }}
 * @throws {TypeError}  tipo/título/corpo inválidos.
 * @throws {Error}      dado identificável no payload (`error.tipos` traz os tipos).
 */
export function escrever(raiz, { tipo, titulo, corpo, origem = 'chefe', agora = new Date() } = {}) {
  if (!TIPOS.includes(tipo)) {
    throw new TypeError(`tipo inválido: ${JSON.stringify(tipo)} — use um de ${TIPOS.join(' | ')}`);
  }
  const tituloLimpo = String(titulo == null ? '' : titulo).trim();
  if (!tituloLimpo) throw new TypeError('titulo é obrigatório');
  const corpoLimpo = String(corpo == null ? '' : corpo).trim();
  if (!corpoLimpo) throw new TypeError('corpo é obrigatório');

  // A TRAVA (LGPD). Vale para título, corpo E origem — origem já veio com
  // "e-mail do cliente fulano@..." em rascunho de desenho, e um campo de
  // procedência não é menos memória que o corpo.
  const tipos = tiposDetectados(`${tituloLimpo}\n${corpoLimpo}\n${origem}`);
  if (tipos.length) {
    const erro = new Error(
      `memória do chefe recusada: dado identificável detectado (${tipos.join(', ')}). `
      + 'Registre o FATO sem o dado — "cliente do caso X" em vez do CPF, '
      + '"o processo da comarca Y" em vez do número CNJ. '
      + 'Se o texto vier de terceiro, passe-o por redigir() antes.',
    );
    erro.code = 'LGPD_DADO_IDENTIFICAVEL';
    erro.tipos = tipos;
    throw erro;
  }

  const dir = dirMemoria(raiz);
  mkdirSync(dir, { recursive: true });

  const data = hojeNoForo(agora);
  const base = `${data}-${slugificar(tituloLimpo)}`;
  let nome = `${base}.md`;
  let n = 2;
  while (existsSync(join(dir, nome))) {
    nome = `${base}-${n}.md`;
    n += 1;
  }

  const conteudo = [
    '---',
    `tipo: ${tipo}`,
    `titulo: ${JSON.stringify(tituloLimpo)}`,
    `data: ${data}`,
    `origem: ${JSON.stringify(String(origem))}`,
    '---',
    '',
    corpoLimpo,
    '',
  ].join('\n');

  const arquivo = join(dir, nome);
  writeFileSync(arquivo, conteudo, 'utf-8');
  const { arquivo: indice } = reindexar(dir);
  return { arquivo, indice, slug: nome, data };
}

/**
 * Lê os fatos gravados. `{ tipo }` filtra; sem filtro, devolve todos.
 * Ordenado por data desc (mais recente primeiro) e, no empate, por nome de
 * arquivo desc — o desempate por nome mantém a ordem estável entre chamadas.
 * Pasta inexistente devolve `[]`: casa recém-inicializada não é erro.
 */
export function ler(raiz, { tipo } = {}) {
  const dir = dirMemoria(raiz);
  const fatos = arquivosDeFato(dir).map((nome) => lerFato(dir, nome));
  const filtrados = tipo ? fatos.filter((f) => f.tipo === tipo) : fatos;
  return filtrados.sort((a, b) => (
    String(b.data).localeCompare(String(a.data)) || String(b.arquivo).localeCompare(String(a.arquivo))
  ));
}

/**
 * O caminho está dentro da memória do chefe (ou de qualquer `_memory/`)?
 *
 * Exportado porque é o MESMO predicado de escopo do hook: fora de `_memory/`
 * nada aqui deve agir. Aceita caminho com `\` (Windows) e não exige que o
 * arquivo exista.
 */
export function dentroDaMemoria(caminho) {
  return /(?:^|[/\\])_legalsquad[/\\]_memory[/\\]/.test(String(caminho || '').replace(/\\/g, '/').replace(/\/+/g, '/'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptador de CLI — a ÚNICA parte deste arquivo que imprime.
//
// Existe porque o chefe é um agente numa sessão: ele não faz `import`, ele roda
// comando. Sem esta porta, o chefe grava memória escrevendo Markdown à mão —
// e aí o frontmatter sai torto, o índice apodrece e a trava LGPD depende
// exclusivamente do hook. Com ela, `escrever()` (que já recusa dado
// identificável) fica no caminho, e o índice nunca destoa dos arquivos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `legalsquad memoria [add] [--tipo t] [--titulo "…"] [--corpo "…"] [--origem o] [--json]`
 *
 * Sem subcomando, LISTA. Devolve `{ success }` no contrato das outras CLIs do
 * `bin/legalsquad.js` — e nunca vaza o valor detectado na mensagem de recusa.
 */
export function memoriaCli(raiz, subcomando, opcoes = {}) {
  const acao = subcomando || 'list';

  if (acao === 'add') {
    try {
      const { arquivo, data } = escrever(raiz, {
        tipo: opcoes.tipo,
        titulo: opcoes.titulo,
        corpo: opcoes.corpo,
        ...(opcoes.origem ? { origem: opcoes.origem } : {}),
      });
      console.log(`🎩 Anotado (${data}): ${arquivo}`);
      return { success: true, arquivo };
    } catch (erro) {
      // A recusa por LGPD é o caminho ESPERADO, não um crash: sai com mensagem
      // acionável e código 1, sem stack e sem repetir o dado.
      console.error(`✖ ${erro.message}`);
      return { success: false };
    }
  }

  if (acao !== 'list') {
    console.error(`Uso: legalsquad memoria [add --tipo <${TIPOS.join('|')}> --titulo "…" --corpo "…"]`);
    return { success: false };
  }

  const fatos = ler(raiz, opcoes.tipo ? { tipo: opcoes.tipo } : {});
  if (opcoes.json) {
    console.log(JSON.stringify(fatos, null, 2));
    return { success: true, fatos };
  }
  if (!fatos.length) {
    console.log('🎩 Ainda não me lembro de nada deste escritório.');
    return { success: true, fatos };
  }
  console.log(`🎩 O que eu lembro deste escritório (${fatos.length}):`);
  for (const f of fatos) console.log(`  ${f.data || '—'}  ${String(f.tipo).padEnd(12)} ${f.titulo}`);
  return { success: true, fatos };
}
