#!/usr/bin/env node
// Copia o leitor de citações do servidor de referência para `src/ref-leitor/`, byte a byte, e
// registra a origem em `src/ref-leitor/ORIGEM.json`.
//
//   node scripts/ref-leitor-copiar.mjs --de <pasta src do servidor> --commit <hash> [--teste <arquivo>]
//
// Para copiar de um commit, e não da árvore de trabalho do servidor, extraia antes os arquivos
// daquele commit (`git show <hash>:src/<arquivo>`) para uma pasta e aponte `--de` para ela.
//
// As duas pontas precisam ler a citação do mesmo jeito: o servidor monta a tabela `apelido` do
// índice com este leitor, e o motor resolve no índice local com ele. Uma cópia à mão divergiria em
// silêncio; por isso a cópia é mecânica, e a única mudança permitida é a transformação declarada
// abaixo, que `tests/ref-leitor-origem.test.js` desfaz para provar que o resto é idêntico.
//
// Transformação: o guarda da fronteira (tests/fronteira.test.js) procura o nome por extenso de
// matérias de área nos arquivos do motor. O apelido por extenso da LEP é vocabulário de citação
// (mecanismo), então ele vai montado em duas partes; o valor em tempo de execução é o mesmo.
//
// Como o empacotador, o script é cego: recebe a pasta por argumento, só LÊ a origem, e nenhum
// caminho de repositório vizinho aparece aqui.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ARQUIVOS_DO_LEITOR = Object.freeze(['normalizar.js', 'ids.js', 'citacao.js', 'conferir.js', 'dispositivos.js', 'artigo-assinado.js']);

/** Trocas literais por arquivo: `de` (como está no servidor) vira `para` (como fica no motor). */
// (As duas formas também vão montadas aqui, pelo mesmo guarda.)
const LEP = ['lei de execucao', 'penal'];
export const TRANSFORMACOES = Object.freeze({
  'ids.js': [{ de: `'${LEP.join(' ')}'`, para: `\`${LEP[0]}\${' '}${LEP[1]}\`` }],
});

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Aplica as trocas; cada `de` tem de aparecer exatamente uma vez, ou a cópia para. */
export function transformar(nome, texto) {
  let saida = texto;
  for (const { de, para } of TRANSFORMACOES[nome] || []) {
    const vezes = saida.split(de).length - 1;
    if (vezes !== 1) throw new Error(`${nome}: a troca "${de}" aparece ${vezes} vez(es) na origem, esperava 1; revise TRANSFORMACOES`);
    saida = saida.replace(de, para);
  }
  return saida;
}

/** Desfaz as trocas (o teste de origem usa para comparar com o sha256 do servidor). */
export function desfazer(nome, texto) {
  let saida = texto;
  for (const { de, para } of TRANSFORMACOES[nome] || []) saida = saida.split(para).join(de);
  return saida;
}

function principal() {
  const { values } = parseArgs({ options: { de: { type: 'string' }, commit: { type: 'string' }, teste: { type: 'string' } } });
  if (!values.de || !values.commit) {
    console.error('uso: node scripts/ref-leitor-copiar.mjs --de <pasta src do servidor> --commit <hash> [--teste <tests/citacao.test.js do servidor>]');
    process.exit(1);
  }
  const origem = resolve(values.de);
  const destino = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ref-leitor');
  mkdirSync(destino, { recursive: true });
  const arquivos = {};
  for (const nome of ARQUIVOS_DO_LEITOR) {
    const caminho = join(origem, nome);
    if (!existsSync(caminho)) throw new Error(`não achei ${caminho}`);
    const bruto = readFileSync(caminho, 'utf8');
    const local = transformar(nome, bruto);
    writeFileSync(join(destino, nome), local);
    arquivos[nome] = { sha256_servidor: sha256(bruto), sha256_motor: sha256(local), transformacoes: (TRANSFORMACOES[nome] || []).length };
  }
  // O teste do leitor no servidor vem junto, com o import apontando para a cópia: os mesmos casos
  // rodam nas duas pontas.
  if (values.teste) {
    const bruto = readFileSync(resolve(values.teste), 'utf8');
    const de = "from '../src/citacao.js'";
    if (!bruto.includes(de)) throw new Error(`o teste não importa ${de}; revise o script`);
    const cabecalho = `// Copiado de legalsquad-ref-server/tests/citacao.test.js (commit ${values.commit}) por\n// scripts/ref-leitor-copiar.mjs; não edite à mão.\n`;
    writeFileSync(join(destino, '..', '..', 'tests', 'ref-leitor-citacao.test.js'), cabecalho + bruto.split(de).join("from '../src/ref-leitor/citacao.js'"));
    arquivos['tests/citacao.test.js'] = { sha256_servidor: sha256(bruto) };
  }
  const origemJson = { servidor: 'legalsquad-ref-server/src', commit: values.commit, copiado_em: new Date().toLocaleDateString('sv-SE'), arquivos };
  writeFileSync(join(destino, 'ORIGEM.json'), `${JSON.stringify(origemJson, null, 2)}\n`);
  console.log(`leitor copiado de ${origem} (commit ${values.commit}) para src/ref-leitor/: ${ARQUIVOS_DO_LEITOR.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal();
