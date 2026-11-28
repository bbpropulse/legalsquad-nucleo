// Leitor de citações do servidor de referência, como o motor o usa (fase 2 do plano do servidor de
// referência). O código mora em `src/ref-leitor/`, copiado byte a byte do servidor por
// `scripts/ref-leitor-copiar.mjs` (origem e hashes em `src/ref-leitor/ORIGEM.json`, conferidos por
// `tests/ref-leitor-origem.test.js`). É o MESMO leitor que o servidor usa no `POST /v1/ref/conferir`
// e na montagem do índice: as duas pontas precisam levar "art. 157, § 2º, II, do CP" à mesma chave
// da tabela `apelido`, ou a resolução local diria "não encontrada" para o que o servidor acha.
// Mudou lá, copia de novo pelo script; nunca edite os arquivos de `src/ref-leitor/` à mão.
// Módulo puro: nada de disco, nada de rede.
export * from './ref-leitor/normalizar.js';
export * from './ref-leitor/ids.js';
export * from './ref-leitor/citacao.js';
export { LIMITE_LOTE, conferirLote, formaDeTrecho, trechoConfere } from './ref-leitor/conferir.js';
export { ANEL_ARTIGOS, FORMATO_ARTIGO, cargaAssinada, verificarArtigoAssinado } from './ref-leitor/artigo-assinado.js';
