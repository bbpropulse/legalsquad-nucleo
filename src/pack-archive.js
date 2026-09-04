// Formato de transporte de um pacote inteiro (manifesto + todas as
// entidades) num Buffer só — SPEC §7.1 promete UMA url por `catalog`/
// `content`, e `pack-io.js` só sabe ler de disco (um arquivo por entidade).
// Usado nas duas pontas: `tools/publish-pack.mjs` (motor→servidor) e o
// download do `sync` (servidor→motor).
//
// Formato: [4 bytes uint32 BE = tamanho do cabeçalho][cabeçalho JSON =
// {manifest, files:[{file,role,length}]}][bytes das entidades, concatenados
// na mesma ordem do cabeçalho]. Sem compressão própria — as entidades já
// chegam comprimidas (`.jsonl.zst`); comprimir de novo não ganharia nada.
const TAMANHO_CABECALHO = 4;

export function empacotarParaTransporte(manifesto, entidades) {
  const files = entidades.map((e) => ({ file: e.file, role: e.role, length: e.buffer.length }));
  const cabecalho = Buffer.from(JSON.stringify({ manifest: manifesto, files }), 'utf8');
  const tamanho = Buffer.alloc(TAMANHO_CABECALHO);
  tamanho.writeUInt32BE(cabecalho.length, 0);
  return Buffer.concat([tamanho, cabecalho, ...entidades.map((e) => e.buffer)]);
}

/**
 * Desfaz o transporte. Fail-closed: buffer truncado, cabeçalho ilegível ou
 * bytes sobrando (lixo depois da última entidade declarada) recusam com
 * mensagem clara — nunca lança exceção genérica nem devolve dado parcial.
 */
export function desempacotarDeTransporte(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < TAMANHO_CABECALHO) {
    throw new Error('pack-archive: buffer curto demais pra ter um cabeçalho válido');
  }

  const tamanhoCabecalho = buffer.readUInt32BE(0);
  if (buffer.length < TAMANHO_CABECALHO + tamanhoCabecalho) {
    throw new Error('pack-archive: buffer truncado — cabeçalho declara mais bytes do que o buffer tem');
  }

  let cabecalho;
  try {
    cabecalho = JSON.parse(buffer.subarray(TAMANHO_CABECALHO, TAMANHO_CABECALHO + tamanhoCabecalho).toString('utf8'));
  } catch (erro) {
    throw new Error(`pack-archive: cabeçalho ilegível — ${erro.message}`, { cause: erro });
  }
  if (!cabecalho.manifest || !Array.isArray(cabecalho.files)) {
    throw new Error('pack-archive: cabeçalho sem manifest ou files');
  }

  let offset = TAMANHO_CABECALHO + tamanhoCabecalho;
  const entidades = cabecalho.files.map(({ file, role, length }) => {
    if (offset + length > buffer.length) {
      throw new Error(`pack-archive: buffer truncado — entidade "${file}" declara ${length} bytes além do disponível`);
    }
    const entidade = { file, role, buffer: buffer.subarray(offset, offset + length) };
    offset += length;
    return entidade;
  });

  if (offset !== buffer.length) {
    throw new Error('pack-archive: bytes sobrando depois da última entidade declarada — buffer adulterado');
  }

  return { manifesto: cabecalho.manifest, entidades };
}
