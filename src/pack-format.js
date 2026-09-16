// Container do pacote assinado (SPEC §6). Um formato, dois tipos de payload:
// `tree` (uma linha = um arquivo) e `records` (uma linha = um registro jurídico).
//
// Zero dependências por decisão de projeto: `node:zlib` traz zstd nativo e
// `node:crypto` traz Ed25519. Nada de binário externo no caminho de build nem no
// de verificação — verificar assinatura não pode depender de instalar nada.

import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { createHash, sign as assinarEd25519, verify as verificarEd25519 } from 'node:crypto';

/** Versão do formato. Cliente que não conhecer a versão RECUSA — não adivinha. */
export const FORMAT_VERSION = '1.1';

/** Nível fixo e DECLARADO (§6.6): nível variável quebraria o determinismo. */
export const NIVEL_ZSTD = 19;

/**
 * Subárvores que pertencem ao USUÁRIO. Nenhum pacote as escreve, e nenhum build
 * as empacota — a regra é do FORMATO, não de um dos lados, e por isso mora aqui.
 *
 * Vale nos dois pontos de propósito, e não é redundância: o build exclui para
 * não produzir um pacote inválido, e o apply recusa porque `applies_to` vem de
 * dentro do pacote — um pacote hostil declara o que quiser. Se a checagem no
 * apply fosse a única, bastaria declarar `casos/` para escrever em cima do dado
 * sigiloso do cliente; se fosse só no build, um pacote de outra origem passaria.
 */
const USER_OWNED = [
  'casos/',                 // dado de cliente — sagrado, nem entra no índice
  'output/',                // o que o squad produziu
  'skills/_evals/results/', // evidência comportamental DAQUELA instalação (§6.5)
  '_legalsquad/_memory/',   // contexto da instituição
  'acervo/',                // curadoria do usuário — exceto a subárvore gerenciada
];

/** A única subárvore gerenciada dentro de uma área user-owned. */
const EXCECOES_GERENCIADAS = ['acervo/_packs/'];

/**
 * Camada local: o que o usuário (ou o Arquiteto, com o "sim" dele) adaptou
 * sobre o que o pacote entregou.
 *
 * É sufixo, não prefixo, porque a posse aqui não é do DIRETÓRIO e sim do
 * ARQUIVO: `skills/x/SKILL.md` continua sendo do pacote e pode ser atualizado
 * à vontade; `skills/x/SKILL.local.md` é do usuário e nenhum pacote o toca.
 * Sem isso, enriquecer uma skill seria trabalho que o próximo `sync` apagaria
 * em silêncio — some o conteúdo e não sobra erro.
 */
const SUFIXO_LOCAL = '.local.md';

/** Arquivos que nenhum pacote toca, em qualquer lugar da árvore. */
export const ARQUIVOS_PROIBIDOS = new Set(['.env']);

/**
 * O caminho pertence ao usuário?
 *
 * `skills/_evals/results/` é o caso que mais engana: o pacote leva o CONTRATO e
 * os CASOS de eval (`skills/_evals/catalog-v5.json`, os cases), mas nunca a
 * PROVA. Empacotar `results/` mandaria a evidência de uma instalação para dentro
 * de outra, onde ela não significa nada.
 */
export function ehUserOwned(caminho) {
  // A camada local vale em QUALQUER subárvore, e é checada antes das exceções
  // gerenciadas: um pacote hostil não contorna a posse declarando outra raiz.
  if (caminho.endsWith(SUFIXO_LOCAL)) return true;
  if (EXCECOES_GERENCIADAS.some((prefixo) => caminho.startsWith(prefixo))) return false;
  return USER_OWNED.some((prefixo) => caminho.startsWith(prefixo));
}

/** Ordena por byte-order — nunca `localeCompare`, que depende de locale (§6.6). */
function porBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Identidade do registro, usada para ordenar. Cobre os dois `payload_kind`. */
function identidade(registro) {
  return registro.path ?? registro.urn ?? registro.id;
}

/**
 * JSON canônico: chaves ordenadas em toda a profundidade, sem espaço.
 * `JSON.stringify` preserva ordem de inserção — dois caminhos de código que
 * montam o mesmo registro em ordem diferente sairiam com bytes diferentes.
 */
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const pares = Object.keys(valor)
      .filter((chave) => valor[chave] !== undefined)
      .sort(porBytes)
      .map((chave) => `${JSON.stringify(chave)}:${canonico(valor[chave])}`);
    return `{${pares.join(',')}}`;
  }
  return JSON.stringify(valor);
}

/**
 * Codifica registros em `.jsonl.zst` de forma determinística.
 * Mesmo conjunto de registros → mesmos bytes, em qualquer máquina.
 */
export function encodeEntity(registros) {
  const vistos = new Set();
  for (const registro of registros) {
    const chave = identidade(registro);
    if (chave === undefined) {
      throw new Error('pack-format: registro sem identidade (path/urn/id) — não é ordenável');
    }
    // Fail-closed no BUILD: o cliente recusa o pacote inteiro se um `path` se
    // repetir (§6.5). Produzir um pacote assim seria gerar, com esforço, algo
    // que o próprio motor rejeita.
    if (vistos.has(chave)) {
      throw new Error(`pack-format: identidade repetida na entidade — ${chave}`);
    }
    vistos.add(chave);
  }

  const linhas = [...registros]
    .sort((a, b) => porBytes(identidade(a), identidade(b)))
    .map(canonico);

  return zstdCompressSync(Buffer.from(`${linhas.join('\n')}\n`, 'utf8'), {
    params: { [constants.ZSTD_c_compressionLevel]: NIVEL_ZSTD },
  });
}

