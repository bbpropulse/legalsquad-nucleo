// SPDX-License-Identifier: UNLICENSED
// Os bancos dos reguladores do índice local num banco só (0.9.134).
//
// O índice tem uma camada por órgão regulador (103 em 17/11/2026: ANVISA, CVM, ANATEL...), cada uma num
// arquivo. A busca roda as mesmas quatro consultas em cada arquivo aberto; com 161 camadas, os 103
// reguladores eram dois terços dos bancos de cada busca. Aqui o código os junta, depois do sync, em
// `reg-unido.sqlite`, no mesmo formato enxuto: documentos, apelidos e vínculos copiados, os códigos do
// dicionário remapeados e o FTS reconstruído com o mesmo conteúdo que o servidor indexa (título, ementa
// gravada, apelidos pela exibição ou forma; o assunto). A ordem dos apelidos no texto do FTS não é a do
// servidor, o que não muda o bm25 (frequência e tamanho) nem as consultas de termo do motor.
// O banco unido só vale enquanto as versões das camadas de origem forem as do `estado.json`: a abertura
// confere a lista gravada em `meta.fontes` e, se não bater, abre os arquivos de cada regulador.
//
// Sem rede, sem modelo. A camada dos resultados vindos dele é `reg` (a de origem continua no id).

import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ARQUIVO_REGULADORES_UNIDOS = 'reg-unido.sqlite';
export const CAMADA_REGULADORES_UNIDOS = 'reg';
const COLUNAS_COM_CODIGO = ['tipo', 'subtipo', 'esfera', 'uf', 'orgao', 'vigencia', 'selo', 'motivo', 'url_base', 'area'];

/** As camadas de regulador do estado, no formato enxuto, com o arquivo presente: `[{ camada, versao, arquivo }]`. */
export function camadasDeRegulador(indiceDir, estado, formato) {
  return Object.entries((estado && estado.camadas) || {})
    .filter(([c, e]) => /^reg-/.test(c) && e && e.versao && !e.nao_publicada && e.formato === formato && e.arquivo)
    .map(([camada, e]) => ({ camada, versao: e.versao, arquivo: join(indiceDir, e.arquivo) }))
    .filter((x) => existsSync(x.arquivo))
    .sort((a, b) => a.camada.localeCompare(b.camada));
}

const assinaturaDasFontes = (fontes) => fontes.map((f) => `${f.camada}@${f.versao}`).join(';');

/** O banco unido serve para estas camadas? (as mesmas camadas, nas mesmas versões) */
export function unidoEmDia(DatabaseSync, arquivo, fontes) {
  if (!fontes.length || !existsSync(arquivo)) return false;
  let db;
  try {
    db = new DatabaseSync(arquivo, { readOnly: true });
    const r = db.prepare("SELECT valor FROM meta WHERE chave = 'fontes'").get();
    return Boolean(r && r.valor === assinaturaDasFontes(fontes));
  } catch { return false; } finally { try { db && db.close(); } catch { /* fechado */ } }
}

/**
 * Junta as camadas de regulador num banco só. Devolve `{ ok, arquivo, camadas, docs, ms }` ou
 * `{ ok: true, em_dia: true }` quando o banco unido já é destas versões. Grava num temporário e troca
 * no fim: um banco pela metade nunca fica no lugar do bom.
 */
