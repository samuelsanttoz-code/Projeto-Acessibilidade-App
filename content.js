(() => {
  const ACTIVATE_MESSAGE = "ACCESSIBLE_ASSISTANT_ACTIVATE";
  const assistantState = {
    isActive: false,
    activationCount: 0,
    lastActivatedAt: null,
  };

  globalThis.__accessibleWebAssistantState = assistantState;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== ACTIVATE_MESSAGE) {
      return false;
    }

    assistantState.isActive = true;
    assistantState.activationCount += 1;
    assistantState.lastActivatedAt = new Date().toISOString();

    console.info(
      "[Assistente Acessível] Assistente ativado.",
      { activationCount: assistantState.activationCount },
    );

    sendResponse({
      ok: true,
      activationCount: assistantState.activationCount,
    });

    return false;
  });
})();
