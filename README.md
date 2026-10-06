# Jarvis — Assistente Web Acessível

Extensão Manifest V3 para Chrome e Edge que oferece assistência temporária por voz em páginas HTTP/HTTPS.

- `feature_key`: `accessible_web_assistant_mvp`
- `contract_version`: `4`

Jarvis só fica ativo depois de `Alt + Shift + A`. O nome pode ser dito no início de um comando durante a sessão, como em “Jarvis, que horas são?”, mas não funciona como palavra de ativação. Não há microfone permanentemente aberto, inteligência artificial, LLM, backend próprio ou ação autônoma complexa.

## Ativação, estados e sons

Cada som curto, ou *earcon*, indica uma etapa diferente:

- **ON**: confirma que uma nova ativação começou.
- **LISTENING**: indica que Jarvis vai abrir uma escuta de voz. O microfone só é iniciado depois que esse som termina.
- **PROCESSING**: confirma que uma fala foi reconhecida e será processada.
- **OFF**: confirma o encerramento solicitado pelo usuário.

Na primeira ativação de cada sessão do navegador, a sequência é ON, “Olá, sou Jarvis, à sua disposição.”, LISTENING e abertura do reconhecimento. Nas ativações seguintes da mesma sessão do navegador, a apresentação não se repete: a sequência é ON, LISTENING e reconhecimento.

Depois de reconhecer um comando, Jarvis fecha a escuta atual, toca PROCESSING, executa o comando, fala a resposta e toca LISTENING antes de abrir outra escuta. Assim, vários comandos podem ser usados na mesma ativação sem repetir o atalho. O microfone permanece fechado durante fala, sons, processamento e consultas de clima.

Uma nova ativação cancela fala, som e escuta anteriores. A sessão também expira após cerca de 30 segundos sem nova interação, fecha o microfone e volta ao estado inativo. O comando `encerrar assistente` fala “Até mais.”, toca OFF e encerra a sessão sem reabrir a escuta.

## Comandos disponíveis

O reconhecimento ignora maiúsculas, acentos e pontuação. Um `Jarvis` no início é opcional.

### Sessão e repetição

- `pare`: é reconhecido quando uma escuta está aberta; ao ser processado, interrompe a fala e mantém a sessão disponível. Durante a fala do assistente, o microfone fica fechado e não recebe esse comando.
- `repita`: repete a última resposta a um comando.
- `encerrar assistente`: encerra a sessão, fecha o microfone e toca OFF depois da despedida.
- `cancelar`: cancela uma pergunta pendente de cidade, pesquisa ou escolha.

### Voz e modo

- `fale mais rápido` e `fale mais devagar`.
- `velocidade normal`.
- `fale mais alto` e `fale mais baixo`.
- `troque sua voz`.
- `modo dinâmico` e `modo denso`.

### Conversa, identidade e ajuda

- `oi`, `olá`, `bom dia`, `boa tarde` e `boa noite`.
- `tudo bem`.
- `quem é você`.
- `ajuda`, `o que você faz` e `o que você consegue fazer`.

### Data e hora

- Hora: `que horas são`, `qual é a hora`, `qual a hora` ou `me diga a hora`.
- Data: `que dia é hoje`, `qual a data de hoje`, `que data é hoje` ou `qual o dia de hoje`.

As respostas usam o relógio e o fuso horário do computador.

### Clima por cidade

- Consulta direta: `tempo em Anápolis`, `clima em Recife`, `previsão em Curitiba` ou `previsão do tempo em Salvador`.
- Consulta em duas falas: diga `tempo`, `clima` ou `previsão`; depois de “De qual cidade?”, diga somente a cidade.
- Durante a pergunta de cidade, `cancelar` encerra a intenção pendente; `encerrar assistente` encerra a sessão sem consultar o clima. O prefixo inicial `Jarvis` também é opcional ao dizer a cidade.

A resposta pode incluir condição, temperatura, sensação térmica, vento, máxima e mínima. Valores ausentes são omitidos. Cidade não encontrada e falha de rede recebem mensagens distintas.

### Página e acessibilidade

- Localização: `onde estou`, `qual é o título da página`, `qual o título desta página` ou `título da página`.
- Descrição: `descreva a página`, `descreva esta página`, `descrever a página`, `o que há na página` ou `o que há nesta página`.
- Controles: `liste os botões`, `liste os links`, `liste os campos`, `quais são os botões`, `quais são os links` ou `quais são os campos de formulário`.
- Conteúdo: `leia o conteúdo`, `leia o conteúdo principal`, `leia o conteúdo da página` ou as mesmas formas iniciadas por `ler`.

Jarvis considera apenas elementos visíveis e com nome acessível. Nomes usam, quando disponíveis, `aria-label`, `aria-labelledby`, rótulo/texto visível, `alt`, `title`, `placeholder` e valores de controles seguros. Valores de campos de senha nunca são lidos.

### Navegação

