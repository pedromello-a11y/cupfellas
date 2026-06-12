# Prompt de kickoff — colar no Claude Code (na pasta do projeto)

---

Você vai construir o front do WorldFellas, um bolão privado da Copa 2026 para meus amigos.

Leia PRIMEIRO e por completo, nesta ordem:
1. `CLAUDE.md` — a especificação completa e obrigatória (produto, dados, telas, design, edge cases, critérios de aceite)
2. `database.rules.json`, `netlify.toml` e os 3 arquivos em `netlify/functions/` — infraestrutura PRONTA: não reescrever nem alterar

Depois de ler, me peça apenas duas coisas antes de codar:
- o objeto `firebaseConfig` do meu projeto Firebase
- a lista do ROSTER (slug + nome de cada participante; as caricaturas já estão em `assets/avatars/{slug}.png`)

Então construa o `index.html` completo conforme a spec, teste com `npx netlify-cli dev` e rode todos os critérios de aceite do CLAUDE.md antes de me declarar pronto. Trabalhe em blocos e me mostre o progresso a cada bloco concluído (config → CSS/design system → identidade → palpites → pontuação → todos os palpites → tracker → ranking → bônus → admin → polish).

Restrições inegociáveis: arquivo único vanilla JS (sem framework, sem build), Firebase compat via CDN, nenhum segredo no código do cliente (token da API e secret do Firebase só existem nas env vars das functions), e a regra de pontuação exatamente como especificada (3/1/0 + bônus).

O prazo é hoje: a Copa começa amanhã às 16h e os palpites bônus travam no apito inicial. Priorize na ordem: palpites funcionando → bônus → classificação → identidade com caricaturas → resto.
