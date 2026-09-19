// Subconjunto YAML do motor: parser fail-closed + emissor determinístico.
//
// O parser nasceu em tools/compilar-workflow.mjs (compilador pipeline → Workflow)
// e mudou para cá quando o compilador de squad (src/squad-compile.js) precisou
// ler o design.yaml do Arquiteto na instalação do aluno: `tools/` não é
// distribuído (package.json `files`), `src/` é. Um parser só, dois leitores.
//
// Deliberadamente NÃO é um parser YAML geral (zero dependência nova, mesma
// filosofia de src/frontmatter.js): mapas, listas de escalares, listas de
// mapas, escalares dobrados (`>`/`|`) e listas inline `[a, b]`. Qualquer coisa
// fora disso (âncoras, multi-doc, tabs) é erro nomeando a linha: parser
// fail-closed para compiladores fail-closed.
//
// O emissor escreve o MESMO subconjunto, com indentação fixa de dois espaços e
// item de lista recuado sob a chave, que é a forma que `src/squad-check.js`
// lê no pipeline.yaml (item de step com 2 espaços, campos com 4, artifacts
// com 6, artefato com 8). Mesma entrada, mesmos bytes: nada de data ou
// aleatório aqui dentro.

export class ErroDeYaml extends Error {}

function falha(mensagem) {
  throw new ErroDeYaml(mensagem);
}

function tirarComentario(valor) {
  const texto = String(valor);
  let aspas = null;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'") {
      aspas = c;
      continue;
    }
    // `#` só abre comentário precedido de espaço (ou no início) — `tag#1` é valor.
    if (c === '#' && (i === 0 || /\s/.test(texto[i - 1]))) return texto.slice(0, i).trim();
  }
  return texto.trim();
}

function tirarAspas(valor) {
  const texto = String(valor).trim();
  if (texto.length >= 2) {
    const a = texto[0];
    const z = texto[texto.length - 1];
    if ((a === '"' && z === '"') || (a === "'" && z === "'")) return texto.slice(1, -1);
  }
  return texto;
}

function listaInline(valor, rotulo, linha) {
  const dentro = valor.trim().slice(1, -1);
  if (!dentro.trim()) return [];
  const itens = [];
  let atual = '';
  let aspas = null;
  for (const c of dentro) {
    if ((c === '"' || c === "'") && (!aspas || aspas === c)) {
      aspas = aspas ? null : c;
      atual += c;
      continue;
    }
    if (c === ',' && !aspas) {
      if (atual.trim()) itens.push(tirarAspas(atual));
      atual = '';
      continue;
    }
    atual += c;
  }
  if (aspas) falha(`${rotulo}:${linha}: lista inline com aspas desequilibradas`);
  if (atual.trim()) itens.push(tirarAspas(atual));
  return itens;
}

function escalarDe(resto, ctx, linha) {
  const texto = resto.trim();
  if (texto.startsWith('[') && texto.endsWith(']')) return listaInline(texto, ctx.rotulo, linha);
  return tirarAspas(texto);
}

/** Lê um escalar dobrado (`>`) ou literal (`|`) a partir das linhas cruas. */
function lerDobrado(ctx, indiceToken, recuoChave, marcador) {
  const t = ctx.tokens[indiceToken];
  const corpo = [];
  let ultimaLinha = t.linha;
  for (let n = t.linha; n < ctx.brutas.length; n++) {
    const crua = ctx.brutas[n]; // brutas é 0-based; token.linha é 1-based → n é a linha seguinte
    if (!crua.trim()) {
      corpo.push('');
      continue;
    }
    const recuo = crua.match(/^ */)[0].length;
    if (recuo <= recuoChave) break;
    corpo.push(crua.slice(Math.min(crua.length, recuoChave + 2)));
    ultimaLinha = n + 1;
  }
  // remove sobras em branco no fim (linhas em branco após o bloco)
  while (corpo.length && !corpo[corpo.length - 1].trim()) corpo.pop();
  const valor = marcador.startsWith('|')
    ? corpo.join('\n').trimEnd()
    : corpo.map((l) => l.trim()).filter(Boolean).join(' ').trim();
  let proximo = indiceToken + 1;
  while (proximo < ctx.tokens.length && ctx.tokens[proximo].linha <= ultimaLinha) proximo++;
  return { valor, proximo };
}

