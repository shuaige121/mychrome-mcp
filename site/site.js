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

// Animated media gets a pause control. With reduced motion the still frame is shown instead.
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
for (const figure of document.querySelectorAll("[data-motion]")) {
  const image = figure.querySelector("img[data-still]");
  const toggle = figure.querySelector(".motion-toggle");
  if (!image || !toggle || reducedMotion) continue;
  const moving = image.getAttribute("src");
  const chinese = document.documentElement.lang === "zh-CN";
  const labels = chinese ? ["暂停动画", "播放动画"] : ["Pause animation", "Play animation"];
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    const paused = image.getAttribute("src") !== moving;
    image.setAttribute("src", paused ? moving : image.dataset.still);
    toggle.textContent = labels[paused ? 0 : 1];
  });
}
