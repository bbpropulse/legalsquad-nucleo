# Scripts "orchestra" — cache local de intimações

Padrão trazido do **My-Brain-Is-Full-Crew**: helpers leves e **pré-aprovados** que
consultam um **cache local** em vez de re-chamar a API do DJEN a cada pergunta.
Ganhos: respostas **instantâneas**, funcionam **offline**, dão **histórico pesquisável**
de intimações e evitam novos prompts de permissão de Bash a cada comando.

## O cache: `_legalsquad/_memory/djen-tracker.jsonl`

Um objeto JSON **por linha** (append-only, gitignored — é dado privado/sigiloso). Esquema:

```json
{
  "id": "0000000-00.0000.0.00.0000|3f2a1b9c",
  "capturado_em": "2026-06-17T14:00:00Z",
  "processo": "0000000-00.0000.0.00.0000",
  "tribunal": "TJSP",
  "orgao": "<órgão julgador, como vem do DJEN>",
  "tipo": "intimacao",            // intimacao | despacho | decisao | sentenca | publicacao
  "teor": "texto da publicação/intimação",
  "cliente": "Fulano de Tal",
  "prazo_dias": 5,
  "fatal": "2026-06-24",          // data fatal (AAAA-MM-DD) calculada por gestao-prazos-processuais; ou null
  "lido": false
}
```

> O `id` (nº do processo + hash do teor) é a **chave de dedupe**: a mesma intimação não entra duas vezes.

Ao lado do tracker vive `djen-varredura.json` (`{"ultima_varredura": "<ISO>"}`): o instante da
**última varredura**, que é coisa diferente do instante da **última intimação gravada**. Varredura
bem sucedida **sem novidades** é o caso comum — sem esse marcador o frescor acusaria
"desatualizado" todo dia mesmo com o monitoramento em dia.

## Quem alimenta

O agente **`monitor-dje-djen`** / a skill **`djen-api-oficial`** capturam o DJEN e gravam cada item
com `djen-tracker-add.mjs`. A **data fatal** deve ser calculada pela best-practice
`gestao-prazos-processuais` **antes** de gravar `fatal`. A regra de contagem — dias corridos ou
úteis, termo inicial, suspensões, prazo em dobro — é da **área instalada** e do perfil da
instituição: não presuma nenhuma; consulte a best-practice e o acervo da área.

## Varredura automática do DJEN (sem LLM)

`djen-varredura.mjs` consulta a API pública de comunicações do CNJ por OAB/UF numa janela de datas
e grava cada comunicação no tracker (dedupe pelo hash do próprio DJEN), registrando a varredura.
`fatal` entra **null** — a data fatal continua sendo calculada pela best-practice de prazos, nunca
pelo script. Varredura que falha (rede, HTTP, JSON) não grava nada e **não** registra frescor.

```bash
# OAB/UF: flags > ambiente > arquivo privado ao lado do tracker
echo '{"oab":"12345","uf":"PE"}' > _legalsquad/_memory/djen.json
node scripts/orchestra/djen-varredura.mjs                   # janela: véspera da última varredura → hoje (7 dias se nunca rodou)
node scripts/orchestra/djen-varredura.mjs --dias 3 --json   # janela explícita, resumo em JSON
node scripts/orchestra/djen-varredura.mjs --dry-run         # consulta sem gravar
```

O briefing (`legalsquad chefe --briefing`) roda a varredura **antes** das três fontes quando o
`djen.json` existe — o ritual agendado passa a manter o cache sozinho. O teor das comunicações
nunca vai ao terminal: fica no cache privado.

## Consultas (instantâneas, sem API)

| Script | O que faz |
|--------|-----------|
| `node scripts/orchestra/prazos-hoje.mjs` | Prazos com fatal **hoje** |
| `node scripts/orchestra/prazos-semana.mjs` | Prazos com fatal nos **próximos 7 dias** |
| `node scripts/orchestra/intimacoes-recentes.mjs [horas]` | Intimações das últimas N horas (default 24) |
| `node scripts/orchestra/processo-lookup.mjs <nº>` | Tudo sobre um processo |
| `node scripts/orchestra/cliente-lookup.mjs <nome>` | Intimações de um cliente |

Todas aceitam `--json` (saída para máquina); sem a flag, imprimem tabela legível.
Atalhos npm: `npm run prazos:hoje`, `npm run prazos:semana`, `npm run intimacoes`.