const RE_PAR = /^([A-Za-z0-9_.-]+):(.*)$/;

function parseMapa(ctx, i, recuo) {
  const mapa = {};
  while (i < ctx.tokens.length) {
    const t = ctx.tokens[i];
    if (t.recuo < recuo) break;
    if (t.recuo > recuo) falha(`${ctx.rotulo}:${t.linha}: indentação inesperada («${t.corpo}»)`);
    if (t.corpo === '-' || t.corpo.startsWith('- ')) break; // lista do chamador acabou de fechar
    const par = t.corpo.match(RE_PAR);
    if (!par) falha(`${ctx.rotulo}:${t.linha}: linha fora do subconjunto YAML suportado («${t.corpo}»)`);
    const chave = par[1];
    if (chave in mapa) falha(`${ctx.rotulo}:${t.linha}: chave duplicada «${chave}»`);
    const cru = par[2].trim();
    if (/^[>|][+-]?$/.test(cru)) {
      const r = lerDobrado(ctx, i, t.recuo, cru);
      mapa[chave] = r.valor;
      i = r.proximo;
      continue;
    }
    const resto = tirarComentario(cru);
    if (resto === '') {
      const prox = ctx.tokens[i + 1];
      if (prox && prox.recuo > recuo) {
        const r = parseBloco(ctx, i + 1, prox.recuo);
        mapa[chave] = r.valor;
        i = r.proximo;
        continue;
      }
      mapa[chave] = null;
      i += 1;
      continue;
    }
    mapa[chave] = escalarDe(resto, ctx, t.linha);
    i += 1;
  }
  return { valor: mapa, proximo: i };
}

function parseLista(ctx, i, recuo) {
  const itens = [];
  while (i < ctx.tokens.length) {
    const t = ctx.tokens[i];
    if (t.recuo < recuo) break;
    if (t.recuo > recuo) falha(`${ctx.rotulo}:${t.linha}: indentação inesperada em lista («${t.corpo}»)`);
    if (!(t.corpo === '-' || t.corpo.startsWith('- '))) break;
    const cru = t.corpo === '-' ? '' : t.corpo.slice(2);
    const resto = tirarComentario(cru);
    if (resto === '') {
      const prox = ctx.tokens[i + 1];
      if (prox && prox.recuo > recuo) {
        const r = parseBloco(ctx, i + 1, prox.recuo);
        itens.push(r.valor);
        i = r.proximo;
        continue;
      }
      itens.push(null);
      i += 1;
      continue;
    }
    if (RE_PAR.test(resto)) {
      // Item-mapa (`- id: step-01`): o primeiro campo começa exatamente na
      // coluna recuo+2 (o `- ` tem 2 colunas), então reapresentamos o token
      // como se fosse essa linha e deixamos o parseMapa consumir o item
      // inteiro. A mutação é segura: o passe é único, ninguém revisita.
      ctx.tokens[i] = { recuo: recuo + 2, corpo: cru.trim(), linha: t.linha };
      const r = parseMapa(ctx, i, recuo + 2);
      itens.push(r.valor);
      i = r.proximo;
      continue;
    }
    itens.push(escalarDe(resto, ctx, t.linha));
    i += 1;
  }
  return { valor: itens, proximo: i };
}

function parseBloco(ctx, i, recuo) {
  const t = ctx.tokens[i];
  if (t.corpo === '-' || t.corpo.startsWith('- ')) return parseLista(ctx, i, recuo);
  return parseMapa(ctx, i, recuo);
}

function parseSubconjunto(texto, rotulo) {
  const brutas = String(texto).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const tokens = [];
  brutas.forEach((crua, indice) => {
    if (!crua.trim() || crua.trim().startsWith('#')) return;
    const recuo = crua.match(/^[ \t]*/)[0];
    if (recuo.includes('\t')) {
      falha(`${rotulo}:${indice + 1}: tabulação na indentação — o subconjunto YAML do compilador exige espaços`);
    }
    tokens.push({ recuo: recuo.length, corpo: crua.slice(recuo.length).trimEnd(), linha: indice + 1 });
  });
  if (!tokens.length) return {};
  const ctx = { tokens, brutas, rotulo };
  const r = parseBloco(ctx, 0, tokens[0].recuo);
  if (r.proximo < tokens.length) {
    falha(`${rotulo}:${tokens[r.proximo].linha}: conteúdo fora do documento raiz («${tokens[r.proximo].corpo}»)`);
  }
  return r.valor;
}

