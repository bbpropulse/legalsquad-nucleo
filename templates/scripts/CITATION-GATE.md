# Citation Gate distribuível

O `verifica-citacoes.mjs` é uma **sentinela determinística**, não um pesquisador
jurídico. Para saídas jurídicas finais em `squads/<nome>/output/`, ele bloqueia:

- marcadores como `[NÃO VERIFICADO]`, `[DIVERGENTE]` e `[CONFERIR]`;
- ausência ou invalidade do manifesto vinculado ao artefato;
- manifesto pendente, incompleto ou incompatível com citações detectáveis;
- citação material no texto (lei + artigo, súmula, tema, acórdão) **sem entrada correspondente**
  em `citations[]`: o manifesto cobre cada citação, não "ao menos uma";
- alteração do artefato depois da verificação (SHA-256 divergente).

Ele **não acessa fontes**, não confirma a existência ou o teor de um julgado, não
decide se uma URL é oficial e não substitui a revisão humana. `source_url` HTTPS e
`status: verificada` são apenas uma atestação local: devem ser preenchidos somente
depois da conferência material em fonte primária pelo fluxo `verificador-citacoes`.

## Quando o manifesto é exigido

O gate alcança arquivos gravados por `Write`/`Edit` dentro de
`squads/<nome>/output/` quando ao menos uma condição for verdadeira:

- o nome representa peça, ato ou instrumento jurídico. O vocabulário está no próprio hook
  (`NOMES_DE_PECA`, 600 nomes levantados das skills em produção de todas as áreas): `contestacao`,
  `apelacao`, `embargos-de-declaracao`, `resposta-a-acusacao`, `reclamacao-trabalhista`,
  `mandado-de-seguranca`, `sentenca`, `parecer`, `contrato`, `notificacao`… O nome é lido sem acento,
  sem extensão e sem preposição, com camelCase separado, e o token conta em **qualquer posição**:
  `Contestação_Cliente.v2.md`, `0001234-56.2024.8.26.0100-sentenca.md`, `cliente-x-inicial.md` e
  `PeticaoInicial.docx` são peça. O que livra o artefato interno é a **convenção interna**:
  prefixo (`PREFIXOS_INTERNOS`: `analise-`, `fichamento-`, `mapa-`, `plano-`, `resumo-`, `pesquisa-`,
  `notas-`, `revisao-`, `relatorio-`, `checklist-`…, também depois de um ordinal ou data:
  `03-analise-da-contestacao.md`), sufixo (`contrato-analise.md`, `hc-fichamento.md`), segmento de
  gestão do run (`-tarefas`, `-pendencias`, `-reuniao`, `-estrategia`, `-prazos`) e subpasta interna
  depois de `output/` (`output/diagnostico/`, `output/pesquisa/`, `output/notas/`, `output/revisao*/`).
  Exceção: nome que começa por um token composto do vocabulário é peça (`relatorio-e-voto.md`,
  `nota-tecnica.md`, `revisao-de-beneficio.md`, `plano-de-partilha.md`), e `interno` dentro do
  composto não é rascunho (`agravo-interno.md`, `regimento-interno.md`). Palavras que sozinhas
  nomeiam tanto peça quanto coisa interna (`decisao`, `ata`, `termo`, `carta`, `memorando`,
  `informacoes`, `consulta`) só entram compostas; o ato solto (`decisao.md`) é pego pela forma;
