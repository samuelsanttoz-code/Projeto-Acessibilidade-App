# Assistente Web Acessível

Extensão Chrome/Edge para iniciar uma sessão temporária de assistência por voz em páginas HTTP/HTTPS. Esta versão executa somente comandos locais e não usa backend nem inteligência artificial.

## O que o atalho faz

Ao pressionar `Alt + Shift + A`, a extensão:

1. interrompe qualquer fala anterior;
2. emite um som curto de confirmação;
3. ativa uma sessão temporária;
4. informa por voz que está ouvindo;
5. inicia uma escuta de voz, quando o navegador oferece suporte.

Na primeira ativação, a extensão apresenta os comandos básicos. Essa informação é registrada em `chrome.storage.local`. Nenhum histórico de navegação é armazenado.

A sessão expira após cerca de 30 segundos sem nova interação. O reconhecimento usa uma escuta única por ativação, portanto o microfone não permanece ativo continuamente.

## Comandos disponíveis

- `modo dinâmico`: seleciona o modo `dynamic`.
- `modo denso`: seleciona o modo `dense`.
- `onde estou`: informa o título e o domínio da página atual.
- `pare`: interrompe a fala atual.
- `encerrar assistente`: encerra a sessão e desliga a escuta.
- `repita`: repete a última resposta a um comando, quando disponível.

Qualquer outro comando recebe a resposta: `Ainda não consigo executar esse comando.`

## APIs nativas

A síntese de voz usa `window.speechSynthesis` e `SpeechSynthesisUtterance`. O reconhecimento usa `SpeechRecognition` ou `webkitSpeechRecognition`, com idioma `pt-BR`, `continuous: false` e `interimResults: false`. O som de ativação usa Web Audio API.

O navegador pode solicitar permissão para usar o microfone. A extensão não envia áudio para um backend próprio, mas a implementação de `SpeechRecognition` do navegador pode processar o áudio remotamente conforme as regras do fornecedor.

Se o reconhecimento de voz não estiver disponível, a extensão informa essa limitação por voz. O atalho e a síntese continuam funcionando.

## Carregar sem compactação

1. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
2. Ative o **Modo do desenvolvedor**.
3. Selecione **Carregar sem compactação** (`Load unpacked`).
4. Escolha a pasta raiz deste projeto.

## Teste manual

Em uma página HTTP/HTTPS comum:

1. Pressione `Alt + Shift + A` e confirme o som e a mensagem falada.
2. Teste `onde estou`.
3. Teste `modo dinâmico`.
4. Teste `modo denso`.
5. Teste `repita`.
6. Teste `encerrar assistente`.
7. Durante uma fala, pressione `Alt + Shift + A` e confirme a interrupção imediata.
8. Confirme que o microfone não permanece ativo após o encerramento.
9. Confirme que não existem erros não tratados no console.

Páginas internas como `chrome://` e `edge://` não permitem a execução do content script. Nesses casos, o service worker mantém o tratamento de erro existente. Se outro programa usar o atalho, confira ou altere a combinação em `chrome://extensions/shortcuts` ou `edge://extensions/shortcuts`.

Execute a validação automatizada com:

```powershell
node --test --test-isolation=none tests/extension.test.js
```

## Limitações desta versão

Esta etapa não inclui leitura completa de DOM/ARIA, visão computacional, backend Python, LLM, Supabase, memória permanente, acessibilidade auditiva nem ações autônomas complexas. Os modos Dinâmico e Denso são apenas selecionados em memória; os comportamentos de leitura serão implementados em etapas futuras.
