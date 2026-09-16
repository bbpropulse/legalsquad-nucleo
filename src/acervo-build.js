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

import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { encodeEntity, selarPacote } from './pack-format.js';
import { lerArvore } from './pack-tree.js';

const CATALOGO = 'catalog.jsonl.zst';
const ENTIDADE_CONTEUDO = 'julgados.jsonl.zst';

/** Subpasta de instalação — o que faz `tipoDe()` do indexador acertar o tipo. */
const TIPO = 'jurisprudencia';
// Uma área pode vir organizada por TIPO na raiz (`legislacao/`, `doutrina/`,
// `teses-modelos/`, `sumulas/`, `jurisprudencia/`): o tipo é preservado no
// caminho de instalação, e é ele que o indexador do projeto lê para classificar.
// Sem pasta de tipo (só tribunais, como o acervo publicado até 2026.09), tudo é
// jurisprudência, como sempre foi.
const TIPOS_NA_RAIZ = new Set(['jurisprudencia', 'legislacao', 'doutrina', 'teses-modelos', 'teses', 'sumulas']);

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
  const tipo = entidade.path.split('/')[3] || TIPO; // acervo/_packs/<pack>/<tipo>/…

  return {
    kind: tipo === TIPO ? 'julgado' : tipo,
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

/**
 * Teto do nome de arquivo dentro do pacote. Medido em 14/09/2026: o nome mais
 * longo do acervo publicado tinha 250 caracteres, e 8.641 passavam de 180. No
 * Windows o caminho completo é limitado a 260 (a chave `LongPathsEnabled` vem
 * desligada): `C:\Users\ana\.legalsquad\acervo\` + 250 já estoura no próprio
 * depósito, e um projeto em `Documentos\Escritório\Processos\<caso>\` estoura
 * milhares de links. Normalização de fronteira, como a do marcador de contrato
 * (SPEC §6.8): o corte é determinístico, preserva o hash final do nome (a
 * unicidade) e fica declarado no manifesto. Julgado não tem vínculo por SHA
 * que a renomeação quebre; o `id` do catálogo deriva do nome novo.
 */
export const MAX_BASENAME = 100;
const SUFIXO_HASH = /-[0-9a-f]{6,16}$/i;

export function nomeCurto(nome, max = MAX_BASENAME) {
  if (nome.length <= max) return nome;
  const ext = extname(nome);
  const base = nome.slice(0, nome.length - ext.length);
  const hash = SUFIXO_HASH.exec(base);
  // Sem hash no nome, o corte poderia colidir: um hash curto do nome original entra no lugar.
  const sufixo = hash ? hash[0] : `-${createHash('sha256').update(nome).digest('hex').slice(0, 8)}`;
  const corpo = hash ? base.slice(0, hash.index) : base;
  const espaco = max - ext.length - sufixo.length;
  let cortado = corpo.slice(0, Math.max(1, espaco));
  const ultimoHifen = cortado.lastIndexOf('-');
  if (ultimoHifen > espaco * 0.6) cortado = cortado.slice(0, ultimoHifen); // corta em fronteira de palavra
  return `${cortado.replace(/[-_.]+$/, '')}${sufixo}${ext}`;
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
    const prefixo = `acervo/_packs/${packId}/`;
    let renomeados = 0;
    const vistos = new Set();
    const arquivos = lidos.map((a) => {
      const relativo = a.path.slice(area.length + 1);
      const primeiro = relativo.split('/')[0];
      const comTipo = relativo.includes('/') && TIPOS_NA_RAIZ.has(primeiro) ? relativo : `${TIPO}/${relativo}`;
      const pasta = comTipo.slice(0, comTipo.lastIndexOf('/') + 1);
      const nome = nomeCurto(basename(relativo));
      if (nome !== basename(relativo)) renomeados++;
      const path = prefixo + pasta + nome;
      if (vistos.has(path)) throw new Error(`acervo-build: dois arquivos de ${area} ficam com o mesmo nome depois do corte: ${path}`);
      vistos.add(path);
      return { ...a, path };
    });

    const registros = arquivos.map((a) => registroDeJulgado(a, ENTIDADE_CONTEUDO));
    const julgados = registros.filter((r) => r.kind === 'julgado').length;
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
        counts: { files: arquivos.length, julgados },
        normalization: { max_basename: MAX_BASENAME, renamed: renomeados },
      },
      entidades,
      chavePrivada,
      { created_at: criadoEm, signing_kid: signingKid }
    );

    pacotes.push({ packId, manifesto, entidades });
  }

  return { pacotes, relatorio: pacotes.map((p) => ({ packId: p.packId, ...p.manifesto.counts })) };
}
