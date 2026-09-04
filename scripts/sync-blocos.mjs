#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Sincroniza os blocos que são duplicados POR NECESSIDADE.
//
// O canônico vive em src/. As cópias existem porque templates/scripts/ é
// distribuído ao projeto do usuário, que não tem src/ para importar. Até aqui
// a sincronia era apenas GUARDADA por testes de igualdade textual: o drift era
// detectado, mas a correção era copiar e colar à mão — e isso já causou bug
// real. Este script CONSERTA; o teste continua sendo a rede.
//
//   node scripts/sync-blocos.mjs            propaga src/ → cópias
//   node scripts/sync-blocos.mjs --check    não escreve; sai 1 se divergir
//
// Um bloco é delimitado por marcadores de LINHA:
//
//   // >>> <nome>:begin
//   ...conteúdo...
//   // <<< <nome>:end
//
// Só o miolo entre os marcadores é copiado, byte a byte. Os marcadores e todo
// o resto do arquivo (imports, comentários, exports) nunca são tocados — cada
// cópia mantém a moldura que o seu contexto exige.
//
// Silêncio aqui recriaria o problema que o script existe para matar: qualquer
// anomalia estrutural (marcador órfão, bloco ausente, marcador duplicado ou
// aninhado) é ERRO, nos dois modos, com saída 1.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// O MAPA. Um bloco novo é uma linha: nome, fonte da verdade, cópias.
// Caminhos relativos à raiz do repositório, sempre com "/".
// ---------------------------------------------------------------------------
export const BLOCOS = [
  { nome: 'review-loop', canonico: 'src/review-loop.js', copias: ['scripts/squad-state.mjs', 'templates/scripts/squad-state.mjs'] },
  { nome: 'skill-uso', canonico: 'src/skill-uso.js', copias: ['scripts/squad-state.mjs', 'templates/scripts/squad-state.mjs'] },
  { nome: 'run-state', canonico: 'src/run-state.js', copias: ['scripts/squad-state.mjs', 'templates/scripts/squad-state.mjs'] },
  { nome: 'squad-path', canonico: 'src/squad-path.js', copias: ['scripts/squad-path.mjs', 'templates/scripts/squad-path.mjs'] },
  { nome: 'abertura-run', canonico: 'src/abertura-run.js', copias: ['scripts/squad-state.mjs', 'templates/scripts/squad-state.mjs'] },
  { nome: 'acervo-index', canonico: 'src/acervo-search.js', copias: ['scripts/cobertura-acervo.mjs', 'templates/scripts/cobertura-acervo.mjs'] },
  { nome: 'redacao-gate', canonico: 'src/redacao-gate.js', copias: ['templates/ide-templates/claude-code/.claude/hooks/verifica-redacao.mjs', 'templates/ide-templates/codex/.Codex/hooks/verifica-redacao.mjs'] },
];

// `^` e `$` em modo multilinha: o marcador é uma linha inteira. `[ \t\r]*$`
// tolera CRLF e espaço à direita sem aceitar código na mesma linha.
const FONTE_MARCADOR = String.raw`^[ \t]*\/\/ (>>>|<<<) ([A-Za-z0-9][A-Za-z0-9._-]*):(begin|end)[ \t\r]*$`;

function linhaDe(raw, indice) {
  let linha = 1;
  for (let i = 0; i < indice; i += 1) if (raw.charCodeAt(i) === 10) linha += 1;
  return linha;
}

/**
 * Varre TODOS os marcadores do arquivo (não só os do mapa) e devolve os blocos
 * bem formados. Qualquer anomalia estrutural vira erro — inclusive marcadores
 * de blocos que ninguém declarou, porque um `begin` órfão perdido no arquivo é
 * exatamente o tipo de coisa que faz o próximo `end` fechar o bloco errado.
 */
export function escanearBlocos(raw, arquivo) {
  const erros = [];
  const blocos = new Map();
  const marcadores = [];

  const regex = new RegExp(FONTE_MARCADOR, 'gm');
  let achado = regex.exec(raw);
  while (achado !== null) {
    const [texto, seta, nome, palavra] = achado;
    const abre = palavra === 'begin';
    const linha = linhaDe(raw, achado.index);
    if (abre !== (seta === '>>>')) {
      erros.push(`${arquivo}:${linha}: marcador malformado "${texto.trim()}" — use "// >>> ${nome}:begin" e "// <<< ${nome}:end"`);
    } else {
      marcadores.push({ nome, abre, linha, inicio: achado.index, fim: achado.index + texto.length });
    }
    achado = regex.exec(raw);
  }

  let aberto = null;
  for (const marcador of marcadores) {
    if (marcador.abre) {
      if (aberto) {
        erros.push(`${arquivo}:${marcador.linha}: "${marcador.nome}:begin" aninhado dentro de "${aberto.nome}" (aberto na linha ${aberto.linha})`);
      } else if (blocos.has(marcador.nome)) {
        erros.push(`${arquivo}:${marcador.linha}: "${marcador.nome}:begin" duplicado (o primeiro está na linha ${blocos.get(marcador.nome).linha})`);
      } else {
        aberto = marcador;
      }
      continue;
    }
    if (!aberto) {
      erros.push(`${arquivo}:${marcador.linha}: "${marcador.nome}:end" sem "${marcador.nome}:begin" correspondente`);
    } else if (aberto.nome !== marcador.nome) {
      erros.push(`${arquivo}:${marcador.linha}: "${marcador.nome}:end" fecha um bloco diferente do aberto ("${aberto.nome}", linha ${aberto.linha})`);
    } else {
      blocos.set(marcador.nome, {
        nome: marcador.nome,
        linha: aberto.linha,
        // O miolo vai do fim do marcador `begin` (antes da quebra de linha) ao
        // início da LINHA do marcador `end`. Fatiar assim preserva as quebras
        // de linha e a indentação exatamente como estão no disco.
        inicio: aberto.fim,
        fim: marcador.inicio,
        conteudo: raw.slice(aberto.fim, marcador.inicio),
      });
      aberto = null;
    }
  }
  if (aberto) {
    erros.push(`${arquivo}:${aberto.linha}: "${aberto.nome}:begin" sem "${aberto.nome}:end" correspondente`);
  }

  return { blocos, erros };
}

