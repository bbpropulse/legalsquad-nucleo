#!/usr/bin/env node
// Conversão dos autos em Markdown com OCR (`autos-para-md.py`), com o Python
// certo: o do ambiente virtual do projeto (`_legalsquad/.venv`, criado por
// `npm run autos:md:deps`) quando existe, senão o `python3`/`python` do PATH.
//
// Por que um ambiente virtual: o `pip install --user` falha no Python do
// Homebrew e em várias distribuições (PEP 668, "externally managed
// environment"), e foi assim que um run real de 506 páginas ficou com 73
// páginas digitalizadas sem leitura. O venv é do projeto, não da máquina, e
// não pede permissão de administrador.
//
//   node scripts/autos-md.mjs squads/<nome> [--sem-ocr] [--saida <dir>]   (= npm run autos:md)
//   node scripts/autos-md.mjs squads/<nome> --figuras                      (só as figuras, sem OCR)
//   node scripts/autos-md.mjs --deps                                       (= npm run autos:md:deps)
//
// `--figuras` é a passada de figuras sobre autos já convertidos: recorta as figuras embutidas e as
// fotos de dentro das folhas escaneadas, grava `figuras` no manifesto e os blocos no documento.md,
// sem refazer o OCR nem mudar o texto das folhas (o sumário do caso continua em dia). Aceita também
// a pasta do caso ou a própria pasta `autos/`.
//
// Sem PyMuPDF a conversão para ANTES de abrir o PDF, diz em português o que falta e manda o
// `--deps`, com saída 3 (dependência), distinta da falha de conversão. O `--deps` é idempotente:
// com o ambiente pronto, só confere e sai, e é por isso que o runner o manda rodar antes da primeira
// conversão de todo squad.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = dirname(AQUI);
const VENV = join(RAIZ, '_legalsquad', '.venv');
const WIN = process.platform === 'win32';
const PYTHON_DO_VENV = WIN ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');
const DEPENDENCIAS = ['pymupdf4llm', 'pytesseract', 'Pillow'];

function pythonDoSistema() {
  for (const cmd of WIN ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

/** O Python consegue importar as bibliotecas da conversão? `null` quando sim; senão, o nome da que falta. */
export function faltaNoPython(python, modulos = MODULOS) {
  for (const m of modulos) {
    const r = spawnSync(python, ['-c', `import ${m}`], { encoding: 'utf8' });
    if (r.status !== 0) return m;
  }
  return null;
}
// O que o conversor importa: PyMuPDF (`pymupdf`) é obrigatório; o resto degrada com aviso.
const MODULOS = ['pymupdf', 'pymupdf4llm', 'pytesseract', 'PIL'];
const COMO_PREPARAR = 'Prepare o ambiente do projeto uma vez com `npm run autos:md:deps` (ou `node scripts/autos-md.mjs --deps`): ele cria `_legalsquad/.venv` e instala PyMuPDF, pymupdf4llm, pytesseract e Pillow ali, sem mexer no Python da máquina (o `pip install` direto falha no Python do Homebrew e de várias distribuições). Depois converta de novo.';
/** Saída de "falta dependência": a mesma do `autos-para-md.py`, para o runner distinguir de PDF ruim. */
export const SAIDA_SEM_DEPENDENCIA = 3;

function rodar(cmd, args, opcoes = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opcoes });
  return r.status === 0;
}

function instalarDependencias() {
  const sistema = pythonDoSistema();
  if (!sistema) {
    console.error('autos-md: Python 3 não encontrado no PATH. Instale o Python 3 (python.org ou o gestor do sistema) e rode de novo.');
    return 1;
  }
  // Idempotente e rápido quando já está pronto: o runner manda rodar `--deps` antes de toda
  // primeira conversão, e reinstalar a cada squad custaria um minuto de rede à toa.
  if (existsSync(PYTHON_DO_VENV) && !faltaNoPython(PYTHON_DO_VENV)) {
    console.log(`autos-md: o ambiente do projeto já tem ${DEPENDENCIAS.join(', ')} (${VENV}).`);
    return avisarTesseract();
  }
  if (!existsSync(PYTHON_DO_VENV)) {
    console.log(`autos-md: criando o ambiente virtual do projeto em ${VENV}…`);
    if (!rodar(sistema, ['-m', 'venv', VENV])) {
      console.error('autos-md: não consegui criar o ambiente virtual (o pacote `venv` do Python está instalado?).');
      return 1;
    }
  }
  console.log(`autos-md: instalando ${DEPENDENCIAS.join(', ')} no ambiente do projeto…`);
  if (!rodar(PYTHON_DO_VENV, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])) { /* pip velho ainda instala */ }
  if (!rodar(PYTHON_DO_VENV, ['-m', 'pip', 'install', '--quiet', ...DEPENDENCIAS])) {
    console.error('autos-md: a instalação das dependências falhou (rede? proxy?). Veja a saída acima.');
    return 1;
  }
  return avisarTesseract();
}

