// Progressive enhancement only: navigation and all product facts work without JavaScript.
for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent;
    const status = button
      .closest(".install-code")
      ?.querySelector('[role="status"]');
    const chinese = document.documentElement.lang === "zh-CN";
    if (!text || !status) return;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = chinese
        ? "已复制安装命令。"
        : "Install commands copied.";
    } catch {
      status.textContent = chinese
        ? "请选中命令并手动复制。"
        : "Select the commands and copy them manually.";
    }
  });
}
for (const button of document.querySelectorAll("[data-demo]")) {
  const image = document.getElementById(button.dataset.demo);
  if (!image) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    const playing = button.getAttribute("aria-pressed") === "true";
    image.src = playing ? image.dataset.poster : image.dataset.animation;
    image.alt = playing ? image.dataset.posterAlt : image.dataset.animationAlt;
    button.setAttribute("aria-pressed", String(!playing));
    button.textContent = playing ? button.dataset.play : button.dataset.stop;
  });
}