### Frescor — sempre, inclusive no `--json`

O `--json` é o canal pelo qual skills e agentes leem prazos. Nele, "cache inexistente", "cache de
2 anos" e "realmente não há prazo" **precisam ser distinguíveis** — por isso o frescor não é uma
linha de texto opcional, é **campo estruturado do envelope**:

```json
{
  "freshness": {
    "last_capture": "2026-07-21T11:00:00Z",
    "last_sweep":   "2026-07-21T14:00:00Z",
    "reference":    "2026-07-21T14:00:00Z",
    "age_hours": 2,
    "max_hours": 24,
    "stale": false
  },
  "ilegiveis": 0,
  "total": 1,
  "registros": [ { "...": "..." } ]
}
```

- `stale: true` com `age_hours: null` = **nunca houve captura** (não é "nenhum prazo").
- `ilegiveis > 0` = há linha(s) corrompida(s) no JSONL (o append-only pode truncar num crash).
  **"Não sei ler" ≠ "não existe":** o total pode estar incompleto e isso é dito, não escondido.
- `reference` é o mais recente entre `last_sweep` e `last_capture`.

O dia de "hoje" é apurado no **fuso do foro (`America/Sao_Paulo`)**, não no da máquina: contêiner,
cron e viagem rodam em UTC e devolveriam lista vazia **com selo verde** no dia do vencimento.

## Gravar

```bash
node scripts/orchestra/djen-tracker-add.mjs --data '{"processo":"...","teor":"...","fatal":"2026-06-24","cliente":"...","tipo":"intimacao"}'
# ou via stdin (um objeto ou um array):
echo '[{...},{...}]' | node scripts/orchestra/djen-tracker-add.mjs

# varredura concluída SEM novidades — registra o instante, não grava intimação:
node scripts/orchestra/djen-tracker-add.mjs --varredura
```

> O `djen-tracker.jsonl` é **privado** (gitignored) — contém dados de processo/cliente. Nunca o versione.

## Carteira (dataset consolidado)

`carteira-consolidar.mjs` varre `acervo/casos/*/carteira-row.json` (uma linha-plana por caso,
emitida pela skill `carteira-lote`) e produz a **tabela normalizada da carteira** em
`acervo/casos/_carteira/carteira.{json,csv}`, ordenada por prazo fatal (mais urgente primeiro).
Determinístico e sem dependência de YAML (a linha-plana é JSON puro); linhas malformadas são
puladas com aviso, nunca derrubam a consolidação. É o dataset que alimenta relatório executivo,
mail-merge (`mail-merge-pecas`) e dashboard.

**Diretório ausente ≠ carteira vazia.** Se `acervo/casos/` não existir, nada é gravado, a saída
traz `diretorio_ausente: true` (com `total: null`) e o processo termina com código ≠ 0 — um
`carteira.json` vazio seria lido depois como "escritório sem casos", que é mentira com cara de fato.

**Esquema neutro quanto à matéria.** As colunas são `processo, polo, partes, classificacao,
data_fato, valor, fase, proximo_ato, prazo_fatal, riscos_n, o_que_falta_n, confianca,
atualizado_em`. O motor não presume área do Direito: `partes` e `classificacao` são genéricos, e as
chaves antigas `reu`/`tipos_penais` continuam sendo **lidas** como entrada legada e mapeadas para
elas. A `fase` também não é taxonomia fechada — as fases neutras aparecem sempre (zeradas) e
qualquer outra declarada pela área instalada entra no agregado com a própria chave.

```bash
node scripts/orchestra/carteira-consolidar.mjs        # tabela legível + resumo
node scripts/orchestra/carteira-consolidar.mjs --json  # resumo em JSON
# ou: npm run carteira
```

`carteira-metricas.mjs` agrega esse dataset em **métricas gerenciais determinísticas** (total,
por fase/gargalos, em risco, com pendência, com/sem prazo, por confiança, valor total) — os
NÚMEROS reproduzíveis que a skill `relatorio-executivo-escritorio` usa no one-pager gerencial.

```bash
node scripts/orchestra/carteira-metricas.mjs          # métricas legíveis
node scripts/orchestra/carteira-metricas.mjs --json   # métricas em JSON
# ou: npm run carteira:metricas
```

> `acervo/casos/` (e o dataset em `_carteira/`) é **sigiloso** (gitignored) — nunca versione.
