// Leitura da árvore de conteúdo em entidades-arquivo (SPEC §6.2).
//
// Este módulo é a metade do empacotador que TOCA O DISCO — e só para LER. Ele
// recebe o diretório por argumento e nunca conhece caminho de repositório
// específico: empacota um checkout, um diretório exportado ou um tarball
// extraído, sem diferença. Se um dia precisar saber de quem é o conteúdo, o
// desenho está errado.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';
import { ehUserOwned } from './pack-format.js';

/** Nunca é conteúdo: artefato de sistema operacional ou diretório de máquina. */
const NOMES_IGNORADOS = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
// Derivado e local: o motor o regenera a cada sync/indexação (9 MB numa instalação de 6.584 skills).
const DERIVADOS_LOCAIS = new Set(['_catalog-cache.json']);
const DIRETORIOS_IGNORADOS = new Set(['node_modules', '.git']);

/**
 * Texto ou binário? A pergunta importa porque `text` e `b64` são mutuamente
 * exclusivos (§6.2). O critério é round-trip sem perda: um buffer que sobrevive
 * a `utf8` ida e volta, sem NUL, é texto. Qualquer dúvida cai em base64 — errar
 * para binário só custa ~33% de tamanho; errar para texto CORROMPE o arquivo.
 */
function ehTexto(buffer) {
  if (buffer.includes(0)) return false;
  return Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0;
}

/**
 * Lê `raiz` e devolve as entidades-arquivo das subárvores em `subarvores`.
 * Somente leitura — nada é escrito na origem, nem arquivo temporário.
 *
 * `path` sai relativo à raiz do projeto do usuário, sempre com `/`, mesmo em
 * Windows: o separador do sistema de build não pode vazar para dentro de um
 * artefato assinado.
 */
export function lerArvore(raiz, subarvores) {
  const entidades = [];

  const andar = (diretorio) => {
    // A exclusão vale para o diretório em si, não só para o que se encontra
    // descendo: sem isto, `node_modules/` passado como subárvore driblaria a
    // regra que `skills/node_modules/` respeita. Exclusão que depende de onde a
    // travessia começou não é exclusão.
    if (DIRETORIOS_IGNORADOS.has(basename(diretorio))) return;

    let entradas;
    try {
      entradas = readdirSync(diretorio, { withFileTypes: true });
    } catch (erro) {
      // Subárvore declarada e ausente é decisão de quem chamou (uma área pode
      // não ter `squads/`); qualquer outro erro de leitura é ruidoso.
      if (erro.code === 'ENOENT') return;
      throw erro;
    }

    for (const entrada of entradas) {
      if (NOMES_IGNORADOS.has(entrada.name) || DERIVADOS_LOCAIS.has(entrada.name)) continue;
      const alvo = join(diretorio, entrada.name);

      if (entrada.isDirectory()) {
        andar(alvo);
        continue;
      }
      if (!entrada.isFile()) continue;

      const caminho = relative(raiz, alvo).split(sep).join(posix.sep);
      // Subárvore do usuário nunca entra no pacote. O caso que engana é
      // `skills/_evals/results/`: o pacote leva o contrato e os CASOS de eval,
      // nunca a PROVA — empacotá-la mandaria a evidência de uma instalação para
      // dentro de outra, onde ela não significa nada. O applier também recusa
      // (defesa em profundidade), mas produzir o pacote inválido já é o erro.
      if (ehUserOwned(caminho)) continue;

      const buffer = readFileSync(alvo);
      const executavel = (statSync(alvo).mode & 0o111) !== 0;

      entidades.push({
        path: caminho,
        // Do conteúdo DECODIFICADO: é o que o `skill_binding` da evidência de
        // promoção amarra, e o que torna a verificação independente de o
        // arquivo ter viajado como texto ou base64.
        sha256: createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
        mode: executavel ? '755' : '644',
        ...(ehTexto(buffer) ? { text: buffer.toString('utf8') } : { b64: buffer.toString('base64') }),
      });
    }
  };

  for (const subarvore of subarvores) {
    andar(join(raiz, subarvore));
  }
  return entidades;
}
