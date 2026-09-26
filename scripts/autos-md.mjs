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
//   node scripts/autos-md.mjs --deps                                       (= npm run autos:md:deps)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const tesseract = spawnSync('tesseract', ['--version'], { encoding: 'utf8' });
  if (tesseract.status !== 0) {
    console.error('autos-md: dependências Python prontas, mas o `tesseract` (OCR) não está no PATH: sem ele as páginas digitalizadas continuam sem texto. macOS: `brew install tesseract tesseract-lang`; Windows: instalador do UB Mannheim (marque o idioma Portuguese); Linux: `apt install tesseract-ocr tesseract-ocr-por`.');
    return 2;
  }
  console.log('autos-md: pronto. Converta com `npm run autos:md -- squads/<nome>`.');
  return 0;
}

function converter(args) {
  const python = existsSync(PYTHON_DO_VENV) ? PYTHON_DO_VENV : pythonDoSistema();
  if (!python) {
    console.error('autos-md: Python 3 não encontrado. Rode `npm run autos:md:deps` (cria o ambiente do projeto) ou instale o Python 3.');
    return 1;
  }
  const r = spawnSync(python, [join(AQUI, 'autos-para-md.py'), ...args], { stdio: 'inherit' });
  if (r.status !== 0 && !existsSync(PYTHON_DO_VENV)) {
    console.error('autos-md: se o erro acima for de biblioteca ausente (PyMuPDF, pytesseract), rode `npm run autos:md:deps`: ele cria um ambiente virtual do projeto e instala tudo lá, sem mexer no Python da máquina.');
  }
  return r.status ?? 1;
}

const args = process.argv.slice(2);
process.exitCode = args.includes('--deps') ? instalarDependencias() : converter(args);