function lerArquivo(root, relativo, erros) {
  try {
    return readFileSync(join(root, relativo), 'utf-8');
  } catch (erro) {
    erros.push(`${relativo}: não deu para ler (${erro.code || erro.message})`);
    return null;
  }
}

/** Linhas do miolo, sem a quebra que segue o `begin` nem a que precede o `end`. */
function corpoEmLinhas(conteudo) {
  const linhas = conteudo.split('\n');
  if (linhas.length <= 2) return [];
  return linhas.slice(1, -1);
}

function descreverDivergencia({ nome, canonico, arquivo, esperado, encontrado, linhaDoBegin }) {
  const a = corpoEmLinhas(esperado);
  const b = corpoEmLinhas(encontrado);
  const partes = [`bloco "${nome}" divergiu em ${arquivo} (canônico: ${canonico})`];
  if (a.length !== b.length) {
    partes.push(`    a cópia tem ${b.length} linha(s); o canônico tem ${a.length}`);
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const linhaNoArquivo = linhaDoBegin + 1 + i;
  if (i < a.length && i < b.length) {
    partes.push(`    primeira diferença na linha ${linhaNoArquivo} de ${arquivo}:`);
    partes.push(`      canônico  : ${a[i]}`);
    partes.push(`      cópia     : ${b[i]}`);
  } else if (i < a.length) {
    partes.push(`    a cópia termina cedo; falta a partir da linha ${linhaNoArquivo}:`);
    partes.push(`      canônico  : ${a[i]}`);
  } else if (i < b.length) {
    partes.push(`    a cópia tem linha sobrando a partir da ${linhaNoArquivo}:`);
    partes.push(`      cópia     : ${b[i]}`);
  } else {
    partes.push('    o miolo só difere em espaço em branco fora das linhas de código');
  }
  return partes.join('\n');
}

/**
 * @param {object} [opcoes]
 * @param {string} [opcoes.root]   raiz do repositório
 * @param {Array}  [opcoes.blocos] mapa bloco→arquivos
 * @param {boolean}[opcoes.check]  true = não escreve nada, só relata
 */
export function sincronizarBlocos({ root = DEFAULT_ROOT, blocos = BLOCOS, check = false } = {}) {
  const erros = [];
  const divergencias = [];
  const atualizados = [];

  // 1. Os canônicos. Se a fonte da verdade estiver quebrada, nada é propagado.
  const canonicos = new Map();
  const escaneados = new Map();

  const escanear = (relativo) => {
    if (escaneados.has(relativo)) return escaneados.get(relativo);
    const raw = lerArquivo(root, relativo, erros);
    const resultado = raw === null ? null : { raw, ...escanearBlocos(raw, relativo) };
    if (resultado) erros.push(...resultado.erros);
    escaneados.set(relativo, resultado);
    return resultado;
  };

  for (const bloco of blocos) {
    const fonte = escanear(bloco.canonico);
    if (!fonte) continue;
    const encontrado = fonte.blocos.get(bloco.nome);
    if (!encontrado) {
      erros.push(`${bloco.canonico}: bloco "${bloco.nome}" declarado no mapa mas ausente no arquivo`);
      continue;
    }
    if (!encontrado.conteudo.trim()) {
      erros.push(`${bloco.canonico}: bloco "${bloco.nome}" está vazio — propagar isso apagaria as cópias`);
      continue;
    }
    canonicos.set(bloco.nome, { ...encontrado, arquivo: bloco.canonico });
  }

  // 2. As cópias, agrupadas por arquivo (um arquivo pode hospedar vários
  //    blocos: reescrever de uma vez evita invalidar offsets no meio do caminho).
  const porArquivo = new Map();
  for (const bloco of blocos) {
    for (const copia of bloco.copias) {
      if (copia === bloco.canonico) {
        erros.push(`${copia}: bloco "${bloco.nome}" lista o próprio canônico como cópia`);
        continue;
      }
      if (!porArquivo.has(copia)) porArquivo.set(copia, []);
      porArquivo.get(copia).push(bloco.nome);
    }
  }

  // 3. Fase de LEITURA: escaneia TODAS as cópias e computa as edições sem
  //    escrever um byte. Só com o conjunto inteiro de erros na mão o gate
  //    estrutural abaixo é honesto — um begin órfão no ÚLTIMO arquivo precisa
  //    impedir a escrita no primeiro, senão "nada foi propagado" sai falso.
  let comparados = 0;
  const pendentes = [];
  for (const [arquivo, nomes] of porArquivo) {
    const alvo = escanear(arquivo);
    if (!alvo) continue;

    const edicoes = [];
    for (const nome of nomes) {
      const canonico = canonicos.get(nome);
      if (!canonico) continue; // erro já registrado na fase 1
      const atual = alvo.blocos.get(nome);
      if (!atual) {
        erros.push(`${arquivo}: bloco "${nome}" declarado no mapa mas ausente no arquivo`);
        continue;
      }
      comparados += 1;
      if (atual.conteudo === canonico.conteudo) continue;
      divergencias.push({
        nome,
        arquivo,
        canonico: canonico.arquivo,
        detalhe: descreverDivergencia({
          nome,
          canonico: canonico.arquivo,
          arquivo,
          esperado: canonico.conteudo,
          encontrado: atual.conteudo,
          linhaDoBegin: atual.linha,
        }),
      });
      edicoes.push({ nome, inicio: atual.inicio, fim: atual.fim, conteudo: canonico.conteudo });
    }
    if (edicoes.length) pendentes.push({ arquivo, raw: alvo.raw, edicoes });
  }

  // 4. Fase de ESCRITA: só depois de todos os arquivos lidos, e só com a
  //    estrutura inteira sã. Qualquer erro ⇒ zero escrita, por construção.
  if (!check && erros.length === 0) {
    for (const { arquivo, raw, edicoes } of pendentes) {
      // De trás para a frente: cada substituição mexe nos offsets seguintes.
      let saida = raw;
      for (const edicao of [...edicoes].sort((a, b) => b.inicio - a.inicio)) {
        saida = saida.slice(0, edicao.inicio) + edicao.conteudo + saida.slice(edicao.fim);
      }
      writeFileSync(join(root, arquivo), saida);
      atualizados.push({ arquivo, blocos: edicoes.map((e) => e.nome) });
    }
  }

  const ok = erros.length === 0 && (!check || divergencias.length === 0);
  return { ok, check, erros, divergencias, atualizados, comparados, blocos: blocos.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const USO = [
  'Uso: node scripts/sync-blocos.mjs [--check] [--root <dir>]',
  '',
  '  (sem flags)   propaga o bloco canônico de src/ para todas as cópias',
  '  --check       não escreve nada; sai 1 se alguma cópia divergir',
  '  --root <dir>  raiz alternativa (usado pelos testes)',
].join('\n');

export function parseArgs(argv) {
  const opcoes = { check: false, root: DEFAULT_ROOT, ajuda: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opcoes.check = true;
    else if (arg === '--help' || arg === '-h') opcoes.ajuda = true;
    else if (arg === '--root') {
      i += 1;
      if (!argv[i]) throw new Error('--root exige um diretório');
      opcoes.root = argv[i];
    } else throw new Error(`argumento desconhecido: ${arg}`);
  }
  return opcoes;
}

function main(argv) {
  let opcoes;
  try {
    opcoes = parseArgs(argv);
  } catch (erro) {
    console.error(`${erro.message}\n\n${USO}`);
    process.exitCode = 1;
    return;
  }
  if (opcoes.ajuda) {
    console.log(USO);
    return;
  }

  const resultado = sincronizarBlocos({ root: opcoes.root, check: opcoes.check });

  if (resultado.erros.length) {
    console.error('Estrutura de blocos quebrada — nada foi propagado:');
    console.error(resultado.erros.map((e) => `  - ${e}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  if (opcoes.check) {
    if (resultado.divergencias.length) {
      console.error(`Cópias fora de sincronia (${resultado.divergencias.length}):\n`);
      console.error(resultado.divergencias.map((d) => `  - ${d.detalhe}`).join('\n\n'));
      console.error('\nRode `npm run sync:blocos` para propagar o canônico.');
      process.exitCode = 1;
      return;
    }
    console.log(`Blocos em sincronia: ${resultado.comparados} cópia(s) de ${resultado.blocos} bloco(s).`);
    return;
  }

  if (!resultado.atualizados.length) {
    console.log(`Nada a fazer: ${resultado.comparados} cópia(s) de ${resultado.blocos} bloco(s) já em sincronia.`);
    return;
  }
  for (const item of resultado.atualizados) {
    console.log(`atualizado ${item.arquivo} (bloco${item.blocos.length > 1 ? 's' : ''}: ${item.blocos.join(', ')})`);
  }
  console.log(`${resultado.atualizados.length} arquivo(s) atualizado(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
