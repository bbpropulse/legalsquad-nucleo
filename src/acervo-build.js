// Empacotador de ACERVO — a metade que faltava do "um pipeline carrega skills
// e acervo" (SPEC §6).
//
// ── Por que `tree` e não `records` ────────────────────────────────────────
//
// A SPEC associa `acervo.*` a `payload_kind: records`: mandar um registro por
// julgado e DESCARTAR o corpo, deixando o texto na fonte oficial. Aquela
// decisão presumia que o acervo não caberia no cliente.
//
// Medido antes de escrever este módulo, sobre 55.871 julgados reais: o texto
// integral comprimido dá 56 MB no total, e por área fica entre 0,2 MB
// (direitos humanos) e 19,8 MB (eleitoral) — trabalhista inteiro em 3,0 MB.
// Cabe folgado em `tree`, o formato que o motor JÁ aplica.
//
// A diferença não é de bytes, é de produto: com `records` o advogado tem a
// ficha do julgado e precisa de rede para ler a ementa; com `tree` ele tem o
// inteiro teor no disco, e o `verificador-citacoes` confere sem a consulta sair
// da máquina — que é o princípio nº 1 deste projeto, não um detalhe de
// implementação. `records` continua fazendo sentido se um dia o acervo crescer
// além do que cabe baixar; construí-lo agora resolveria um problema que a
// medição diz não existir.
//
// ── Onde instala ──────────────────────────────────────────────────────────
//
// Em `acervo/_packs/<pack_id>/jurisprudencia/…`. `acervo/` é user-owned (a
// curadoria que o advogado juntou à mão) e a contenção recusaria escrita ali;
// `acervo/_packs/` é a única exceção gerenciada. O `jurisprudencia/` no meio
// não é enfeite: é o que faz o indexador classificar o tipo corretamente.

import { basename } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEntity, selarPacote } from './pack-format.js';
import { lerArvore } from './pack-tree.js';

const CATALOGO = 'catalog.jsonl.zst';
const ENTIDADE_CONTEUDO = 'julgados.jsonl.zst';

/** Subpasta de instalação — o que faz `tipoDe()` do indexador acertar o tipo. */
const TIPO = 'jurisprudencia';

/** Uma linha `campo: "valor"` do frontmatter. Sem YAML: são cinco campos. */
function campoDoFrontmatter(texto, campo) {
  const bloco = texto.match(/^---\n([\s\S]*?)\n---/);
  if (!bloco) return undefined;
  const achado = bloco[1].match(new RegExp(`^${campo}:\\s*(.+)$`, 'm'));
  return achado ? achado[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/**
 * Registro de DESCOBERTA de um julgado: o que a busca local precisa para achá-lo
 * sem abrir o arquivo. Nunca carrega o corpo — é isso que mantém o catálogo
 * fino o bastante para sincronizar tudo e baixar conteúdo só do que se usa.
 */
function registroDeJulgado(entidade, nomeDaEntidade) {
  const texto = entidade.text || '';
  const titulo = texto.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const id = basename(entidade.path).replace(/\.md$/i, '');

  return {
    kind: 'julgado',
    id,
    entity: nomeDaEntidade,
    path: entidade.path,
    sha256: entidade.sha256,
    bytes: entidade.bytes,
    description: (titulo || id).slice(0, 300),
    ...(campoDoFrontmatter(texto, 'tribunal') ? { tribunal: campoDoFrontmatter(texto, 'tribunal') } : {}),
    ...(campoDoFrontmatter(texto, 'processo') ? { processo: campoDoFrontmatter(texto, 'processo') } : {}),
    ...(campoDoFrontmatter(texto, 'data_julgamento')
      ? { data: campoDoFrontmatter(texto, 'data_julgamento') }
      : {}),
    ...(campoDoFrontmatter(texto, 'fonte_url') ? { fonte: campoDoFrontmatter(texto, 'fonte_url') } : {}),
  };
}

/** Áreas = subdiretórios de primeiro nível. Arquivo solto na raiz é ignorado. */
function areasDe(raizConteudo) {
  return readdirSync(raizConteudo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

/**
 * Empacota um diretório de jurisprudência organizado por área.
 *
 * GENÉRICO E CEGO, como o `build-area`: recebe o caminho por argumento e nunca
 * conhece repositório nenhum. Lê a origem e jamais escreve nela.
 */
export function construirAcervo({ raizConteudo, chavePrivada, versao, criadoEm, signingKid } = {}) {
  if (!raizConteudo) throw new Error('acervo-build: raizConteudo é obrigatório');
  if (!versao) throw new Error('acervo-build: versao é obrigatória');

  const pacotes = [];

  for (const area of areasDe(raizConteudo)) {
    const dir = join(raizConteudo, area);
    if (!statSync(dir).isDirectory()) continue;

    // Lê a área como uma subárvore só, e remapeia para o caminho de INSTALAÇÃO.
    const lidos = lerArvore(raizConteudo, [`${area}/`]).filter((a) => a.path.endsWith('.md'));
    if (!lidos.length) continue;

    const packId = `acervo.${area}`;
    const prefixo = `acervo/_packs/${packId}/${TIPO}/`;
    const arquivos = lidos.map((a) => ({ ...a, path: prefixo + a.path.slice(area.length + 1) }));

    const registros = arquivos.map((a) => registroDeJulgado(a, ENTIDADE_CONTEUDO));
    const entidades = [
      { file: CATALOGO, role: 'catalog', buffer: encodeEntity(registros) },
      { file: ENTIDADE_CONTEUDO, role: 'content', buffer: encodeEntity(arquivos) },
    ];

    const manifesto = selarPacote(
      {
        version: versao,
        pack_id: packId,
        // `tree` porque o cliente MATERIALIZA os julgados — ver o cabeçalho.
        payload_kind: 'tree',
        applies_to: [`acervo/_packs/${packId}/`],
        counts: { files: arquivos.length, julgados: registros.length },
      },
      entidades,
      chavePrivada,
      { created_at: criadoEm, signing_kid: signingKid }
    );

    pacotes.push({ packId, manifesto, entidades });
  }

  return { pacotes, relatorio: pacotes.map((p) => ({ packId: p.packId, ...p.manifesto.counts })) };
}
