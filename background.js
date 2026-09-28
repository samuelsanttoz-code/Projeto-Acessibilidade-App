const ACTIVATE_COMMAND = "activate-assistant";
const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";

chrome.commands.onCommand.addListener((command) => {
  if (command !== ACTIVATE_COMMAND) {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (typeof activeTab?.id !== "number") {
      console.warn("[Assistente Acessível] Nenhuma aba ativa disponível.");
      return;
    }

    chrome.tabs.sendMessage(
      activeTab.id,
      { type: ACTIVATE_MESSAGE },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[Assistente Acessível] Não foi possível ativar nesta página:",
            chrome.runtime.lastError.message,
          );
        }
      },
    );
  });
});
