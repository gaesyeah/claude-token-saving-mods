# Este vault

Segundo cérebro em Markdown, no estilo Zettelkasten / notas evergreen (Luhmann, Andy Matuschak):
notas pequenas, uma ideia cada, muito ligadas entre si, e mapas (MOCs) que juntam um tema. O
Obsidian só mostra estes arquivos; tudo funciona com ele fechado. Leia este arquivo antes de
criar, mover ou renomear notas.

## Pastas

| Pasta | O que vai nela |
|---|---|
| `Inbox/` | Capturas rápidas, ainda cruas. Viram notas permanentes depois (`/vault inbox`). |
| `Notes/` | Notas permanentes: uma ideia, escrita com as suas palavras, que faz sentido sozinha. |
| `MOCs/` | Mapas de conteúdo: uma nota por tema, com links organizados para as notas dele. |
| `Sources/` | Uma nota por fonte (livro, artigo, vídeo, pesquisa), com o resumo e o link. |
| `Projects/` | Um esforço com fim. Uma nota por projeto, com o nome do projeto. |
| `Daily/` | Uma nota por dia, `AAAA-MM-DD.md`. |
| `Reviews/` | Revisões semanais, `AAAA-Www.md`. |
| `Claude/` | Escrito pelos mods (handoffs, pesquisas, leituras). Não edite à mão: transforme em notas em `Notes/` ou `Sources/` o que quiser guardar. |
| `Templates/` | Modelos de nota do Obsidian. |

## Notas

- O título é a ideia, como frase (`Busca híbrida ganha de busca por palavra em notas.md`).
- Frontmatter em toda nota:
  ```yaml
  ---
  type: note        # note | moc | source | project | daily | review
  date: 2026-01-31
  tags: [assunto]
  source: "[[Fonte]]"   # opcional
  ---
  ```
- Toda nota liga para pelo menos uma outra e aparece em pelo menos um MOC. Nota sem link é nota perdida.
- Diga no link por que ligou: "isso contradiz [[X]]", "exemplo de [[Y]]".
- Antes de criar, busque. Se já existe nota com a ideia, melhore-a em vez de duplicar.

## Para o Claude

- Busca: use o comando de busca que o mod Vault colocou no prompt do sistema; sem ele, Grep neste vault.
- Nunca apague nota. Mude só o que foi pedido. Ao terminar, diga os caminhos das notas que criou ou mudou.
