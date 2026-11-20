// Resolução DETERMINÍSTICA do caminho de artefato de um run.
//
// Antes, isto eram ~35 linhas de prosa em `_legalsquad/core/runner.pipeline.md`
// mandando o LLM injetar o `run_id`, rodar `ls | grep -E '^v[0-9]+$' | sort -V |
// tail -1` e montar a pasta de versão na mão, a cada arquivo, em todo step.
// Manipular string e comparar número não é julgamento — é aritmética, e
// aritmética de cabeça erra em silêncio: o artefato vai para uma pasta que
// ninguém procura e o step seguinte falha por "input não encontrado", longe da
// causa. Mesmo argumento que já valeu para o loop de revisão (`review-loop.js`).
//
// Módulo PURO: recebe as entradas do diretório-grupo, não lê o disco. Quem lê é
// `scripts/squad-path.mjs`.
//
// SINCRONIA: o bloco entre os marcadores abaixo é copiado VERBATIM para
// `scripts/squad-path.mjs` e `templates/scripts/squad-path.mjs`. O script
// distribuído ao usuário é auto-contido por contrato — o projeto do usuário não
// tem `src/` —, então a cópia é inevitável; o que não pode é divergir em
// silêncio. `tests/squad-path.test.js` falha se as três cópias divergirem.

// >>> squad-path:begin
/** Modos de resolução. Cada um responde a uma pergunta diferente. */
const MODOS_CAMINHO = Object.freeze({
  ESCRITA: 'escrita', // "onde eu GRAVO agora?" → próxima versão
  LEITURA: 'leitura', // "onde está o que já foi gravado?" → versão vigente
  CHECKPOINT: 'checkpoint', // captura da resposta do usuário → nunca versionada
});

/** Pasta de versão: `v` seguido só de dígitos. `v2x` e `v` não são versão. */
const PADRAO_VERSAO = /^v(\d+)$/;

/** Só caminho sob `squads/<nome>/output/` é transformado. O resto passa reto. */
const RAIZ_OUTPUT = /^(squads\/[^/]+\/output)\/(.+)$/;

function sobOutput(caminho) {
  return RAIZ_OUTPUT.test(String(caminho || ''));
}

/**
 * Caminho sob `squads/<nome>/autos/`: é um caminho LÓGICO, o único que o
 * compilador escreve (no `inputFile` da fase zero e no contexto dos steps). Os
 * autos podem morar na pasta do caso (`squads/<nome>/caso.json`), e quem sabe
 * onde é o bloco `autos-path`, em tempo de run. Medido em 24/09/2026: o squad da
 * apelação criado com `--caso` tinha `inputFile: squads/<code>/autos/_index.yaml`,
 * o `squad-path` devolvia o caminho inalterado, e a validação de input da fase
 * zero deu VALIDATION:FAIL com o índice inteiro na pasta do caso.
 */
const RAIZ_AUTOS = /^(?:\.\/)?(squads\/[^/]+)\/autos(?:\/(.*))?$/;

/** `{ squad, resto }` quando o caminho é dos autos de um squad; senão `null`. */
function autosDoSquad(caminho) {
  const m = String(caminho || '').match(RAIZ_AUTOS);
  return m ? { squad: m[1], resto: m[2] || '' } : null;
}

/**
 * Pasta de versão vazia é RESERVA, não versão: a `escrita` cria a pasta (medido
 * em 24/09/2026, uma gravação por Bash falhou porque `vN/` não existia) e, com
 * isso, resolver de novo antes de gravar abriria `vN+1` sem nada ter sido
 * gravado em `vN`. Então a maior versão, se vazia, é reaproveitada: resolver duas
 * vezes no mesmo step dá o mesmo caminho, e os ramos de um fan-out resolvidos
 * antes do despacho caem todos na mesma versão, como o runner exige.
 */
function versaoDeEscrita(entradas, grupo, vazia) {
  const vigente = versaoVigente(entradas);
  return vigente && grupo && vazia(`${grupo}/${vigente}`) ? vigente : proximaVersao(entradas);
}

/**
 * Step 1 — injeta o `run_id` logo depois de `output/`.
 *
 * IDEMPOTENTE de propósito: o runner às vezes já tem em mãos o caminho
 * transformado, e injetar de novo produziria `output/<run>/<run>/arquivo` —
 * pasta que ninguém procura e onde o artefato some sem erro nenhum.
 */
function injetarRunId(caminho, runId) {
  const m = String(caminho || '').match(RAIZ_OUTPUT);
  if (!m) return caminho;
  const [, raiz, resto] = m;
  if (resto.split('/')[0] === runId) return caminho;
  return `${raiz}/${runId}/${resto}`;
}

