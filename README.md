# Assistente Web Acessível

Extensão Chrome/Edge voltada à futura assistência de pessoas com deficiência visual durante a navegação. Esta etapa cria somente a fundação funcional do MVP, sem backend, IA, reconhecimento de voz ou síntese de voz definitiva.

## Estrutura atual

- `manifest.json`: configuração Manifest V3, permissão e atalho.
- `background.js`: service worker que recebe o comando de teclado e envia a ativação à aba ativa.
- `content.js`: content script injetado em páginas HTTP/HTTPS; registra a ativação e mantém estado mínimo em memória.
- `tests/extension.test.js`: valida o manifesto e o fluxo entre os componentes.

## Carregar sem compactação

1. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
2. Ative o **Modo do desenvolvedor**.
3. Selecione **Carregar sem compactação** (`Load unpacked`).
4. Escolha a pasta raiz deste projeto.

## Testar o atalho

1. Abra qualquer página comum com endereço `http://` ou `https://`.
2. Abra as ferramentas do desenvolvedor e selecione o Console.
3. Pressione `Alt + Shift + A`.
4. Confirme a mensagem `[Assistente Acessível] Assistente ativado.` no Console.

Páginas internas como `chrome://` e `edge://` não permitem a injeção do content script. Se outro programa usar o atalho, confira ou altere a combinação em `chrome://extensions/shortcuts` ou `edge://extensions/shortcuts`.

Para executar a validação automatizada:

```powershell
node --test --test-isolation=none tests/extension.test.js
```

Esta versão é apenas a fundação do MVP. Leitura de DOM/ARIA, contexto da página, backend Python, IA conversacional e modos Dinâmico e Denso ficam para etapas futuras.