- o texto tem **forma de peça**: duas fórmulas em trechos distintos, entre endereçamento
  ("Excelentíssimo Senhor Doutor Juiz", "Exmo. Sr. Dr.", "MM. Juízo", "Ao Juízo da"), introito
  ("vem, respeitosamente", "por seus advogados abaixo assinados"), fecho ("Nestes termos, pede
  deferimento", "Valor da causa:"), dispositivo de ato judicial ("Vistos.", "É o relatório", "DECIDO",
  "Ante o exposto, JULGO", "Posto isso", "Pelo exposto, NEGA-SE PROVIMENTO", "Publique-se. Intimem-se.",
  "ACORDAM", "V. U."), fecho de parecer ("É o parecer", "s.m.j."), Ministério Público ("no uso de suas
  atribuições", "Requer o Ministério Público", "incurso nas penas do art."), contrato ("Pelo presente
  instrumento", "CLÁUSULA PRIMEIRA" ou "1. OBJETO", "elegem o foro", "CONTRATANTE:"), notificação
  ("NOTIFICANTE:", "fica V.Sa. notificado", "medidas judiciais cabíveis"), procuração ("constitui …
  procurador", "ad judicia"). Duas regexes na MESMA frase valem uma: um dispositivo transcrito numa
  análise ("Ante o exposto, JULGO PROCEDENTE") não faz dela uma peça;
- o nome tem `final` como token (`recurso-final.md`; `finalizado` não conta) ou o arquivo está no
  subdiretório `output/final/`. O `output/final/`, o marcador e o frontmatter `citation_gate: final`
  vencem a convenção de nome interno (`output/final/resumo-da-sentenca.md` é peça); o rascunho
  declarado (`minuta`, `rascunho`, `draft`, `citation_gate: draft`, nome começando por `_`) não é
  desfeito por nada;
- o texto contém `<!-- LEGALSQUAD:CITATION-GATE:FINAL -->`;
- o frontmatter contém `citation_gate: final`.

Minutas e arquivos internos (`minuta`, `rascunho`, `draft`, `_...`, subpastas `revisao*/`,
`diagnostico/`, `pesquisa/`, `notas/`) ficam fora do bloqueio para que o trabalho iterativo
continue possível.
Para promover uma minuta, remova o marcador de draft, grave-a com nome final e
complete o gate.

## Manifesto

Num run do LegalSquad, o manifesto **não se escreve à mão**: sai do cartório do run.

```sh
node scripts/squad-state.mjs manifesto-final squads/<nome> --peca squads/<nome>/output/<run>/v8/recurso-final.md \
  --por conferente [--pendencias pendencias.json]
```

O comando põe em `citations[]` uma entrada por citação da peça, com a fonte, a hora, a `evidence` e
os `verificadores` que o cartório (`squads/<nome>/review-state.json`) guardou; calcula o SHA-256;
monta `pendencias_do_profissional[]` dos marcadores de dado do texto (`procurado_em` e
`diligencia` vêm do `--pendencias`, porque são juízo de quem procurou); valida contra o schema e
passa pelo hook antes de deixar o arquivo gravado. Recusa, sem gravar nada, quando a peça cita o que
o cartório não tem verificado (e lista quais), quando resta marcador de citação e quando falta a
diligência de um marcador de dado. Medido em 24/09/2026: escrito à mão, cada um dos 8 runs dos
moldes montou o manifesto de um jeito, e num deles entrou uma citação que ninguém conferiu.

Fora de um run (peça avulsa), o formato é este. Para `recurso-final.md`, ao lado
`recurso-final.md.citation-gate.json`, conforme
`scripts/citation-gate-manifest.schema.json`:

```json
{
  "schema_version": "1",
  "kind": "legalsquad.citation-gate-attestation",
  "artifact": "recurso-final.md",
  "artifact_sha256": "SHA256_HEXADECIMAL_DO_ARQUIVO",
  "gate_status": "aprovado",
  "verification_type": "material",
  "scope": "citacoes_materiais",
  "verified_by": "identificador-do-revisor",
  "verified_at": "2026-07-09T18:00:00-03:00",
  "citations": [
    {
      "title": "identificação completa da norma ou julgado",
      "status": "verificada",
      "source_url": "https://fonte-primaria.example/documento",
      "consulted_at": "2026-07-09T17:45:00-03:00"
    }
  ]
}
```

**Onde foi conferida.** `status: "verificada"` diz que a fonte oficial foi aberta no run.
Citação conferida só na cópia do acervo assinado (a captura oficial do curador, quando a página do
tribunal não abriu) leva `status: "verificada_no_acervo"` e `evidence.fonte_local` com o caminho da
cópia lida, dentro de `acervo/` (e, quando houver, o `sha256_texto` dela): o hook recusa
`verificada_no_acervo` sem essa cópia, e quem lê o manifesto (o profissional, o avaliador da meta)
vê a origem em vez de ler uma página que não abriu.

**Uma entrada por citação do texto.** O hook extrai cada citação material da peça e exige em
`citations[]` uma entrada cujo `title` traga a **mesma classe e o mesmo número**. O que ele reconhece
no texto: lei com artigo em qualquer ordem e grafia (`art. 373, I, do CPC`, `CPC, art. 300`,
`art. 927 do Código Civil`, `art. 5º, LV, da Constituição Federal`, `CF/88, art. 37`, `CRFB`,
`NCPC`, `arts. 5º e 6º da CF`, `arts. 186, 187 e 927 do CC`, `art. 1.022, II, do CPC`, `Lei nº 8.078,
de 11 de setembro de 1990, art. 6º`, `IN RFB nº 2.110/2022, art. 10`, `Portaria MTE 671/2021`,
`Resolução CNJ 455/2022`, `Decreto-Lei 5.452/1943`, `LC 123/2006`, `art. 33 da Lei de Drogas`,
`Lei Maria da Penha, art. 22`), súmula e SV (`Súmula 7/STJ`, `Súm. 7`, `Súmula n.º 331 do TST`,
`Enunciado 331`, `SV 11`, `Súmulas 5 e 7`), OJ e precedente normativo (`OJ 394 da SDI-1`, `PN 120`),
tema (`Tema 1.234 do STJ`, `Tema RG 1.075`, `Temas 988 e 1.234`) e acórdão em sigla ou por extenso
(`REsp 1.234.567/SP`, `AgRg no HC 654.321/MG`, `ADPF 130`, `ADIn 4.277`, `Recurso Especial nº
1.234.567/SP`, `AIRR-10553-79.2013.5.15.0090`). Cobertura: sigla ou nome por extenso valem (`CPC`,
`Código de Processo Civil` ou `Lei 13.105/2015`; `REsp` ou `Recurso Especial`), no singular ou no
plural (`STJ, Súmulas 5 e 7`); diploma numerado é identificado pelo número, não pela palavra "lei";
o artigo tem de vir depois de `art.` no título; tribunal e natureza vinculante contam (`Súmula 7 do
STF` não atesta `Súmula 7 do STJ`; `Súmula 11 do STJ` não atesta a `SV 11`); número parecido não
cobre (`REsp 11.234.567` não atesta `REsp 1.234.567`; `art. 1º` não atesta `art. 1.015`; o ano da lei
não atesta o artigo). Endereço ("Campo Grande/MS 79002-000", "AP 1201") e título de seção ("TEMA 1:")
não entram na conta. Quando falta cobertura, a mensagem de bloqueio lista as citações descobertas com
a linha em que estão.

`artifact` é o nome do arquivo ou um caminho relativo que termine nele
(`squads/<nome>/output/<run>/v8/recurso-final.md`); o hook confere que o caminho aponta a peça ao
lado do manifesto, e recusa caminho absoluto ou com `..`. `verificadores` (opcional, por citação)
lista quem a confirmou no run.

Calcule o hash depois da última alteração do artefato. Em macOS/Linux:

```sh
shasum -a 256 squads/<nome>/output/recurso-final.md
```

Se a conferência material concluir que não existe nenhuma citação de norma,
súmula, tema ou precedente, use `scope: sem_citacoes_materiais` e `citations: []`.
A sentinela rejeita essa declaração quando reconhece uma citação material no texto.

Validação manual determinística:

```sh
node .claude/hooks/verifica-citacoes.mjs --check squads/<nome>/output/recurso-final.md
```

Um gate aprovado libera apenas a **entrega para revisão humana**. Protocolo, envio
ou publicação continuam sujeitos ao checkpoint humano próprio.