/** Números das pastas de versão presentes no grupo, ignorando o resto. */
function numerosDeVersao(entradas) {
  return (Array.isArray(entradas) ? entradas : [])
    .map((entrada) => (typeof entrada === 'string' ? entrada.match(PADRAO_VERSAO) : null))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/**
 * A maior versão existente — a que o step ANTERIOR gravou.
 *
 * Compara por NÚMERO. Ordenação de texto poria `v9` acima de `v10`, e o
 * validador de input do step seguinte passaria a procurar numa versão velha
 * (ou a acusar ausência de um arquivo que existe).
 */
function versaoVigente(entradas) {
  const nums = numerosDeVersao(entradas);
  return nums.length ? `v${Math.max(...nums)}` : null;
}

/**
 * A versão onde gravar agora: sempre uma acima da MAIOR existente.
 *
 * Buraco na sequência (v1 e v3, sem v2) não é reaproveitado — reusar `v2` faria
 * o artefato novo parecer mais antigo que a `v3` que já está lá.
 */
function proximaVersao(entradas) {
  const nums = numerosDeVersao(entradas);
  return nums.length ? `v${Math.max(...nums) + 1}` : 'v1';
}

/** Diretório onde as pastas de versão vivem — é o que o chamador vai listar. */
function grupoDe(caminho, runId) {
  if (!sobOutput(caminho)) return null;
  const partes = injetarRunId(caminho, runId).split('/');
  partes.pop();
  return partes.join('/');
}

/**
 * Resolve o caminho final de um artefato do run.
 *
 * Fail-closed nas duas portas: modo desconhecido e `run_id` ausente LANÇAM, em
 * vez de adivinhar. Um `run_id` vazio faria execuções diferentes gravarem por
 * cima uma da outra — perda silenciosa, o pior modo de falha deste pipeline.
 *
 * `existe(caminho)` é o olho no disco que a leitura precisa: "onde está o que
 * já foi gravado?" só se responde olhando. Sem ele (testes puros), a leitura
 * cai na maior versão do grupo, como sempre fez.
 *
 * `vazia(pasta)` diz se uma pasta de versão existe sem nada dentro (a reserva de
 * `versaoDeEscrita`). `pastaDeAutos(squad)` devolve onde moram os autos de
 * `squads/<nome>` (o bloco `autos-path`, que segue o `caso.json`); sem ela, o
 * caminho dos autos passa reto, como antes.
 *
 * A numeração das versões continua sendo do RUN, não do arquivo (a minuta em
 * `v2`, a final em `v8`): decidido em 24/09/2026, com a medição pedindo o
 * contrário. A ordem das pastas é o relógio do run, e quem a lê como relógio não
 * é só esta função: o empacotador e o `prazo-fatal.json` procuram da maior para
 * a menor, a reabertura grava a maior como a versão entregue, e o hook de
 * redação lê a pasta do run a partir da `vN/`. Numerar por arquivo faria a `v3`
 * da minuta parecer mais nova que a `v1` da final.
 */
function resolverCaminho({ caminho, runId, entradas = [], modo = MODOS_CAMINHO.ESCRITA, existe = () => false, vazia = () => false, pastaDeAutos = null } = {}) {
  if (!Object.values(MODOS_CAMINHO).includes(modo)) {
    throw new Error(`modo de caminho inválido: "${modo}" (use escrita, leitura ou checkpoint)`);
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new Error('run_id é obrigatório: sem ele os artefatos de execuções diferentes colidem');
  }
  const autos = typeof pastaDeAutos === 'function' ? autosDoSquad(caminho) : null;
  if (autos) {
    const pasta = String(pastaDeAutos(autos.squad) || `${autos.squad}/autos`).replace(/\/+$/, '');
    return { caminho: autos.resto ? `${pasta}/${autos.resto}` : pasta, grupo: null, versao: null };
  }
  if (!sobOutput(caminho)) return { caminho, grupo: null, versao: null };

  const comRun = injetarRunId(caminho, runId);
  const grupo = grupoDe(caminho, runId);
  if (modo === MODOS_CAMINHO.CHECKPOINT) return { caminho: comRun, grupo, versao: null };

  const partes = comRun.split('/');
  const arquivo = partes.pop();
  const montar = (versao) => ({ caminho: [...partes, versao, arquivo].join('/'), grupo, versao });

  if (modo === MODOS_CAMINHO.LEITURA) {
    // O arquivo pedido pode não estar na maior versão do grupo: cada step grava
    // só os seus artefatos, e a resposta de checkpoint fica FORA de versão
    // (`output/<run>/foco.md`, ao lado das pastas `vN/` dos outros steps).
    // Medido num run real (15/09/2026): com `v1/prazo-fatal.json` no grupo, a
    // leitura de `foco.md` apontava para `v1/foco.md`, que não existe, e o
    // validador de input do step seguinte reprovava um arquivo que estava lá.
    // Procura-se da maior versão para a menor; depois o caminho sem versão; só
    // sem nada no disco vale a conta antiga (maior versão), para o `test -s`
    // falhar onde o runner procura, e não em silêncio.
    for (const n of numerosDeVersao(entradas).sort((a, b) => b - a)) {
      const candidato = montar(`v${n}`);
      if (existe(candidato.caminho)) return candidato;
    }
    if (existe(comRun)) return { caminho: comRun, grupo, versao: null };
  }

  const versao = modo === MODOS_CAMINHO.ESCRITA ? versaoDeEscrita(entradas, grupo, vazia) : versaoVigente(entradas);
  if (!versao) return { caminho: comRun, grupo, versao: null };
  return montar(versao);
}
// <<< squad-path:end

export {
  MODOS_CAMINHO,
  PADRAO_VERSAO,
  sobOutput,
  autosDoSquad,
  versaoDeEscrita,
  injetarRunId,
  numerosDeVersao,
  versaoVigente,
  proximaVersao,
  grupoDe,
  resolverCaminho,
};