/**
 * Lê o subconjunto. `rotulo` nomeia o arquivo nas mensagens de erro. Quem
 * precisa converter o erro na própria classe (o compilador de workflow lança
 * `ErroDeCompilacao`) passa `falha` em `opcoes`, e recebe a mensagem.
 */
export function parseYamlSubconjunto(texto, rotulo, opcoes = {}) {
  try {
    return parseSubconjunto(texto, rotulo);
  } catch (erro) {
    if (erro instanceof ErroDeYaml && typeof opcoes.falha === 'function') return opcoes.falha(erro.message);
    throw erro;
  }
}

// ---------------------------------------------------------------------------
// Emissor.
// ---------------------------------------------------------------------------

const ESCALAR_SEM_ASPAS = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const PARECE_OUTRO_TIPO = /^(true|false|yes|no|null|~|on|off)$|^[-+]?(\d+([.,]\d+)?|\.\d+)$/i;

/**
 * Um escalar de uma linha. Strings vão sem aspas só quando são identificadores
 * simples que o parser não confundiria com número ou booleano; todo o resto
 * vai entre aspas duplas, com aspas internas trocadas por simples (o parser
 * não desfaz escape, então não se emite escape).
 */
export function emitirEscalar(valor) {
  if (valor === null || valor === undefined) return '""';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : '""';
  const texto = String(valor).replace(/\r?\n/g, ' ').replace(/"/g, "'").trim();
  if (texto && ESCALAR_SEM_ASPAS.test(texto) && !PARECE_OUTRO_TIPO.test(texto)) return texto;
  return `"${texto}"`;
}

/**
 * Emite um valor (mapa, lista ou escalar) como YAML do subconjunto, a partir
 * do recuo dado. Mapa vazio e lista vazia saem inline (`{}`/`[]`); `null` em
 * mapa sai como `chave:` sem valor. Strings com quebra de linha viram bloco
 * literal `|`.
 */
export function emitirYaml(valor, recuo = 0) {
  const pad = ' '.repeat(recuo);
  const linhas = [];
  if (Array.isArray(valor)) {
    if (!valor.length) return `${pad}[]`;
    for (const item of valor) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const chaves = Object.keys(item);
        if (!chaves.length) { linhas.push(`${pad}- {}`); continue; }
        const interno = emitirYaml(item, recuo + 2).split('\n');
        interno[0] = `${pad}- ${interno[0].slice(recuo + 2)}`;
        linhas.push(...interno);
      } else if (Array.isArray(item)) {
        linhas.push(`${pad}-`);
        linhas.push(emitirYaml(item, recuo + 2));
      } else {
        linhas.push(`${pad}- ${emitirEscalar(item)}`);
      }
    }
    return linhas.join('\n');
  }
  if (valor && typeof valor === 'object') {
    const chaves = Object.keys(valor);
    if (!chaves.length) return `${pad}{}`;
    for (const chave of chaves) {
      const v = valor[chave];
      if (v === undefined) continue;
      if (v === null) { linhas.push(`${pad}${chave}:`); continue; }
      if (Array.isArray(v)) {
        if (!v.length) { linhas.push(`${pad}${chave}: []`); continue; }
        linhas.push(`${pad}${chave}:`);
        linhas.push(emitirYaml(v, recuo + 2));
        continue;
      }
      if (typeof v === 'object') {
        if (!Object.keys(v).length) { linhas.push(`${pad}${chave}: {}`); continue; }
        linhas.push(`${pad}${chave}:`);
        linhas.push(emitirYaml(v, recuo + 2));
        continue;
      }
      if (typeof v === 'string' && v.includes('\n')) {
        linhas.push(`${pad}${chave}: |`);
        for (const l of v.replace(/\r\n/g, '\n').trimEnd().split('\n')) linhas.push(l.trim() ? `${pad}  ${l}` : '');
        continue;
      }
      linhas.push(`${pad}${chave}: ${emitirEscalar(v)}`);
    }
    return linhas.join('\n');
  }
  return `${pad}${emitirEscalar(valor)}`;
}