- Para baixo: `scroll_down`, `scroll down`, `descer para baixo`, `descer pra baixo`, `descer`, `desce`, `pra baixo`, `para baixo`, `baixo` ou `vai pra baixo`.
- Para cima: `scroll_up`, `scroll up`, `subir para cima`, `subir pra cima`, `subir`, `sobe`, `pra cima`, `para cima`, `cima`, `em cima` ou `vai pra cima`.
- `volte` ou `voltar`.
- `avance` ou `avançar`.

Cada rolagem percorre aproximadamente 80% da altura visível. Voltar e avançar usam o histórico do navegador. Essas ações são silenciosas: quando funcionam, Jarvis volta diretamente a ouvir.

### YouTube

Em páginas do YouTube, Jarvis recalcula o contexto visível para acompanhar mudanças da interface SPA.

- `quais vídeos estão na tela`, `liste os vídeos` ou `vídeos da página`: enumera todos os vídeos identificados, sem o limite dos modos Dinâmico/Denso.
- `vídeo 2`, `abrir vídeo número 2` ou `abrir o terceiro vídeo`: abre pelo índice da última lista válida ou do contexto atual.
- `abrir FEIN official`, `abre o vídeo do Travis que é ao vivo`: busca localmente por título, canal e características. Pontuação estilizada, como `FE!N`, é tolerada.
- `abrir canal Future`, `canal do Future` ou `canal desse vídeo`: abre somente um link de canal; o último comando exige um vídeo alvo inequívoco.
- `shorts`, `liste os shorts`, `short 2` ou `abrir short <nome>`: abre a área, lista todos ou seleciona um Short.

Aberturas bem-sucedidas são silenciosas. Quando dois resultados têm pontuação próxima, Jarvis apresenta opções e aguarda uma resposta como `o oficial`, `o segundo` ou `vídeo 5`, sem clicar arbitrariamente.

### Pesquisa da página

- `barra de pesquisa`, `acessar barra de pesquisa`, `ir para barra de pesquisa` ou `abrir pesquisa`: foca o controle sem falar confirmação.
- `pesquisar Future DS2`, `buscar Future DS2`, `procure Future DS2` ou `procura Future DS2`: preenche a busca pela interface da página e a envia.
- `pesquisar`, `buscar`, `procure` ou `procura`: pergunta “O que você quer pesquisar?” e usa a fala seguinte.

O valor é aplicado ao controle real, com eventos `input` e `change`, seguido do mecanismo de envio existente na página. Jarvis não monta uma URL de pesquisa manualmente.

Comandos não implementados recebem “Ainda não consigo executar esse comando.”

## Perfil de voz e preferências

Toda fala usa `pt-BR`, velocidade padrão `1.02`, tom `0.9` e volume `1`. Jarvis prefere, nesta ordem, a voz salva, a primeira voz `pt-BR`, a primeira voz em português e a voz padrão do navegador.

A velocidade varia de `0.7` a `1.5` em passos de `0.1`; o volume varia de `0.2` a `1` em passos de `0.1`. A troca de voz percorre apenas vozes `pt-BR` e `pt`. Voz, velocidade, volume e modo são salvos imediatamente em `chrome.storage.local`, no objeto `jarvisPreferences`, e continuam válidos depois de recarregar a página.

O modo inicial é Dinâmico:

- **Dinâmico**: descrição compacta; até 5 nomes em listas de botões, links e campos; conteúdo principal de até 700 caracteres.
- **Denso**: inclui domínio, até 8 títulos e até 15 controles na descrição; até 15 nomes por lista; conteúdo principal de até 2.000 caracteres.

As descrições relatam apenas fatos observáveis no DOM. Para ler conteúdo, a prioridade é `main`, `article`, `[role="main"]` e, por fim, `body`; regiões como navegação, rodapé, scripts e estilos são ignoradas.

## Clima, dados e privacidade

Somente o service worker em `background.js` acessa a Open-Meteo. Ele primeiro resolve a cidade pela API de geocodificação e depois consulta a previsão atual e do dia. As únicas permissões de host são:

- `https://geocoding-api.open-meteo.com/*`
- `https://api.open-meteo.com/*`

O content script envia ao service worker somente o nome da cidade falado pelo usuário. Título, domínio, URL, texto, DOM e outros conteúdos da página não entram na solicitação de clima. A extensão não mantém histórico de navegação, comandos, clima ou conteúdo da página.

A apresentação única por sessão usa `chrome.storage.session`; as preferências de voz e modo usam `chrome.storage.local`. Nenhum áudio é enviado a um backend da extensão. Entretanto, `SpeechRecognition`/`webkitSpeechRecognition` é uma API do navegador e pode processar áudio remotamente, conforme as regras do fornecedor do navegador.

## Carregar a extensão sem compactação

1. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
2. Ative o **Modo do desenvolvedor**.
3. Selecione **Carregar sem compactação** (`Load unpacked`).
4. Escolha a pasta raiz deste projeto.
5. Abra uma página HTTP/HTTPS comum e permita o uso do microfone quando solicitado.
6. Pressione `Alt + Shift + A`. Se houver conflito de atalhos, ajuste-o em `chrome://extensions/shortcuts` ou `edge://extensions/shortcuts`.

Páginas internas como `chrome://` e `edge://` não aceitam o content script.

## Checklist manual de aceitação — 27 passos

Use uma página HTTP/HTTPS com título, títulos internos, conteúdo principal, botões, links e campos visíveis.

1. Em `chrome://extensions` ou `edge://extensions`, recarregue a extensão desempacotada.
2. Abra a página de teste HTTP/HTTPS e as ferramentas do desenvolvedor; limpe o Console.
3. Pressione `Alt + Shift + A` e autorize o microfone, se o navegador solicitar.
4. Confirme que ON toca primeiro e que nenhum microfone é aberto durante o som.
5. Confirme que a primeira ativação da sessão fala “Olá, sou Jarvis, à sua disposição.” exatamente uma vez.
6. Confirme que LISTENING toca depois da apresentação e que a escuta abre somente ao fim do som.
7. Diga `oi`; confirme PROCESSING, a resposta e um novo LISTENING, nessa ordem.
8. Sem repetir o atalho, diga `que horas são` e confira a hora local e o retorno à escuta.
9. Ainda sem repetir o atalho, diga `que dia é hoje`; confira a data e complete três comandos contínuos na mesma ativação.
10. Diga `Jarvis, quem é você?` e confirme que o prefixo é removido e a resposta identifica o assistente de acessibilidade.
11. Diga `ajuda` e confira se a resposta cita somente os grupos de comandos implementados.
12. Diga `fale mais devagar`, depois `velocidade normal`, e confirme que cada resposta já usa o valor novo.
13. Diga `fale mais baixo`, depois `fale mais alto`, e confirme as duas alterações.
14. Diga `troque sua voz` e confirme a mudança quando houver outra voz em português instalada.
15. Diga `modo denso` e confirme a ativação do modo.
16. Recarregue a página, pressione o atalho e confirme que a preferência persistiu e que a apresentação não se repete na mesma sessão do navegador.
17. Diga `onde estou` e confira o título e o domínio falados.
18. Diga `descreva a página`; depois liste botões, links e campos e confira os totais e o limite denso de até 15 nomes.
19. Diga `leia o conteúdo principal` e confirme que navegação, rodapé e conteúdo oculto não são lidos.
20. Diga `modo dinâmico`, repita a descrição e as listas e confirme a saída mais compacta, com até 5 nomes e leitura limitada a 700 caracteres.
21. Teste `desce`, `sobe`, `volte` e `avance`, confirmando movimento/histórico sem fala de confirmação. No YouTube, liste e abra vídeos, canais e Shorts; teste pesquisa direta, em duas etapas e uma desambiguação.
22. Diga `tempo em Anápolis`; confirme PROCESSING sem microfone, a resposta da Open-Meteo e o retorno a LISTENING.
23. Diga `clima`; após “De qual cidade?”, diga uma cidade e confirme que essa segunda fala é usada somente como cidade.
24. Diga `previsão`, responda `cancelar` à pergunta de cidade e confirme “Cancelado.” sem consulta.
25. Diga `repita`; depois que LISTENING voltar, diga `pare` e confirme que a sessão continua disponível. Em seguida, teste um comando inexistente para conferir o fallback.
26. Diga `encerrar assistente`; confirme “Até mais.”, OFF, microfone fechado e estado inativo. Pressione o atalho outra vez e confirme ON seguido de LISTENING, sem nova apresentação; encerre novamente.
27. Faça uma última ativação sem novos comandos, aguarde cerca de 30 segundos e confirme o encerramento por inatividade, o microfone fechado e a ausência de erros não tratados no Console.

Status desta execução: validação manual pendente

## Validação automatizada

Na raiz do projeto, execute:

```powershell
node --test --test-isolation=none tests/extension.test.js
node --check content.js
node --check background.js
node -e "JSON.parse(require('node:fs').readFileSync('manifest.json','utf8')); console.log('manifest válido')"
git diff --check
```

## Limitações

- Depende de `SpeechRecognition` ou `webkitSpeechRecognition`; navegadores sem suporte recebem uma mensagem falada e não reconhecem comandos.
- O reconhecimento é não contínuo: cada escuta captura uma fala e é reaberta entre comandos enquanto a sessão estiver ativa.
- Não funciona em páginas internas ou outras páginas que bloqueiam content scripts.
- A leitura usa o DOM renderizado e nomes acessíveis básicos; não implementa uma árvore de acessibilidade completa.
- Não há OCR, visão computacional, LLM, backend proprietário, Supabase, memória permanente ou automação complexa.
- O clima depende da rede e da disponibilidade da Open-Meteo.
- O navegador e o sistema operacional determinam as vozes instaladas, a qualidade do reconhecimento e possíveis conflitos de atalho.