function avisarTesseract() {
  const tesseract = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
  if (tesseract.error || tesseract.status !== 0) {
    console.error('autos-md: dependências Python prontas, mas o `tesseract` (OCR) não está no PATH: sem ele as páginas digitalizadas continuam sem texto. macOS: `brew install tesseract tesseract-lang`; Windows: instalador do UB Mannheim (marque o idioma Portuguese); Linux: `apt install tesseract-ocr tesseract-ocr-por`.');
    return 2;
  }
  console.log('autos-md: pronto. Converta com `npm run autos:md -- squads/<nome>`.');
  return 0;
}

function converter(args) {
  const python = existsSync(PYTHON_DO_VENV) ? PYTHON_DO_VENV : pythonDoSistema();
  if (!python) {
    console.error('autos-md: Python 3 não encontrado. Instale o Python 3 (python.org ou o gestor do sistema) e rode `npm run autos:md:deps`, que cria o ambiente do projeto.');
    return 1;
  }
  // Antes de abrir o PDF: sem PyMuPDF a conversão nem começa, e o erro do Python ("No module named
  // 'pymupdf'", em inglês) não diz o que fazer. Medido no teste com autos reais de 27/09/2026: a
  // primeira conversão falhou assim, e só a segunda, depois de instalar à mão, rodou.
  if (faltaNoPython(python, ['pymupdf']) === 'pymupdf') {
    console.error(`autos-md: falta o PyMuPDF (a biblioteca que lê o PDF) no Python ${python === PYTHON_DO_VENV ? `do ambiente do projeto (${VENV})` : `da máquina (${python})`}: a conversão não começou. ${COMO_PREPARAR}`);
    return SAIDA_SEM_DEPENDENCIA;
  }
  const r = spawnSync(python, [join(AQUI, 'autos-para-md.py'), ...args], { stdio: 'inherit' });
  if (r.status === SAIDA_SEM_DEPENDENCIA) console.error(`autos-md: ${COMO_PREPARAR}`);
  return r.status ?? 1;
}

// A marca da conversão que falhou (`_legalsquad/_tmp/conversao-autos.json`): o `proximo` a lê e
// pergunta ao profissional, em vez de esperar sem fim o manifesto que nunca vem (P6 da revisão de
// 22/10/2026). A conversão que termina bem a apaga.
const MARCA_DA_CONVERSAO = join(RAIZ, '_legalsquad', '_tmp', 'conversao-autos.json');
function marcarConversao(etapa, codigo, args) {
  try {
    if (codigo === 0) { if (etapa === 'conversao') rmSync(MARCA_DA_CONVERSAO, { force: true }); return; }
    mkdirSync(dirname(MARCA_DA_CONVERSAO), { recursive: true });
    writeFileSync(MARCA_DA_CONVERSAO, `${JSON.stringify({ etapa, codigo, alvo: args.find((a) => !a.startsWith('--')) || null, em: new Date().toISOString(), motivo: codigo === SAIDA_SEM_DEPENDENCIA ? 'dependencia-faltando' : etapa === 'dependencias' ? 'dependencias' : 'conversao-falhou' })}\n`);
  } catch { /* a marca é auxílio: sem ela, a conversão segue como antes */ }
}

// Só como programa: os testes importam `faltaNoPython` sem disparar a conversão.
// Pelo caminho real dos dois lados: com a pasta do projeto atrás de um link (no macOS, /tmp e /var), a
// comparação crua dava falso e a conversão saía 0 sem converter nada.
const caminhoReal = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && caminhoReal(fileURLToPath(import.meta.url)) === caminhoReal(resolve(process.argv[1]))) {
  const args = process.argv.slice(2);
  const deps = args.includes('--deps');
  const codigo = deps ? instalarDependencias() : converter(args);
  marcarConversao(deps ? 'dependencias' : 'conversao', codigo, args);
  process.exitCode = codigo;
}
