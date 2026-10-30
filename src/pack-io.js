// Gravação e leitura de um pacote no disco.
//
// O build devolve buffers em memória; em produção o pacote é gravado,
// transportado e lido de novo — e é nesse trecho que a adulteração acontece. Por
// isso a leitura devolve os buffers CRUS, sem verificar: quem lê é obrigado a
// passar por `verificarPacote` antes de aplicar. Uma função que lesse e
// verificasse junto convidaria a esquecer o segundo passo.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFESTO = 'manifest.json';

/**
 * Grava um pacote em `<raiz>/<pack_id>@<versão>/` e devolve o diretório.
 * O manifesto sai indentado de propósito: ele é o que um humano audita.
 */
export function gravarPacote(raiz, pacote) {
  const dir = join(raiz, `${pacote.packId}@${pacote.manifesto.version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFESTO), `${JSON.stringify(pacote.manifesto, null, 2)}\n`);
  for (const entidade of pacote.entidades) {
    writeFileSync(join(dir, entidade.file), entidade.buffer);
  }
  return dir;
}

/**
 * Lê um pacote do disco. Falha RUIDOSAMENTE em manifesto ilegível ou entidade
 * ausente — "não sei ler" nunca pode se apresentar como "não existe", e um
 * pacote meio-lido instalaria uma área pela metade.
 *
 * NÃO verifica assinatura: isso é `verificarPacote`, e é obrigatório antes de
 * aplicar. A separação é deliberada — ler é I/O, verificar é confiança.
 */
export function lerPacoteDoDisco(dir) {
  const caminhoManifesto = join(dir, MANIFESTO);

  let manifesto;
  try {
    manifesto = JSON.parse(readFileSync(caminhoManifesto, 'utf8'));
  } catch (erro) {
    throw new Error(`pack-io: não consegui ler ${caminhoManifesto} — ${erro.message}`, { cause: erro });
  }

  const declaradas = Array.isArray(manifesto.entities) ? manifesto.entities : [];
  const entidades = declaradas.map((declarada) => {
    const alvo = join(dir, declarada.file);
    let buffer;
    try {
      buffer = readFileSync(alvo);
    } catch (erro) {
      throw new Error(
        `pack-io: entidade declarada no manifesto e ausente do disco — ${declarada.file} (${alvo})`,
        { cause: erro }
      );
    }
    return { file: declarada.file, role: declarada.role, buffer };
  });

  // Entidade no disco que o manifesto não declara viaja FORA da assinatura. Aqui
  // ela é só reportada — quem recusa é `verificarPacote`, que é a autoridade.
  const noDisco = readdirSync(dir).filter((nome) => nome !== MANIFESTO);
  for (const nome of noDisco) {
    if (!declaradas.some((d) => d.file === nome)) {
      entidades.push({ file: nome, role: 'desconhecida', buffer: readFileSync(join(dir, nome)) });
    }
  }

  return { manifesto, entidades };
}