export function unirReguladores(DatabaseSync, indiceDir, estado, formato, { log = () => {} } = {}) {
  const fontes = camadasDeRegulador(indiceDir, estado, formato);
  const destino = join(indiceDir, ARQUIVO_REGULADORES_UNIDOS);
  if (fontes.length < 2) return { ok: true, em_dia: true, camadas: fontes.length, motivo: 'menos de duas camadas de regulador' };
  if (unidoEmDia(DatabaseSync, destino, fontes)) return { ok: true, em_dia: true, camadas: fontes.length };
  const t0 = Date.now();
  // Começa com ponto: o `limparSobras` do sync apaga o que uma união interrompida deixar.
  const tmp = join(indiceDir, `.${ARQUIVO_REGULADORES_UNIDOS}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  let docs = 0;
  try {
    // O esquema é o da primeira camada (todas têm o mesmo formato): tabelas, FTS, índices e visões.
    const modelo = new DatabaseSync(fontes[0].arquivo, { readOnly: true });
    const esquema = modelo.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid").all();
    modelo.close();
    const sombra = /^(busca|busca_assunto)_(data|idx|docsize|config|content)$/;
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    for (const e of esquema) if (!sombra.test(e.name)) db.exec(e.sql);
    let offset = 0;
    for (const f of fontes) {
      db.prepare('ATTACH DATABASE ? AS src').run(f.arquivo);
      db.exec('BEGIN');
      db.exec('INSERT OR IGNORE INTO main.dic (valor) SELECT valor FROM src.dic');
      const mapa = (col) => `(SELECT m.cod FROM main.dic m JOIN src.dic s ON s.valor = m.valor WHERE s.cod = d.${col})`;
      const colunas = db.prepare('SELECT name FROM pragma_table_info(\'doc_\')').all().map((c) => c.name);
      const sel = colunas.map((c) => (c === 'rid' ? `d.rid + ${offset}` : COLUNAS_COM_CODIGO.includes(c) ? mapa(c) : `d.${c}`)).join(', ');
      db.exec(`INSERT INTO main.doc_ (${colunas.join(', ')}) SELECT ${sel} FROM src.doc_ d`);
      db.exec(`INSERT OR IGNORE INTO main.apelido_ (forma, rid, exibicao) SELECT forma, rid + ${offset}, exibicao FROM src.apelido_`);
      db.exec('INSERT OR IGNORE INTO main.vinculo SELECT * FROM src.vinculo');
      // O FTS com o mesmo conteúdo que o servidor indexa (src/indice-sqlite.js do servidor, `inserir`).
      db.exec(`INSERT INTO main.busca (rowid, titulo, ementa, apelidos)
        SELECT d.rid + ${offset}, coalesce(d.titulo, ''), coalesce(d.ementa, ''),
          coalesce((SELECT group_concat(coalesce(a.exibicao, a.forma), ' | ') FROM src.apelido_ a WHERE a.rid = d.rid), '')
        FROM src.doc_ d`);
      db.exec(`INSERT INTO main.busca_assunto (rowid, assunto) SELECT d.rid + ${offset}, d.assunto FROM src.doc_ d WHERE d.assunto IS NOT NULL AND d.assunto <> ''`);
      const n = db.prepare('SELECT count(*) AS n, coalesce(max(rid), 0) AS mx FROM src.doc_').get();
      docs += Number(n.n);
      offset += Number(n.mx);
      db.exec('COMMIT');
      db.exec('DETACH DATABASE src');
    }
    db.exec('BEGIN');
    db.exec('DELETE FROM main.meta');
    const ins = db.prepare('INSERT INTO main.meta (chave, valor) VALUES (?, ?)');
    ins.run('camada', CAMADA_REGULADORES_UNIDOS);
    ins.run('formato', formato);
    ins.run('fontes', assinaturaDasFontes(fontes));
    ins.run('criado_em', new Date().toISOString());
    ins.run('contagens', JSON.stringify({ doc: docs }));
    db.exec('COMMIT');
    db.exec("INSERT INTO busca(busca) VALUES('optimize')");
    db.exec("INSERT INTO busca_assunto(busca_assunto) VALUES('optimize')");
    db.close();
    renameSync(tmp, destino);
    const ms = Date.now() - t0;
    log(`índice: ${fontes.length} camadas de regulador num banco só (${docs} documentos, ${(statSync(destino).size / 1e6).toFixed(0)} MB, ${(ms / 1000).toFixed(1)} s)`);
    return { ok: true, arquivo: destino, camadas: fontes.length, docs, ms };
  } catch (e) {
    try { db.close(); } catch { /* fechado */ }
    rmSync(tmp, { force: true });
    return { ok: false, motivo: String(e && e.message ? e.message : e), camadas: fontes.length };
  }
}
