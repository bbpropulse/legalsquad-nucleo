// Tribunais e a jurisdição do escritório: o que liga os pacotes de acervo regionais (0.9.104).
//
// Decisão do dono (16/10/2026): os julgados e verbetes dos tribunais regionais entram como um pacote
// por tribunal, `acervo.regional-<sigla>` (`acervo.regional-tjpe`, `acervo.regional-trf5`,
// `acervo.regional-trt12`, `acervo.regional-tnu`). Um projeto liga só os da sua jurisdição, não os
// setenta: a escolha vive em `_legalsquad/config/acervo.json` (`"tribunais": ["tjpe", "trf5"]` ou
// `"tribunais": "todos"`), e projeto sem a chave não liga regional nenhum.
//
// O mapa UF → tribunal é geografia da organização judiciária, não matéria: fica no motor, como o
// calendário forense. A busca do acervo usa `instanciaDoTribunal` para nunca pôr um regional à frente
// de um superior com a mesma relevância, e o cartório usa `chaveDoJulgado` para não aceitar como
// verificada a citação de um TJ pela cópia de outro tribunal com número parecido.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/squad-state.mjs` e
// `templates/scripts/squad-state.mjs` (`npm run sync:blocos`), onde o cartório o usa.

// >>> tribunais:begin
/** As UFs, na ordem do código TR da numeração única do CNJ na Justiça Estadual (8.01 AC … 8.27 TO). */
const TRIBUNAIS_UFS_POR_TR_ESTADUAL = ['ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'se', 'sp', 'to'];
const TRIBUNAIS_SUPERIORES = new Set(['stf', 'stj', 'tst', 'tse', 'stm']);

/** A sigla do TJ de uma UF (`df` → `tjdft`). */
function tribunalEstadualDaUf(uf) {
  return uf === 'df' ? 'tjdft' : `tj${uf}`;
}

/**
 * A sigla normalizada de um tribunal, ou null: "TJPE", "TJ-PE", "tj/pe" → `tjpe`; "TRF-5", "TRF 5ª
 * Região" → `trf5`; "TRT da 12ª Região" → `trt12`; "STJ-SUM" → `stj`; "TJ-DF" → `tjdft`. Só a
 * primeira sigla do texto conta.
 */
function siglaDoTribunal(texto) {
  const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const m = /(?:^|[^a-z0-9])(stf|stj|tst|tse|stm|tnu|trf|trt|tj)(?:[\s\-/.]*(?:da\s+|do\s+)?)(\d{1,2}|dft|[a-z]{2})?(?![a-z])/.exec(t);
  if (!m) return null;
  const base = m[1];
  const resto = m[2] || '';
  if (TRIBUNAIS_SUPERIORES.has(base) || base === 'tnu') return base;
  if (base === 'tj') {
    if (resto === 'dft' || resto === 'df') return 'tjdft';
    return TRIBUNAIS_UFS_POR_TR_ESTADUAL.includes(resto) ? `tj${resto}` : null;
  }
  const n = Number.parseInt(resto, 10);
  if (base === 'trf') return n >= 1 && n <= 6 ? `trf${n}` : null;
  return n >= 1 && n <= 24 ? `trt${n}` : null;
}

/**
 * O tribunal pela numeração única do CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO), ou null: J 8 é a Justiça
 * Estadual (TR pela UF), 4 a Federal (TR é a região), 5 a do Trabalho (TR 00 é o TST, 01 a 24 os
 * TRTs), 3 o STJ e 1 o STF.
 */
function tribunalDoNumeroCnj(texto) {
  const m = /(\d{7})-?(\d{2})\.?(\d{4})\.?(\d)\.?(\d{2})\.?(\d{4})/.exec(String(texto || ''));
  if (!m) return null;
  const j = Number(m[4]);
  const tr = Number(m[5]);
  if (j === 1) return 'stf';
  if (j === 3) return 'stj';
  if (j === 8) return tr >= 1 && tr <= 27 ? tribunalEstadualDaUf(TRIBUNAIS_UFS_POR_TR_ESTADUAL[tr - 1]) : null;
  if (j === 4) return tr >= 1 && tr <= 6 ? `trf${tr}` : null;
  if (j === 5) return tr === 0 ? 'tst' : tr <= 24 ? `trt${tr}` : null;
  return null;
}

/** Os 20 dígitos da numeração única do CNJ que o texto traz, ou null. */
function numeroCnjDe(texto) {
  const m = /(\d{7})-?(\d{2})\.?(\d{4})\.?(\d)\.?(\d{2})\.?(\d{4})/.exec(String(texto || ''));
  return m ? m.slice(1).join('') : null;
}

/**
 * A chave do julgado que uma citação ou uma cópia do acervo nomeia: o tribunal (pela sigla do texto,
 * pelo `tribunal` declarado ou pelo número CNJ) e o número CNJ, quando houver. O cartório compara
 * as duas pontas: tribunal diferente, ou número CNJ diferente, não é o mesmo julgado.
 */
function chaveDoJulgado({ texto = '', tribunal = '', processo = '' } = {}) {
  const cnj = numeroCnjDe(processo) || numeroCnjDe(texto);
  return {
    tribunal: siglaDoTribunal(tribunal) || siglaDoTribunal(texto) || tribunalDoNumeroCnj(processo) || tribunalDoNumeroCnj(texto),
    cnj,
  };
}

/**
 * Por que a cópia do acervo não é o julgado que a citação nomeia, ou null quando nada desmente.
 * Só compara o que os dois lados dizem: sem tribunal num deles, o tribunal não decide.
 */
function divergenciaDeJulgado(daCitacao, daCopia) {
  if (daCitacao.tribunal && daCopia.tribunal && daCitacao.tribunal !== daCopia.tribunal) {
    return `a citação é do ${daCitacao.tribunal.toUpperCase()} e a cópia do acervo lida é de julgado do ${daCopia.tribunal.toUpperCase()}`;
  }
  if (daCitacao.cnj && daCopia.cnj && daCitacao.cnj !== daCopia.cnj) {
    return `o número do processo citado (${daCitacao.cnj}) não é o da cópia do acervo lida (${daCopia.cnj})`;
  }
  return null;
}
// <<< tribunais:end

/** A região federal de cada UF (o TRF6, de MG, desde 2022). */
const TRIBUNAIS_TRF_DA_UF = {
  ac: 1, am: 1, ap: 1, ba: 1, df: 1, go: 1, ma: 1, mt: 1, pa: 1, pi: 1, ro: 1, rr: 1, to: 1,
  rj: 2, es: 2, sp: 3, ms: 3, rs: 4, sc: 4, pr: 4, pe: 5, al: 5, ce: 5, pb: 5, rn: 5, se: 5, mg: 6,
};
/** As regiões do trabalho de cada UF (SP tem duas: a 2ª, capital e litoral, e a 15ª, Campinas e interior). */
const TRIBUNAIS_TRT_DA_UF = {
  rj: [1], sp: [2, 15], mg: [3], rs: [4], ba: [5], pe: [6], ce: [7], pa: [8], ap: [8], pr: [9], df: [10], to: [10],
  am: [11], rr: [11], sc: [12], pb: [13], ro: [14], ac: [14], ma: [16], es: [17], go: [18], al: [19], se: [20],
  rn: [21], pi: [22], mt: [23], ms: [24],
};
const TRIBUNAIS_JUSTICAS = ['estadual', 'federal', 'trabalho'];
const TRIBUNAIS_PREFIXO_DO_PACK = 'acervo.regional-';

/** Todas as siglas regionais que o motor conhece: os 27 TJs, os 6 TRFs, os 24 TRTs e a TNU. */
function siglasRegionaisConhecidas() {
  const siglas = TRIBUNAIS_UFS_POR_TR_ESTADUAL.map(tribunalEstadualDaUf);
  for (let r = 1; r <= 6; r += 1) siglas.push(`trf${r}`);
  for (let r = 1; r <= 24; r += 1) siglas.push(`trt${r}`);
  siglas.push('tnu');
  return siglas;
}

/** `acervo.regional-tjpe` → `tjpe`; outro pacote → null. */
function siglaDoPackRegional(packId) {
  const id = String(packId || '');
  return id.startsWith(TRIBUNAIS_PREFIXO_DO_PACK) ? id.slice(TRIBUNAIS_PREFIXO_DO_PACK.length) || null : null;
}

/** `superior` (STF, STJ, TST, TSE, STM), `regional` (TJ, TRF, TRT, TNU) ou null (não se sabe). */
function instanciaDoTribunal(sigla) {
  if (!sigla) return null;
  if (TRIBUNAIS_SUPERIORES.has(sigla)) return 'superior';
  return /^(?:tj[a-z]{2,3}|trf\d|trt\d{1,2}|tnu)$/.test(sigla) ? 'regional' : null;
}

export {
  TRIBUNAIS_JUSTICAS, TRIBUNAIS_PREFIXO_DO_PACK, siglasRegionaisConhecidas, siglaDoTribunal, tribunalDoNumeroCnj,
  numeroCnjDe, siglaDoPackRegional, instanciaDoTribunal, chaveDoJulgado, divergenciaDeJulgado, tribunalEstadualDaUf,
};

/** UF em duas letras minúsculas, ou null. */
function ufNormalizada(uf) {
  const u = String(uf || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return TRIBUNAIS_UFS_POR_TR_ESTADUAL.includes(u) ? u : null;
}

/** "trabalhista", "Justiça do Trabalho", "TRABALHO" → `trabalho`; "Justiça Federal" → `federal`. */
function justicaNormalizada(texto) {
  const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/trabalh/.test(t)) return 'trabalho';
  if (/federa/.test(t)) return 'federal';
  if (/estadua|comum/.test(t)) return 'estadual';
  return null;
}

/**
 * Os tribunais regionais da jurisdição do escritório: para cada UF, o TJ (estadual), o TRF da região
 * e a TNU (federal: a TNU uniformiza os juizados federais de todo o país) e o TRT (trabalho; SP leva
 * o 2º e o 15º). Devolve `{ tribunais, invalidas }`, os inválidos com o motivo.
 */
export function tribunaisDaJurisdicao({ ufs = [], justicas = [] } = {}) {
  const invalidas = [];
  const listaUfs = [];
  for (const bruto of ufs) {
    const uf = ufNormalizada(bruto);
    if (uf) listaUfs.push(uf);
    else invalidas.push(`UF desconhecida: ${bruto}`);
  }
  const listaJusticas = [];
  for (const bruto of justicas) {
    const j = justicaNormalizada(bruto);
    if (j) listaJusticas.push(j);
    else invalidas.push(`justiça desconhecida: ${bruto} (use estadual, federal ou trabalho)`);
  }
  const saida = new Set();
  for (const uf of listaUfs) {
    for (const j of listaJusticas.length ? listaJusticas : TRIBUNAIS_JUSTICAS) {
      if (j === 'estadual') saida.add(tribunalEstadualDaUf(uf));
      if (j === 'federal') { saida.add(`trf${TRIBUNAIS_TRF_DA_UF[uf]}`); saida.add('tnu'); }
      if (j === 'trabalho') for (const r of TRIBUNAIS_TRT_DA_UF[uf]) saida.add(`trt${r}`);
    }
  }
  return { tribunais: [...saida], invalidas };
}

/**
 * O pacote regional entra no projeto? Só com a escolha: `todos` liga todos, a lista liga os dela e
 * a ausência (projeto de antes de 0.9.104, ou que ainda não respondeu) não liga nenhum.
 */
export function tribunalLigavel(packId, tribunais) {
  const sigla = siglaDoPackRegional(packId);
  if (!sigla) return true;
  if (tribunais === 'todos') return true;
  return Array.isArray(tribunais) && tribunais.includes(sigla);
}

/** A escolha como o `status` e o `diagnostico` a descrevem. */
export function descreverTribunais(tribunais) {
  if (tribunais === 'todos') return 'todos os tribunais regionais';
  if (Array.isArray(tribunais) && tribunais.length) return tribunais.map((t) => t.toUpperCase()).join(', ');
  return 'nenhum tribunal regional';
}
