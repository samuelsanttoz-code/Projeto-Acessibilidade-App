# AGENTS.md

Evitar criar classes, padrões arquiteturais complexos ou abstrações sem necessidade.

Git:

- Trabalhar somente na branch `main`.
- Criar um commit ao terminar.
- Se existir remote configurado, realizar push.
- Se não existir remote, não inventar um; informar explicitamente que o push não foi realizado por ausência de remote.

Ao finalizar, retornar obrigatoriamente:

- feature_key
- contract_version
- repositório/diretório utilizado
- branch
- commit SHA
- resultado do push
- validações executadas