/** Lê de volta os registros de uma entidade. */
export function decodeEntity(buffer) {
  return zstdDecompressSync(buffer)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((linha) => JSON.parse(linha));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Entidades na ordem normativa: byte-order do nome de arquivo (§6.6). */
function emOrdem(entidades) {
  return [...entidades].sort((a, b) => porBytes(a.file, b.file));
}

/**
 * `content_hash` = sha256 da concatenação dos sha256 das entidades, na ordem
 * byte-order dos nomes de arquivo (§6.6). É o que a assinatura cobre — e é por
 * isso que adulterar qualquer byte de qualquer entidade invalida o pacote.
 */
export function calcularContentHash(entidades) {
  const concatenado = emOrdem(entidades).map((e) => e.sha256 ?? sha256(e.buffer)).join('');
  return `sha256:${sha256(Buffer.from(concatenado, 'utf8'))}`;
}

/**
 * Fecha o manifesto: preenche `entities`, calcula `content_hash` e assina.
 * `entidades` = `[{ file, role, buffer }]`. `extras.created_at` é injetável de
 * propósito — timestamp nunca entra no payload (§6.6), e um relógio dentro do
 * build tornaria o manifesto irreprodutível para quem quisesse conferir.
 */
export function selarPacote(base, entidades, chavePrivada, extras = {}) {
  const ordenadas = emOrdem(entidades).map((e) => ({
    file: e.file,
    role: e.role,
    sha256: sha256(e.buffer),
    bytes: e.buffer.length,
  }));

  const manifesto = {
    ...base,
    format_version: FORMAT_VERSION,
    created_at: extras.created_at ?? null,
    compression: { algo: 'zstd', level: NIVEL_ZSTD },
    entities: ordenadas,
    content_hash: calcularContentHash(ordenadas),
  };

  const assinatura = assinarEd25519(null, Buffer.from(manifesto.content_hash, 'utf8'), chavePrivada);
  return {
    ...manifesto,
    signature: `ed25519:${assinatura.toString('base64')}`,
    signing_kid: extras.signing_kid ?? null,
  };
}

/**
 * Verificação FAIL-CLOSED (§6.7). Devolve `{ ok, problemas[] }` — nunca lança por
 * pacote inválido, porque o sync precisa seguir com os demais e reportar este.
 * Recusar em silêncio seria indistinguível de não haver pacote.
 */
export function verificarPacote(manifesto, entidades, chavePublica) {
  const problemas = [];
  const recusar = (motivo) => problemas.push(motivo);

  if (!manifesto || typeof manifesto !== 'object') {
    return { ok: false, problemas: ['manifesto ausente ou ilegível'] };
  }
  if (manifesto.format_version !== FORMAT_VERSION) {
    recusar(`format_version desconhecida (${manifesto.format_version}) — recuse, não adivinhe`);
  }
  if (!['tree', 'records'].includes(manifesto.payload_kind)) {
    recusar(`payload_kind ausente ou inválido (${manifesto.payload_kind}) — sem ele não há aplicador`);
  }

  const declaradas = Array.isArray(manifesto.entities) ? manifesto.entities : [];
  const catalogos = declaradas.filter((e) => e.role === 'catalog');
  if (catalogos.length === 0) {
    recusar('pacote sem catálogo (role: "catalog") — sem ele a área é invisível para a busca');
  } else if (catalogos.length > 1) {
    recusar(`pacote com ${catalogos.length} catálogos — o formato admite exatamente um`);
  }

  const porArquivo = new Map(entidades.map((e) => [e.file, e]));
  for (const declarada of declaradas) {
    const presente = porArquivo.get(declarada.file);
    if (!presente) {
      recusar(`entidade declarada no manifesto e ausente do pacote — ${declarada.file}`);
      continue;
    }
    const real = sha256(presente.buffer);
    if (real !== declarada.sha256) {
      recusar(`sha256 não confere — ${declarada.file}`);
    } else if (presente.buffer.length !== declarada.bytes) {
      recusar(`tamanho não confere — ${declarada.file}`);
    }
  }
  for (const entidade of entidades) {
    if (!declaradas.some((d) => d.file === entidade.file)) {
      recusar(`entidade presente no pacote e não declarada no manifesto — ${entidade.file}`);
    }
  }

  if (calcularContentHash(declaradas) !== manifesto.content_hash) {
    recusar('content_hash não confere com as entidades declaradas');
  }

  const assinatura = String(manifesto.signature || '');
  if (!assinatura.startsWith('ed25519:')) {
    recusar('assinatura ausente ou em algoritmo desconhecido');
  } else {
    const bytes = Buffer.from(assinatura.slice('ed25519:'.length), 'base64');
    // Chave malformada faz `verify` LANÇAR em vez de devolver false. Sem este
    // catch, um pacote com chave torta derrubaria o sync inteiro em vez de ser
    // recusado como um só — e o `verificarPacote` promete nunca lançar.
    let confere;
    try {
      confere = verificarEd25519(
        null,
        Buffer.from(String(manifesto.content_hash), 'utf8'),
        chavePublica,
        bytes
      );
    } catch {
      confere = false;
    }
    if (!confere) recusar('assinatura Ed25519 inválida para o content_hash declarado');
  }

  return { ok: problemas.length === 0, problemas };
}
