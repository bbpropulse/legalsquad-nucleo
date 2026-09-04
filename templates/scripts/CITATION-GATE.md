# Citation Gate distribuível

O `verifica-citacoes.mjs` é uma **sentinela determinística**, não um pesquisador
jurídico. Para saídas jurídicas finais em `squads/<nome>/output/`, ele bloqueia:

- marcadores como `[NÃO VERIFICADO]`, `[DIVERGENTE]` e `[CONFERIR]`;
- ausência ou invalidade do manifesto vinculado ao artefato;
- manifesto pendente, incompleto ou incompatível com citações detectáveis;
- alteração do artefato depois da verificação (SHA-256 divergente).

Ele **não acessa fontes**, não confirma a existência ou o teor de um julgado, não
decide se uma URL é oficial e não substitui a revisão humana. `source_url` HTTPS e
`status: verificada` são apenas uma atestação local: devem ser preenchidos somente
depois da conferência material em fonte primária pelo fluxo `verificador-citacoes`.

## Quando o manifesto é exigido

O gate alcança arquivos gravados por `Write`/`Edit` dentro de
`squads/<nome>/output/` quando ao menos uma condição for verdadeira:

- o nome representa peça jurídica (`peticao`, `recurso`, `memoriais`, `parecer` etc.);
- o nome contém `final` ou o arquivo está no subdiretório `output/final/`;
- o texto contém `<!-- LEGALSQUAD:CITATION-GATE:FINAL -->`;
- o frontmatter contém `citation_gate: final`.

Minutas e arquivos internos (`minuta`, `rascunho`, `draft`, `_...`, diretórios de
revisão) ficam fora do bloqueio para que o trabalho iterativo continue possível.
Para promover uma minuta, remova o marcador de draft, grave-a com nome final e
complete o gate.

## Manifesto

Para `recurso-final.md`, crie ao lado
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
