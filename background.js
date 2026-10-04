const ACTIVATE_COMMAND = "activate-assistant";
const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
const INTRODUCED_KEY = "jarvisIntroduced";
let introductionReserved = false;

function claimIntroduction(callback) {
  if (introductionReserved) {
    callback(false);
    return;
  }

  introductionReserved = true;
  chrome.storage.session.get(INTRODUCED_KEY, (session) => {
    if (session[INTRODUCED_KEY]) {
      callback(false);
      return;
    }

    chrome.storage.session.set({ [INTRODUCED_KEY]: true }, () => {
      callback(true);
    });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== ACTIVATE_COMMAND) {
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    if (typeof activeTab?.id !== "number") {
      console.warn("[Assistente Acessível] Nenhuma aba ativa disponível.");
      return;
    }

    claimIntroduction((introduce) => {
      chrome.tabs.sendMessage(
        activeTab.id,
        { type: ACTIVATE_MESSAGE, introduce },
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
});
