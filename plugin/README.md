<!-- ARQUIVO GERADO por scripts/build-plugin.mjs — não edite aqui. -->

# LegalSquad — plugin do Claude Code

Versão 0.6.1. Gerado a partir de `templates/ide-templates/claude-code/.claude/`
no repositório [legalsquad-nucleo](https://github.com/bbpropulse/legalsquad-nucleo).

## Instalar

```bash
claude plugin marketplace add bbpropulse/legalsquad-nucleo
claude plugin install legalsquad@bbpropulse
```

## O que vem aqui

- `skills/legalsquad/` — a skill `/legalsquad:legalsquad`, com os gates de citação
  e redação no frontmatter;
- `agents/` — os cinco agentes de núcleo (`verificador-citacoes`, `avaliador-squad`,
  `catalog-scout`, `verificador-persuasao`, `contraditor`);
- `scripts/` — os hooks determinísticos, byte a byte iguais aos do motor;
- `hooks/hooks.json` — o backstop advisory de citações.

## O que NÃO vem aqui

O **motor** (CLI `legalsquad`: `init`, `update`, `acervo sync`, empacotador) e o
bloco global de `CLAUDE.md` — plugin não injeta `CLAUDE.md`. Instale o motor com
`npm install -g github:bbpropulse/legalsquad-nucleo`.

Também não viaja aqui **nenhuma matéria jurídica de área** (skills de matéria,
squads, best-practices, acervo, agentes especialistas): áreas do Direito chegam
como pacotes assinados por `legalsquad acervo sync`. Nem memória, nem
`squads/*/output/`, nem `skills/_evals/results/`.
