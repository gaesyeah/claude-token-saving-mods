# Este vault

Segundo cérebro em Markdown, organizado pelo método PARA (Tiago Forte). O Obsidian só mostra
estes arquivos; tudo funciona com ele fechado. Leia este arquivo antes de criar, mover ou
renomear notas.

## Pastas

| Pasta | O que vai nela |
|---|---|
| `Inbox/` | Tudo que chega e ainda não foi organizado. Capture aqui; organize depois (`/vault inbox`). |
| `Projects/` | Um esforço com fim e objetivo (um app, uma viagem, um curso). Uma nota por projeto, com o nome do projeto. |
| `Areas/` | Responsabilidades sem fim (saúde, finanças, carreira, um sistema que você mantém). |
| `Resources/` | Assuntos de interesse e referência (uma tecnologia, um livro, um tema). |
| `Archive/` | Projetos terminados e o que deixou de importar. Nada é apagado: vem pra cá. |
| `Daily/` | Uma nota por dia, `AAAA-MM-DD.md`, com o que aconteceu e links. |
| `Reviews/` | Revisões semanais, `AAAA-Www.md`. |
| `Claude/` | Escrito pelos mods (handoffs, pesquisas, leituras). Não edite à mão: copie para `Resources/` o que quiser guardar. |
| `Templates/` | Modelos de nota do Obsidian. |

Pastas rasas: no máximo um nível abaixo destas.

## Notas

- Uma ideia por nota, com título que diz a ideia (`Cache do prompt expira em 5 minutos.md`, não `Notas cache.md`).
- Frontmatter em toda nota:
  ```yaml
  ---
  type: note        # note | project | area | resource | daily | review
  date: 2026-01-31  # criação
  tags: [assunto]
  project: "[[Nome do projeto]]"   # opcional
  ---
  ```
- Ligue cada nota a pelo menos uma outra com `[[Nome da nota]]`. Antes de criar, busque: se já existe nota sobre isso, atualize-a em vez de duplicar.
- Escreva com as suas palavras; cite fontes com link no fim.

## Para o Claude

- Busca: use o comando de busca que o mod Vault colocou no prompt do sistema; sem ele, Grep neste vault.
- Nunca apague nota. Mover para `Archive/` só com o ok da pessoa.
- Mude só o que foi pedido. Ao terminar, diga os caminhos das notas que criou ou mudou.
